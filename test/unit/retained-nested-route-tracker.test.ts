import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { retainLiveForegroundNestedRoute } from "../../src/integrations/pi-web-session-liveness.ts";
import { registerProgramStatusReporter } from "../../src/integrations/program-status.ts";
import { createRetainedNestedRouteTracker } from "../../src/runs/background/retained-nested-route-tracker.ts";
import { removeForegroundControlIfIdle } from "../../src/runs/foreground/subagent-executor.ts";
import { resultFilePath, writePendingAsyncResultFile } from "../../src/runs/background/result-files.ts";
import { createNestedRoute, hasLiveOwnedNestedWork, projectNestedEvents, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
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

	for (const reload of [true, false]) it(`retains independent work after detached foreground ${reload ? "reload" : "normal removal"}`, async () => {
		const nestedRoute = route("detached-reload");
		writeState(nestedRoute, "running", 100); // In-process child cannot survive the old runtime.
		const independent = { id: "independent", parentRunId: "nested-child", depth: 2,
			path: [{ runId: nestedRoute.rootRunId }, { runId: "nested-child" }], agent: "worker", state: "running" as const,
			asyncDir: path.join(TEMP_ROOT_DIR, "nested-subagent-runs", nestedRoute.rootRunId, "independent") };
		writeNestedEvent(nestedRoute, { type: "subagent.nested.started", ts: 101, parentRunId: independent.parentRunId, child: independent });
		const session = { manager: {}, id: "parent" };
		const control = { runId: nestedRoute.rootRunId, sessionId: session.id, mode: "single" as const, startedAt: 0, updatedAt: 0, nestedRoute };
		const state = { foregroundControls: new Map([[control.runId, control]]) } as SubagentState;
		const replacement = createRetainedNestedRouteTracker(state, { pollIntervalMs: 10 });
		try {
			if (reload) {
				const original = createRetainedNestedRouteTracker({});
				original.captureReloadRoutes(session, [control]);
				original.clear();
				replacement.restoreReloadRoutes(session);
			} else {
				assert.equal(removeForegroundControlIfIdle(state, control.runId, replacement.track), true);
				assert.equal(state.foregroundControls.size, 0);
			}
			assert.equal(state.retainedForegroundNestedRoutes?.size, 1);
			writeNestedEvent(nestedRoute, { type: "subagent.nested.completed", ts: 200, parentRunId: independent.parentRunId, child: { ...independent, state: "complete" } });
			await waitFor(() => !state.retainedForegroundNestedRoutes?.size);
		} finally {
			replacement.clear();
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
		const status = { runId: "nested-child", sessionId: "writer-session", mode: "single", state: "failed", startedAt: 100, lastUpdate: 200,
			steps: [{ agent: "worker", status: "failed" }] };
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ ...status, processTerminal: { ...proof, state: "pending" } }));
		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 10 });
		try {
			tracker.track(nestedRoute.rootRunId);
			await waitFor(() => projectNestedEvents(nestedRoute).children[0]?.state === "failed");
			assert.equal(state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId), true);
			const observed = { ...proof, state: "observed", observedAt: 300,
				instances: [{ kind: "runner", processInstanceId: "runner", closeObservedAt: 300, exitCode: 1, signal: null }] };
			const originalStat = fsDefault.statSync;
			let denied = false;
			fsDefault.statSync = ((file, options) => {
				if (String(file).includes(path.join("nested", nestedRoute.rootRunId, "result-pending"))) {
					denied = true;
					throw Object.assign(new Error("payload storage inaccessible"), { code: "EACCES" });
				}
				return originalStat(file, options);
			}) as typeof fs.statSync;
			syncBuiltinESMExports();
			try {
				fs.writeFileSync(path.join(asyncDir, "process-terminal.json"), JSON.stringify(observed));
				fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ ...status, processTerminal: observed }));
				await waitFor(() => denied);
				assert.equal(state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId), true);
			} finally {
				fsDefault.statSync = originalStat;
				syncBuiltinESMExports();
			}
			await waitFor(() => !state.retainedForegroundNestedRoutes?.size);
		} finally {
			tracker.clear();
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	for (const foreignSession of [false, true]) it(`does not reconcile nested status with the wrong ${foreignSession ? "session" : "run ID"}`, async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("mismatched-nested-root");
		const asyncRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", nestedRoute.rootRunId);
		const asyncDir = path.join(asyncRoot, "nested-child");
		const results = path.join(DIRS.results, "nested", nestedRoute.rootRunId);
		const foreignId = foreignSession ? "nested-child" : "other-child";
		const publicPath = resultFilePath(results, foreignId);
		const pendingDir = path.join(results, "result-pending", "session-a");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeNestedEvent(nestedRoute, {
			type: "subagent.nested.started", ts: 100, parentRunId: nestedRoute.rootRunId,
			child: { id: "nested-child", sessionId: "owner-session", parentRunId: nestedRoute.rootRunId, depth: 1, path: [{ runId: nestedRoute.rootRunId }], state: "running", agent: "worker", asyncDir },
		});
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);
		writePendingAsyncResultFile(publicPath, { id: foreignId, sessionId: "session-a", state: "complete", success: true, timestamp: Date.now() });
		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 10 });
		const writeStatus = (runId: string, sessionId: string) => fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId, sessionId, mode: "single", state: "failed", startedAt: 100, lastUpdate: 200 }));
		try {
			writeStatus(foreignId, "session-a");
			tracker.track(nestedRoute.rootRunId);
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(projectNestedEvents(nestedRoute).children[0]?.state, "running");
			assert.ok(fs.readdirSync(pendingDir).includes(`${foreignId}.json`));
			assert.equal(fs.existsSync(publicPath), false);
			writeStatus("nested-child", "owner-session");
			await waitFor(() => !state.retainedForegroundNestedRoutes?.size);
		} finally {
			tracker.clear();
			fs.rmSync(asyncRoot, { recursive: true, force: true });
			fs.rmSync(results, { recursive: true, force: true });
		}
	});

	it("repairs a retained child only from its own public result", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("nested-public-repair");
		const asyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", nestedRoute.rootRunId, "nested-child");
		const resultsDir = path.join(DIRS.results, "nested", nestedRoute.rootRunId);
		const resultPath = resultFilePath(resultsDir, "nested-child");
		const child = { id: "nested-child", parentRunId: nestedRoute.rootRunId, depth: 1, path: [{ runId: nestedRoute.rootRunId }], state: "running" as const, agent: "worker", asyncDir };
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: child.id, sessionId: "parent", mode: "single", state: "running", startedAt: 100 }));
		fs.writeFileSync(resultPath, JSON.stringify({ id: "different-child", sessionId: "parent", success: true }));
		writeNestedEvent(nestedRoute, { type: "subagent.nested.started", ts: 100, parentRunId: child.parentRunId, child });
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);
		const tracker = createRetainedNestedRouteTracker(state, { pollIntervalMs: 10 });
		try {
			tracker.track(nestedRoute.rootRunId);
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(projectNestedEvents(nestedRoute).children[0]?.state, "running");
			fs.writeFileSync(resultPath, JSON.stringify({ id: child.id, sessionId: "parent", success: true }));
			await waitFor(() => !state.retainedForegroundNestedRoutes?.size);
			assert.equal(projectNestedEvents(nestedRoute).children[0]?.state, "complete");
		} finally {
			tracker.clear();
			fs.rmSync(path.dirname(asyncDir), { recursive: true, force: true });
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("does not prune foreground descendants on a different runner's close proof", () => {
		const rootId = "stale-runner-root";
		const asyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootId, "child");
		const results = path.join(DIRS.results, "nested", rootId);
		const base = { id: "child", sessionId: "parent", parentRunId: rootId, depth: 1, path: [{ runId: rootId }], agent: "worker" };
		const children = [{ ...base, asyncDir, state: "failed" as const, children: [{ ...base, id: "in-process", parentRunId: "child", depth: 2, state: "running" as const }] }];
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(results, { recursive: true });
		try {
			fs.writeFileSync(resultFilePath(results, "child"), "{}");
			const status = { runId: "child", sessionId: "parent", mode: "single", state: "failed", startedAt: 100 };
			const pending = { version: 1, runId: "child", runnerProcessInstanceId: "current", state: "pending" };
			const writeStatus = (processTerminal: object) => fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ ...status, processTerminal }));
			writeStatus(pending);
			const writeProof = (id: string) => fs.writeFileSync(path.join(asyncDir, "process-terminal.json"), JSON.stringify({ version: 1, runId: "child", runnerProcessInstanceId: id, state: "observed", observedAt: 300,
				instances: [{ kind: "runner", processInstanceId: id, closeObservedAt: 300, exitCode: 1, signal: null }] }));
			writeProof("previous");
			assert.equal(hasLiveOwnedNestedWork(rootId, children), true);
			writeStatus({ ...pending, state: "observed", observedAt: 300, instances: [] });
			assert.equal(hasLiveOwnedNestedWork(rootId, children), true, "malformed observation cannot release the hold");
			writeProof("current");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ ...status, sessionId: "other", processTerminal: pending }));
			assert.equal(hasLiveOwnedNestedWork(rootId, children), true, "foreign-session status cannot prove closure");
			writeStatus(pending);
			assert.equal(hasLiveOwnedNestedWork(rootId, children), false);
			const independent = { ...base, id: "independent", parentRunId: "child", depth: 2, state: "running" as const,
				asyncDir: path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootId, "independent") };
			const statuslessChildren = [{ ...children[0]!, processTerminal: { ...pending, version: 1 as const, state: "pending" as const },
				children: [...children[0]!.children, independent] }];
			fs.rmSync(path.join(asyncDir, "status.json"));
			writeProof("previous");
			assert.equal(hasLiveOwnedNestedWork(rootId, children), true);
			assert.equal(hasLiveOwnedNestedWork(rootId, [{ ...statuslessChildren[0]!, children: children[0]!.children }]), true,
				"statusless projection must reject another writer's sidecar");
			writeProof("current");
			assert.equal(hasLiveOwnedNestedWork(rootId, statuslessChildren), true, "independent work survives matching close");
			assert.equal(hasLiveOwnedNestedWork(rootId, [{ ...statuslessChildren[0]!, children: [...children[0]!.children, { ...independent, state: "complete" }] }]), false);
		} finally {
			fs.rmSync(path.dirname(asyncDir), { recursive: true, force: true });
			fs.rmSync(results, { recursive: true, force: true });
		}
	});

	it("drains a statusless nested writer from its persisted event and matching sidecar", async () => {
		const nestedRoute = route("statusless-nested-projection");
		const rootId = nestedRoute.rootRunId;
		const asyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootId, "writer");
		const address = { parentRunId: "writer", depth: 2, path: [{ runId: rootId }, { runId: "writer" }], agent: "worker" };
		const independent = { ...address, id: "independent", state: "running" as const,
			asyncDir: path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootId, "independent") };
		const writerProof = { version: 1 as const, runId: "writer", runnerProcessInstanceId: "current", state: "pending" as const };
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const tracker = createRetainedNestedRouteTracker(state, { pollIntervalMs: 10 });
		fs.mkdirSync(asyncDir, { recursive: true });
		const writeClose = (id: string) => fs.writeFileSync(path.join(asyncDir, "process-terminal.json"), JSON.stringify({ ...writerProof,
			runnerProcessInstanceId: id, state: "observed", observedAt: 300,
			instances: [{ kind: "runner", processInstanceId: id, closeObservedAt: 300, exitCode: 0, signal: null }] }));
		try {
			const statusPath = path.join(asyncDir, "status.json");
			fs.writeFileSync(statusPath, JSON.stringify({ runId: "writer", sessionId: "parent", mode: "single", state: "failed", startedAt: 100, processTerminal: writerProof }));
			writeNestedEvent(nestedRoute, { type: "subagent.nested.completed", ts: 200, parentRunId: rootId,
				child: { id: "writer", parentRunId: rootId, sessionId: "parent", depth: 1, path: [{ runId: rootId }], state: "failed", asyncDir, processTerminal: writerProof } });
			writeNestedEvent(nestedRoute, { type: "subagent.nested.started", ts: 201, parentRunId: "writer", child: { ...address, id: "stranded", state: "running" } });
			fs.rmSync(statusPath);
			writeClose("stale");
			assert.equal(projectNestedEvents(nestedRoute).children[0]?.processTerminal?.runnerProcessInstanceId, "current");
			assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);
			tracker.track(rootId);
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(state.retainedForegroundNestedRoutes?.size, 1, "stale close leaves the foreground hold intact");
			writeNestedEvent(nestedRoute, { type: "subagent.nested.started", ts: 202, parentRunId: "writer", child: independent });
			writeClose("current");
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(state.retainedForegroundNestedRoutes?.size, 1, "matching close does not hide independent work");
			writeNestedEvent(nestedRoute, { type: "subagent.nested.completed", ts: 302, parentRunId: "writer", child: { ...independent, state: "complete" } });
			await waitFor(() => !state.retainedForegroundNestedRoutes?.size);
		} finally {
			tracker.clear();
			fs.rmSync(path.dirname(asyncDir), { recursive: true, force: true });
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
