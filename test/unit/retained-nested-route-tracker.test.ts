import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { retainLiveForegroundNestedRoute } from "../../src/integrations/pi-web-session-liveness.ts";
import { registerProgramStatusReporter } from "../../src/integrations/program-status.ts";
import { createRetainedNestedRouteTracker } from "../../src/runs/background/retained-nested-route-tracker.ts";
import { resultFilePath, writePendingAsyncResultFile } from "../../src/runs/background/result-files.ts";
import { createNestedRoute, projectNestedEvents, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { DIRS, TEMP_ROOT_DIR, type SubagentState } from "../../src/shared/types.ts";

const routeRoots: string[] = [];

class Watcher extends EventEmitter implements fs.FSWatcher {
	close() { this.emit("close"); }
	ref() { return this; }
	unref() { return this; }
}

function route(rootRunId: string) {
	const value = createNestedRoute(rootRunId);
	routeRoots.push(path.dirname(value.eventSink));
	return value;
}

function writeState(value: ReturnType<typeof route>, state: "running" | "complete", ts: number): void {
	writeNestedEvent(value, {
		type: state === "running" ? "subagent.nested.updated" : "subagent.nested.completed",
		ts,
		parentRunId: value.rootRunId,
		child: {
			id: "nested-child",
			parentRunId: value.rootRunId,
			depth: 1,
			path: [{ runId: value.rootRunId }],
			state,
			agent: "worker",
			lastUpdate: ts,
		},
	});
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(check(), true, "condition did not become true before timeout");
}

afterEach(() => {
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("retained foreground nested route tracker", () => {
	it("holds TUI terminal status across reload until the retained descendant completes without Pi Web", async () => {
		let state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("retained-root");
		writeState(nestedRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);

		const holds: boolean[] = [];
		const reporter = registerProgramStatusReporter({
			enabled: true, getJobs: () => [], getPendingRequests: () => [],
			hasBackgroundWork: () => Boolean(state.retainedForegroundNestedRoutes?.size),
			isTTY: true, env: { TERM: "xterm-256color" },
		});
		assert.equal(reporter.sessionStarted({ hasUI: true, mode: "tui", setBackgroundWork: (_key, active) => holds.push(active) }), true);
		let tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 10, onRoutesChanged: reporter.sync });
		try {
			tracker.track(nestedRoute.rootRunId);
			assert.deepEqual(holds, [true]);
			const session = { manager: {}, id: "parent" };
			tracker.captureReloadRoutes(session);
			reporter.dispose("reload");
			tracker.clear();
			state = {};
			holds.length = 0;
			tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 10, onRoutesChanged: reporter.sync });
			tracker.restoreReloadRoutes(session);
			reporter.sessionStarted({ hasUI: true, mode: "tui", setBackgroundWork: (_key, active) => holds.push(active) });
			assert.deepEqual(holds, [true]);
			writeState(nestedRoute, "complete", 200);
			await waitFor(() => holds.length === 2);
			assert.deepEqual(holds, [true, false]);
		} finally {
			tracker.clear();
			reporter.dispose();
		}
	});

	it("retains a repaired terminal child until its exact writer closes", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("missing-terminal-event-root");
		const asyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", nestedRoute.rootRunId, "nested-child");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeNestedEvent(nestedRoute, {
			type: "subagent.nested.updated", ts: 100, parentRunId: nestedRoute.rootRunId,
			child: { id: "nested-child", parentRunId: nestedRoute.rootRunId, depth: 1,
				path: [{ runId: nestedRoute.rootRunId }], state: "running", agent: "worker", asyncDir },
		});
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);
		const proof = { version: 1, runId: "nested-child", runnerProcessInstanceId: "runner" };
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId: "nested-child", mode: "single", state: "failed", startedAt: 100, lastUpdate: 200,
			steps: [{ agent: "worker", status: "failed" }], processTerminal: { ...proof, state: "pending" },
		}));
		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 10 });
		try {
			tracker.track(nestedRoute.rootRunId);
			await waitFor(() => projectNestedEvents(nestedRoute).children[0]?.state === "failed");
			assert.equal(state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId), true);
			fs.writeFileSync(path.join(asyncDir, "process-terminal.json"), JSON.stringify({ ...proof, state: "observed", observedAt: 300,
				instances: [{ kind: "runner", processInstanceId: "runner", closeObservedAt: 300, exitCode: 1, signal: null }] }));
			await waitFor(() => !state.retainedForegroundNestedRoutes?.size);
		} finally {
			tracker.clear();
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("does not promote another child's result when nested status claims the wrong ID", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("mismatched-nested-root");
		const asyncRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", nestedRoute.rootRunId);
		const asyncDir = path.join(asyncRoot, "nested-child");
		const results = path.join(DIRS.results, "nested", nestedRoute.rootRunId);
		const publicPath = resultFilePath(results, "other-child");
		const pendingDir = path.join(results, "result-pending", "session-a");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeNestedEvent(nestedRoute, {
			type: "subagent.nested.started", ts: 100, parentRunId: nestedRoute.rootRunId,
			child: { id: "nested-child", parentRunId: nestedRoute.rootRunId, depth: 1, path: [{ runId: nestedRoute.rootRunId }], state: "running", agent: "worker", asyncDir },
		});
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);
		writePendingAsyncResultFile(publicPath, { id: "other-child", sessionId: "session-a", state: "complete", success: true, timestamp: Date.now() });
		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 10 });
		const writeStatus = (runId: string) => fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId, sessionId: "session-a", mode: "single", state: "failed", startedAt: 100, lastUpdate: 200 }));
		try {
			writeStatus("other-child");
			tracker.track(nestedRoute.rootRunId);
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(projectNestedEvents(nestedRoute).children[0]?.state, "running");
			assert.ok(fs.readdirSync(pendingDir).includes("other-child.json"));
			assert.equal(fs.existsSync(publicPath), false);
			writeStatus("nested-child");
			await waitFor(() => !state.retainedForegroundNestedRoutes?.size);
		} finally {
			tracker.clear();
			fs.rmSync(asyncRoot, { recursive: true, force: true });
			fs.rmSync(results, { recursive: true, force: true });
		}
	});

	it("ignores stranded foreground work only after its runner exits, keeping independent async work", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("foreground-owner-exit-root");
		const ownerId = "async-owner";
		const asyncRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", nestedRoute.rootRunId);
		const owner = { id: ownerId, parentRunId: nestedRoute.rootRunId, depth: 1,
			path: [{ runId: nestedRoute.rootRunId }], asyncDir: path.join(asyncRoot, ownerId), agent: "owner" };
		const foreground = { id: "in-process", parentRunId: ownerId, depth: 2,
			path: [...owner.path, { runId: ownerId }], state: "running" as const, agent: "foreground" };
		const independent = { ...foreground, id: "independent", parentRunId: foreground.id, depth: 3,
			path: [...foreground.path, { runId: foreground.id }], asyncDir: path.join(asyncRoot, "independent") };
		writeNestedEvent(nestedRoute, { type: "subagent.nested.completed", ts: 200, parentRunId: owner.parentRunId, child: { ...owner, state: "failed" } });
		writeNestedEvent(nestedRoute, { type: "subagent.nested.started", ts: 201, parentRunId: foreground.parentRunId, child: foreground });
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);
		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 10 });
		try {
			tracker.track(nestedRoute.rootRunId);
			await new Promise((resolve) => setTimeout(resolve, 35));
			assert.equal(state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId), true, "foreground work stays live without close proof");
			writeNestedEvent(nestedRoute, { type: "subagent.nested.started", ts: 202, parentRunId: independent.parentRunId, child: independent });
			fs.mkdirSync(owner.asyncDir, { recursive: true });
			fs.writeFileSync(path.join(owner.asyncDir, "process-terminal.json"), JSON.stringify({
				version: 1, state: "observed", runId: ownerId, runnerProcessInstanceId: "runner", observedAt: 300,
				instances: [{ kind: "runner", processInstanceId: "runner", closeObservedAt: 300, exitCode: 1, signal: null }],
			}));
			await new Promise((resolve) => setTimeout(resolve, 35));
			assert.equal(state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId), true);
			writeNestedEvent(nestedRoute, { type: "subagent.nested.completed", ts: 400, parentRunId: independent.parentRunId, child: { ...independent, state: "complete" } });
			await waitFor(() => !state.retainedForegroundNestedRoutes?.size);
		} finally {
			tracker.clear();
			fs.rmSync(asyncRoot, { recursive: true, force: true });
		}
	});

	it("keeps the route through the handoff race until the first tracker refresh", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("handoff-root");
		writeState(nestedRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);
		writeState(nestedRoute, "complete", 200);

		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 60_000 });
		try {
			tracker.track(nestedRoute.rootRunId);
			assert.equal(state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId), true);
			await waitFor(() => !state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId));
		} finally {
			tracker.clear();
		}
	});

	it("keeps polling after a native watcher error", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("watch-error-root");
		writeState(nestedRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);

		const watcher = new Watcher();
		const tracker = createRetainedNestedRouteTracker(state, {
			platform: "linux",
			pollIntervalMs: 10,
			watch: () => watcher,
		});
		try {
			tracker.track(nestedRoute.rootRunId);
			watcher.emit("error", new Error("watch failed"));
			writeState(nestedRoute, "complete", 200);
			await waitFor(() => !state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId));
		} finally {
			tracker.clear();
		}
	});

	it("refreshes every retained route instead of stopping at the first live one", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const liveRoute = route("multi-live-root");
		const terminalRoute = route("multi-terminal-root");
		writeState(liveRoute, "running", 100);
		writeState(terminalRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, liveRoute), true);
		assert.equal(retainLiveForegroundNestedRoute(state, terminalRoute), true);

		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 10 });
		try {
			tracker.track(liveRoute.rootRunId);
			tracker.track(terminalRoute.rootRunId);
			writeState(terminalRoute, "complete", 200);
			await waitFor(() => !state.retainedForegroundNestedRoutes?.has(terminalRoute.rootRunId));
			assert.equal(state.retainedForegroundNestedRoutes?.has(liveRoute.rootRunId), true);
		} finally {
			tracker.clear();
		}
	});

	it("refreshes promptly from native watch events", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("watched-root");
		writeState(nestedRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);

		let notify: (() => void) | undefined;
		let closed = 0;
		const watcher = new Watcher();
		watcher.on("close", () => { closed += 1; });
		const tracker = createRetainedNestedRouteTracker(state, {
			platform: "linux",
			pollIntervalMs: 60_000,
			// SAFETY: the tracker uses only fs.watch(path, listener), not the options overloads.
			watch: ((_path: fs.PathLike, listener: fs.WatchListener<string>) => {
				notify = () => listener("rename", "event.json");
				return watcher;
			}) as typeof fs.watch,
		});
		try {
			tracker.track(nestedRoute.rootRunId);
			t.mock.timers.tick(25);
			assert.equal(state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId), true);
			writeState(nestedRoute, "complete", 200);
			notify?.();
			t.mock.timers.tick(25);
			assert.equal(state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId), false);
			assert.equal(closed, 1);
		} finally {
			tracker.clear();
		}
	});

	it("clears every retained route during session teardown", () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("cleared-root");
		writeState(nestedRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);

		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 60_000 });
		tracker.track(nestedRoute.rootRunId);
		tracker.clear();

		assert.equal(state.retainedForegroundNestedRoutes?.size, 0);
	});
});
