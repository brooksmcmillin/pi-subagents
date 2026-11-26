import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "../../src/extension/index.ts";
import { PI_WEB_SESSION_LIVENESS_REGISTRY_KEY } from "../../src/integrations/pi-web-session-liveness.ts";
import { currentCompletionOwnerId } from "../../src/shared/completion-owner.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

// One child that ends before its result is published, whose first completion
// send is rejected, and whose accepted wake is started by the parent later.
const terminalBeforePublicationScript = String.raw`
	import assert from "node:assert/strict";
	import fsDefault, * as fs from "node:fs";
	import { syncBuiltinESMExports } from "node:module";
	import * as path from "node:path";
	import { createEventBus } from "@earendil-works/pi-coding-agent";
	import registerSubagentExtension from "./src/extension/index.ts";
	import { currentCompletionOwnerId } from "./src/shared/completion-owner.ts";
	import { recordSessionReplacement } from "./src/shared/session-succession.ts";
	import { DIRS, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_PROCESS_TERMINAL_EVENT, TEMP_ROOT_DIR } from "./src/shared/types.ts";
	import { writeAtomicJson } from "./src/shared/atomic-json.ts";
	import { resultFilePath, writeAsyncResultFile, writePendingAsyncResultFile } from "./src/runs/background/result-files.ts";
	import { ACTIVE_RUN_INDEX_DIR, readActiveRunIndex, updateActiveRunIndex } from "./src/runs/background/active-run-index.ts";
	import { createNestedRoute, projectNestedEvents, writeNestedEvent } from "./src/runs/shared/nested-events.ts";
	import { reconcileNestedAsyncDescendants } from "./src/runs/background/stale-run-reconciler.ts";
	import { listAsyncRuns } from "./src/runs/background/async-status.ts";

	// Use the event-driven tracker and run its short debounce timers as microtasks,
	// so a terminal status is observed before the result file exists.
	Object.defineProperty(process, "platform", { value: "linux" });
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const fakeTimers = new WeakSet();
	globalThis.setTimeout = ((handler, delay, ...args) => {
		if ((delay === 0 || delay === 25) && (new Error().stack ?? "").includes("/src/runs/background/async-job-tracker.ts")) {
			const timer = { active: true, unref() {} };
			fakeTimers.add(timer);
			queueMicrotask(() => { if (timer.active) { timer.active = false; handler(...args); } });
			return timer;
		}
		return originalSetTimeout(handler, delay, ...args);
	});
	globalThis.clearTimeout = ((timer) => {
		if (timer && typeof timer === "object" && fakeTimers.has(timer)) timer.active = false;
		else originalClearTimeout(timer);
	});

	const configDir = path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ completionBatch: { enabled: false } }));
	const sessionId = "11111111-1111-4111-8111-111111111111";
	const completionOwnerId = currentCompletionOwnerId();
	const runId = "liveness-child";
	const handlers = new Map();
	const events = createEventBus();
	let rejectNextSend = true;
	let onSend;
	const pi = new Proxy({
		events,
		on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, getSessionName() {},
		sendMessage(message, options) {
			if (message.customType !== "subagent-notify") return;
			const rejected = rejectNextSend;
			rejectNextSend = false;
			onSend?.({ message, options, rejected });
			if (rejected) throw new Error("synthetic completion send rejection");
		},
	}, { get(target, property) { return property in target ? target[property] : () => undefined; } });
	let provider;
	globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")] = {
		version: 1,
		register(value) { provider = value; return () => {}; },
	};
	const workflowReload = process.argv[1] === "workflow-reload";
	const publishedReload = process.argv[1] === "published-reload";
	const repeatReload = process.argv[1] === "repeat-reload" || workflowReload || publishedReload;
	const provisionalReload = process.argv[1] === "provisional-reload";
	const mismatchedRunningMarker = process.argv[1] === "mismatched-running-marker";
	const mismatchedMarker = process.argv[1] === "mismatched-marker" || mismatchedRunningMarker;
	const inheritedPublication = process.argv[1] === "inherited-publication";
	const runSessionId = inheritedPublication ? "22222222-2222-4222-8222-222222222222" : sessionId;
	if (inheritedPublication) recordSessionReplacement(sessionId, runSessionId);
	const denyFirstRefresh = process.argv[1] === "restore-retry" || provisionalReload;
	const restoredCase = process.argv[1] === "restored" || process.argv[1] === "repeat-reload" || denyFirstRefresh || mismatchedMarker || inheritedPublication;
	const closedFirst = process.argv[1] === "closed-first";
	const closedCase = process.argv[1] === "closed" || restoredCase || repeatReload || closedFirst;
	const pendingCase = process.argv[1] === "pending";
	const tui = closedCase || pendingCase;
	const holds = [];
	const reports = [];
	if (tui) {
		process.env.TERM = "xterm-256color";
		process.env.PI_PROGRAM_STATUS = "1";
		Object.defineProperty(process.stdout, "isTTY", { value: true });
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk, ...args) => typeof chunk === "string" && chunk.startsWith("\x1b]7501;") ? (reports.push(chunk), true) : write(chunk, ...args);
	}
	const ctx = {
		cwd: process.cwd(), hasUI: tui, mode: tui ? "tui" : undefined, model: undefined, isIdle() { return false; },
		ui: { setBackgroundWork(_key, active) { holds.push(active); }, notify() {}, setWidget() {}, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
		sessionManager: { getSessionId() { return sessionId; }, getSessionFile() { return null; }, getEntries() { return []; } },
		modelRegistry: { getAvailable() { return []; } },
	};
	const nextSend = () => new Promise((resolve, reject) => {
		const timer = originalSetTimeout(() => reject(new Error("Timed out waiting for a completion send")), 10_000);
		onSend = (send) => { originalClearTimeout(timer); onSend = undefined; resolve(send); };
	});
	const exitProof = () => ({ version: 1, runId, runnerProcessInstanceId: runId + "-runner", state: "observed", observedAt: Date.now(),
		instances: [{ kind: "runner", processInstanceId: runId + "-runner", closeObservedAt: Date.now(), exitCode: 0, signal: null }] });
	const writeStatus = (state, proof, markerState = state) => {
		const asyncDir = path.join(DIRS.async, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		writeAtomicJson(path.join(asyncDir, "status.json"), {
			runId: mismatchedMarker ? "different-run" : runId, sessionId: runSessionId, completionOwnerId, mode: workflowReload ? "workflow" : "single", state,
			startedAt: Date.now(), lastUpdate: Date.now(), cwd: process.cwd(), pid: process.pid,
			steps: [{ agent: "worker", status: state, index: 0 }],
			...(state === "running" ? {} : { processTerminal: proof ?? { version: 1, runId, runnerProcessInstanceId: runId + "-runner", state: "pending" } }),
		});
		updateActiveRunIndex(asyncDir, markerState);
		return asyncDir;
	};
	const publishResult = (pending = false) => (pending ? writePendingAsyncResultFile : writeAsyncResultFile)(resultFilePath(DIRS.results, runId), {
		id: runId, runId, agent: "worker", mode: "single", state: "complete", success: true, exitCode: 0,
		summary: "child complete", timestamp: Date.now(), sessionId, completionOwnerId,
	});

	registerSubagentExtension(pi);
	let asyncDir;
	if (restoredCase) {
		const observed = provisionalReload ? exitProof() : undefined;
		asyncDir = writeStatus(mismatchedRunningMarker ? "running" : "complete", observed, "running");
		if (observed) writeAtomicJson(path.join(asyncDir, "process-terminal.json"), observed);
	}
	const unrelatedRoute = mismatchedMarker ? createNestedRoute("different-run") : undefined;
	if (unrelatedRoute) {
		const childDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", unrelatedRoute.rootRunId, "nested-child");
		fs.mkdirSync(childDir, { recursive: true });
		writeNestedEvent(unrelatedRoute, { type: "subagent.nested.started", ts: 100, parentRunId: "different-run",
			child: { id: "nested-child", parentRunId: "different-run", depth: 1, path: [{ runId: "different-run" }], agent: "worker", state: "running", asyncDir: childDir } });
		writeAtomicJson(path.join(childDir, "status.json"), { runId: "nested-child", mode: "single", state: "failed", startedAt: 100, lastUpdate: 200,
			steps: [{ agent: "worker", status: "failed" }] });
		const resultsDir = path.join(TEMP_ROOT_DIR, "mismatch-results");
		const publicPath = resultFilePath(resultsDir, unrelatedRoute.rootRunId);
		writePendingAsyncResultFile(publicPath, { id: unrelatedRoute.rootRunId, sessionId, completionOwnerId, state: "complete", success: true, timestamp: Date.now() });
		const pendingDir = path.join(resultsDir, "result-pending", sessionId);
		assert.ok(fs.readdirSync(pendingDir).includes("different-run.json"));
		listAsyncRuns(DIRS.async, { states: ["queued", "running"], includeTerminalPublication: true, sessionId, resultsDir });
		assert.ok(fs.readdirSync(pendingDir).includes("different-run.json"), "unrelated payload stays pending during listing");
		assert.equal(fs.existsSync(publicPath), false);
	}
	const restoreStat = fsDefault.statSync;
	let restoredRefreshDenied = false;
	if (denyFirstRefresh) {
		fsDefault.statSync = (file, ...args) => {
			if ((provisionalReload || !restoredRefreshDenied) && String(file) === path.join(asyncDir, "status.json")
				&& new Error().stack.includes("at refreshJob")) {
				restoredRefreshDenied = true;
				throw Object.assign(new Error("first terminal refresh inaccessible"), { code: "EACCES" });
			}
			return restoreStat(file, ...args);
		};
		syncBuiltinESMExports();
	}
	try {
		for (const handler of handlers.get("session_start")) await handler({ reason: restoredCase ? "reload" : "startup" }, ctx);
		if (denyFirstRefresh) assert.equal(restoredRefreshDenied, true);
		if (provisionalReload) {
			assert.equal(readActiveRunIndex(DIRS.async).includes(runId), false);
			assert.deepEqual(holds, [true]);
			for (const handler of handlers.get("session_shutdown")) await handler({ reason: "reload" }, ctx);
			handlers.clear();
			holds.length = 0;
			restoredRefreshDenied = false;
			registerSubagentExtension(pi);
			for (const handler of handlers.get("session_start")) await handler({ reason: "reload" }, ctx);
			assert.equal(restoredRefreshDenied, true, "second runtime probed the exact markerless status");
			assert.deepEqual(holds, [true]);
		}
	} finally {
		if (denyFirstRefresh) {
			fsDefault.statSync = restoreStat;
			syncBuiltinESMExports();
		}
	}
	if (mismatchedMarker) {
		assert.equal(readActiveRunIndex(DIRS.async).includes(runId), true, "the directory was discovered via its active marker");
		assert.equal(provider.isActive(), false);
		assert.deepEqual(holds, []);
		assert.equal(reports.some(report => report.includes("differentrun")), false);
		assert.equal(projectNestedEvents(unrelatedRoute).children[0]?.state, "running", "unrelated route did not receive a repaired terminal event");
		reconcileNestedAsyncDescendants(unrelatedRoute);
		assert.equal(projectNestedEvents(unrelatedRoute).children[0]?.state, "failed", "the fixture would have been repaired if visited");
		for (const handler of handlers.get("session_shutdown")) await handler({ reason: "quit" }, ctx);
		process.stdout.write("ok");
		process.exit(0);
	}
	if (restoredCase) {
		assert.equal(fs.existsSync(resultFilePath(DIRS.results, runId)), false);
		assert.deepEqual(holds, [true]);
	} else {
		assert.equal(provider.isActive(), false);
		asyncDir = writeStatus("running");
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: runId, sessionId, completionOwnerId, mode: "single", agent: "worker", asyncDir });
	}
	assert.equal(provider.isActive(), true);
	if (provisionalReload) {
		for (let i = 0; i < 130 && provider.isActive(); i++) await new Promise(resolve => originalSetTimeout(resolve, 50));
		assert.equal(provider.isActive(), false);
		assert.deepEqual(holds, [true, false]);
		for (const handler of handlers.get("session_shutdown")) await handler({ reason: "quit" }, ctx);
		process.stdout.write("ok");
		process.exit(0);
	}
	if (repeatReload) {
		const proof = exitProof();
		const stat = fsDefault.statSync;
		const readdir = fsDefault.readdirSync;
		let listingDenied = false;
		let denyListing = false;
		let denyStatus = false;
		let statusDenied = false;
		fsDefault.readdirSync = (dir, ...args) => {
			if (denyListing && String(dir) === path.join(DIRS.async, ACTIVE_RUN_INDEX_DIR)) {
				listingDenied = true;
				throw Object.assign(new Error("active listing inaccessible"), { code: "EACCES" });
			}
			return readdir(dir, ...args);
		};
		let denyResult = !publishedReload;
		fsDefault.statSync = (file, ...args) => {
			if (denyStatus && String(file) === path.join(asyncDir, "status.json")) {
				statusDenied = true;
				throw Object.assign(new Error("temporarily inaccessible status"), { code: "EACCES" });
			}
			if (denyResult && (String(file).includes("result-pending") || (publishedReload && String(file) === resultFilePath(DIRS.results, runId)))) {
				throw Object.assign(new Error("temporarily inaccessible"), { code: "EACCES" });
			}
			return stat(file, ...args);
		};
		syncBuiltinESMExports();
		try {
			writeAtomicJson(path.join(asyncDir, "process-terminal.json"), proof);
			writeStatus("complete", proof);
			if (publishedReload) publishResult();
			if (workflowReload || publishedReload) events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: runId, runId, sessionId, completionOwnerId, state: "complete", success: true, triggerTurn: false });
			denyResult = true;
			assert.equal(readActiveRunIndex(DIRS.async)?.includes(runId), false);
			for (let i = 0; i < 2; i++) {
				for (const handler of handlers.get("session_shutdown")) await handler({ reason: "reload" }, ctx);
				handlers.clear();
				holds.length = 0;
				denyStatus = i === 0 && !workflowReload && !publishedReload;
				denyListing = i === 0 && publishedReload;
				registerSubagentExtension(pi);
				for (const handler of handlers.get("session_start")) await handler({ reason: "reload" }, ctx);
				if (denyStatus) assert.equal(statusDenied, true);
				if (denyListing) assert.equal(listingDenied, true);
				assert.deepEqual(holds, [true]);
				assert.equal(provider.isActive(), true);
			}
		} finally {
			fsDefault.statSync = stat;
			fsDefault.readdirSync = readdir;
			syncBuiltinESMExports();
		}
		if (publishedReload) {
			ctx.isIdle = () => true;
			rejectNextSend = false;
			const sent = nextSend();
			publishResult();
			const accepted = await sent;
			assert.equal(accepted.rejected, false);
			assert.equal(provider.isActive(), true);
			assert.deepEqual(holds, [true]);
			for (const handler of handlers.get("agent_start")) handler({}, ctx);
			for (const handler of handlers.get("message_start")) handler({ message: { role: "custom", ...accepted.message } });
			for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
		}
		for (let i = 0; i < 130 && provider.isActive(); i++) await new Promise(resolve => originalSetTimeout(resolve, 50));
		assert.equal(provider.isActive(), false);
		assert.deepEqual(holds, [true, false]);
		for (const handler of handlers.get("session_shutdown")) await handler({ reason: "quit" }, ctx);
		process.stdout.write("ok");
		process.exit(0);
	}

	let send;
	if (process.argv[1] === "event" || pendingCase) {
		// Detached-workflow reconciliation publishes the result and emits the
		// completion event before the status watcher sees the terminal state.
		writeStatus("complete");
		publishResult(pendingCase);
		if (pendingCase) assert.equal(fs.existsSync(resultFilePath(DIRS.results, runId)), false);
		send = nextSend();
		const stat = fsDefault.statSync;
		let pendingProbeDenied = false;
		let trackerRetryDenied = false;
		if (pendingCase) {
			fsDefault.statSync = (file, ...args) => {
				if (String(file).includes("result-pending")) {
					pendingProbeDenied = true;
					if ((new Error().stack ?? "").includes("/src/runs/background/async-job-tracker.ts")) trackerRetryDenied = true;
					throw Object.assign(new Error("temporarily inaccessible"), { code: "EACCES" });
				}
				return stat(file, ...args);
			};
			syncBuiltinESMExports();
		}
		try {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: runId, runId, sessionId, completionOwnerId, state: "complete", success: true, summary: "child complete" });
			if (pendingCase) {
				assert.equal(pendingProbeDenied, true);
				for (let i = 0; i < 130 && !trackerRetryDenied; i++) await new Promise(resolve => originalSetTimeout(resolve, 50));
				assert.equal(trackerRetryDenied, true, "terminal tracker retried before storage became readable");
				assert.deepEqual(holds, [true]);
				assert.equal(reports.some(report => /state=(done|error):/.test(report)), false);
			}
		} finally {
			if (pendingCase) {
				fsDefault.statSync = stat;
				syncBuiltinESMExports();
			}
		}
		assert.equal((await send).rejected, true);
		assert.equal(provider.isActive(), true, "a completion event with a rejected send keeps the result owed");
	} else {
		// Wait for the directory event the tracker reacts to (an atomic write can be
		// reported under its temp name). If a loaded runner drops it, the tracker's
		// 5 s liveness poll still sees the terminal status within this bound.
		const observed = new Promise((resolve) => {
			const timer = originalSetTimeout(() => { watcher.close(); resolve(); }, 6_000);
			const watcher = fs.watch(asyncDir, () => { originalClearTimeout(timer); watcher.close(); resolve(); });
		});
		const proof = exitProof();
		if (closedFirst) writeAtomicJson(path.join(asyncDir, "process-terminal.json"), proof);
		writeStatus("complete", closedFirst ? proof : undefined);
		events.emit(SUBAGENT_PROCESS_TERMINAL_EVENT, closedFirst ? proof : { version: 1, runId, runnerProcessInstanceId: runId + "-runner", state: "pending" });
		await observed;
		await new Promise((resolve) => originalSetTimeout(resolve, 50));
		assert.equal(fs.existsSync(resultFilePath(DIRS.results, runId)), false);
		if (!closedFirst) assert.equal(provider.isActive(), true, "an ended child stays live until its result is published");

		if (closedCase) {
			if (!closedFirst) {
				assert.deepEqual(holds, [true]);
				assert.equal(reports.some(report => /state=(done|error):/.test(report)), false);
				const stat = fsDefault.statSync;
				let denied = false;
				fsDefault.statSync = (file, ...args) => {
					if (String(file).includes("result-pending")) {
						denied = true;
						throw Object.assign(new Error("temporarily inaccessible"), { code: "EACCES" });
					}
					return stat(file, ...args);
				};
				syncBuiltinESMExports();
				try {
					writeAtomicJson(path.join(asyncDir, "process-terminal.json"), proof);
					events.emit(SUBAGENT_PROCESS_TERMINAL_EVENT, proof);
					for (let i = 0; i < 130 && !denied; i++) await new Promise(resolve => originalSetTimeout(resolve, 50));
					assert.equal(denied, true);
					assert.deepEqual(holds, [true]);
				} finally {
					fsDefault.statSync = stat;
					syncBuiltinESMExports();
				}
				events.emit(SUBAGENT_PROCESS_TERMINAL_EVENT, proof);
			}
			for (let i = 0; i < 130 && holds.at(-1) === true; i++) await new Promise(resolve => originalSetTimeout(resolve, 50));
			assert.deepEqual(holds, [true, false]);
			assert.equal(reports.some(report => /state=done:/.test(report)), true);
			assert.equal(provider.isActive(), false);
			assert.equal(fs.existsSync(resultFilePath(DIRS.results, runId)), false);
			for (const handler of handlers.get("session_shutdown")) await handler({ reason: "quit" }, ctx);
			process.stdout.write("ok");
			process.exit(0);
		}
		send = nextSend();
		publishResult();
		assert.equal((await send).rejected, true);
		assert.equal(provider.isActive(), true, "a rejected completion send keeps the result owed");
	}

	send = nextSend();
	publishResult();
	const accepted = await send;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(provider.isActive(), true, "an accepted wake stays live until Pi starts it");
	for (const handler of handlers.get("message_start")) handler({ message: { role: "custom", ...accepted.message } });
	assert.equal(provider.isActive(), false, "the started wake hands the result to the parent");

	for (const handler of handlers.get("session_shutdown")) await handler({ reason: "quit" }, ctx);
	process.stdout.write("ok");
`;

describe("session liveness through result delivery", () => {
	for (const [mode, title] of [
		["status", "stays live from a child's terminal status through a rejected send until its wake starts"],
		["event", "stays live when a completion event ends the job before its status refresh and the send is rejected"],
		["pending", "holds detached terminal status while a pending-only result is temporarily inaccessible"],
		["closed", "releases a closed writer hold only after pending storage can confirm absence"],
		["closed-first", "does not strand a hold when the first terminal observation already proves writer closure"],
		["restored", "reload restores a terminal publication hold before its publisher has written any result"],
		["restore-retry", "reload retains a terminal publication hold after the first tracker refresh fails"],
		["provisional-reload", "second reload preserves a markerless terminal publication after first-refresh denial"],
		["inherited-publication", "same-process session successor keeps an inherited terminal publication held"],
		["mismatched-marker", "does not restore terminal status claiming a run ID different from the active marker"],
		["mismatched-running-marker", "does not restore running status claiming a run ID different from the active marker"],
		["repeat-reload", "markerless terminal publication survives reload with an inaccessible status"],
		["workflow-reload", "detached workflow publication survives reload with inaccessible result storage"],
		["published-reload", "published delivery remains held on reload even when active listing fails"],
	]) it(title, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-liveness-delivery-"));
		try {
			fs.mkdirSync(path.join(root, "home"));
			fs.mkdirSync(path.join(root, "agent"));
			const env = { ...process.env };
			delete env.PI_SUBAGENT_CHILD;
			delete env.PI_SUBAGENT_PARENT_SESSION;
			Object.assign(env, {
				HOME: path.join(root, "home"),
				USERPROFILE: path.join(root, "home"),
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				PI_SUBAGENTS_TEMP_ROOT: path.join(root, "temp"),
				TMPDIR: root,
				TMP: root,
				TEMP: root,
			});
			const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", terminalBeforePublicationScript, mode], {
				cwd: process.cwd(), encoding: "utf-8", env, timeout: 20_000,
			});
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(result.stdout, "ok");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("stays live while Pi queues a completion wake during a turn and past agent_settled", { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-liveness-sdk-"));
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const registryKey = Symbol.for(PI_WEB_SESSION_LIVENESS_REGISTRY_KEY);
		let provider: { isActive(): boolean } | undefined;
		(globalThis as Record<PropertyKey, unknown>)[registryKey] = {
			version: 1,
			register(value: { isActive(): boolean }) { provider = value; return () => {}; },
		};
		const sessionManager = SessionManager.inMemory(root);
		const sessionId = sessionManager.getSessionId();
		const complete = (api: Parameters<typeof registerSubagentExtension>[0], id: string) => api.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id, runId: id, sessionId, completionOwnerId: currentCompletionOwnerId(), success: false, summary: `${id} needs the parent`,
		});
		const activeAt: Record<string, boolean | undefined> = {};
		const terminalHolds: boolean[] = [];
		const timeline: string[] = [];
		const holdsAtSettle: Array<boolean | undefined> = [];
		const term = process.env.TERM;
		const programStatus = process.env.PI_PROGRAM_STATUS;
		process.env.TERM = "xterm-256color";
		process.env.PI_PROGRAM_STATUS = "1";
		const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		const faux = fauxProvider({ provider: "session-liveness", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		faux.setResponses([
			() => fauxAssistantMessage("First reply."),
			() => fauxAssistantMessage("Second reply."),
			() => fauxAssistantMessage("Third reply."),
		]);
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [
				(api) => { api.registerProvider(faux.provider); },
				(api) => {
					api.on("agent_start", () => {
						if ("duringTurn" in activeAt) return;
						complete(api, "during-turn");
						activeAt.duringTurn = provider?.isActive();
					});
					api.on("agent_settled", () => {
						if ("atSettle" in activeAt) {
							activeAt.finalSettle = provider?.isActive();
							return;
						}
						complete(api, "at-settle");
						activeAt.atSettle = provider?.isActive();
					});
				},
				registerSubagentExtension,
			],
		});
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			await resourceLoader.reload();
			const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
			({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager, noTools: "builtin" }));
			await session.bindExtensions({ mode: "tui", uiContext: {
				setWidget() {}, setStatus() {},
				setBackgroundWork: (_key: string, active: boolean) => {
					terminalHolds.push(active);
					timeline.push(`hold:${active}`);
				},
			} as unknown as NonNullable<Parameters<typeof session.bindExtensions>[0]["uiContext"]> });
			session.subscribe((event) => {
				if (event.type === "agent_start") timeline.push("start");
				if (event.type === "agent_settled") {
					holdsAtSettle.push(terminalHolds.at(-1));
					timeline.push("settle");
				}
			});
			await session.prompt("Start the original turn.");
			assert.equal(holdsAtSettle[0], true, "the first settle retains the queued completion hold");
			assert.deepEqual(terminalHolds, [true, false], "terminal hold clears only after the final follow-up");
			assert.deepEqual(timeline.slice(-3), ["start", "hold:false", "settle"]);
			assert.deepEqual(activeAt, { duringTurn: true, atSettle: true, finalSettle: false });
			assert.equal(session.messages.filter((message) => message.role === "custom" && message.customType === "subagent-notify").length, 2, "Pi started both queued wakes");
			await (session.extensionRunner as unknown as { emit(event: unknown): Promise<unknown> }).emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			session?.dispose();
			if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			if (term === undefined) delete process.env.TERM;
			else process.env.TERM = term;
			if (programStatus === undefined) delete process.env.PI_PROGRAM_STATUS;
			else process.env.PI_PROGRAM_STATUS = programStatus;
			delete (globalThis as Record<PropertyKey, unknown>)[registryKey];
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves an idle parent's completion wake across actual SDK reload until the woken run starts", { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-liveness-reload-"));
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const registryKey = Symbol.for(PI_WEB_SESSION_LIVENESS_REGISTRY_KEY);
		const globals = globalThis as Record<PropertyKey, unknown>;
		const previousRegistry = globals[registryKey];
		let provider: { isActive(): boolean } | undefined;
		let registrations = 0;
		const terminalHolds: boolean[] = [];
		const term = process.env.TERM;
		const programStatus = process.env.PI_PROGRAM_STATUS;
		const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		process.env.TERM = "xterm-256color";
		process.env.PI_PROGRAM_STATUS = "1";
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		globals[registryKey] = {
			version: 1,
			register(value: { isActive(): boolean }) {
				registrations++;
				provider = value;
				return () => { if (provider === value) provider = undefined; };
			},
		};
		const sessionManager = SessionManager.inMemory(root);
		const sessionId = sessionManager.getSessionId();
		const faux = fauxProvider({ provider: "liveness-reload", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		faux.setResponses([
			() => fauxAssistantMessage("Yielded original turn."),
			() => fauxAssistantMessage("Processed completion after reload."),
		]);
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let reloaded = false;
		// Hook errors after reload never reach onError, so record observations and assert after the prompt.
		let observed: Record<string, unknown> | undefined;
		const settingsManager = SettingsManager.inMemory({});
		const errors: unknown[] = [];
		const resourceLoader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [registerSubagentExtension, (api) => {
				api.registerProvider(faux.provider);
				api.on("agent_settled", async () => {
					if (reloaded) return;
					reloaded = true;
					api.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
						id: "reload-wake", sessionId, completionOwnerId: currentCompletionOwnerId(),
						success: false, summary: "Review requires the parent.",
					});
					const activeBeforeReload = provider?.isActive();
					await session!.reload();
					observed = {
						activeBeforeReload,
						registrations,
						isIdle: session!.isIdle,
						pendingMessageCount: session!.pendingMessageCount,
						noticeAppended: session!.messages.some((message) => message.role === "custom" && message.customType === "subagent-notify"),
						activeAfterReload: provider?.isActive(),
						terminalHoldsAfterReload: [...terminalHolds],
					};
				});
			}],
		});
		try {
			await resourceLoader.reload();
			const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
			({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager, noTools: "builtin" }));
			await session.bindExtensions({ mode: "tui", onError: (error) => { errors.push(error); }, uiContext: {
				setWidget() {}, setStatus() {},
				setBackgroundWork: (_key: string, active: boolean) => terminalHolds.push(active),
			} as unknown as NonNullable<Parameters<typeof session.bindExtensions>[0]["uiContext"]> });
			await session.prompt("Yield with a completion pending.");
			assert.equal(reloaded, true);
			assert.deepEqual(errors, []);
			assert.deepEqual(observed, {
				activeBeforeReload: true,
				registrations: 2, // reload actually bound the replacement producer
				isIdle: true,
				pendingMessageCount: 0, // Pi's deferred settled action is not counted as a pending message
				noticeAppended: false, // the notice starts the run Pi deferred past agent_settled, so it is not in the session yet
				activeAfterReload: true, // the retained wake owns liveness until that deferred run starts
				terminalHoldsAfterReload: [true, true],
			});
			assert.deepEqual(terminalHolds, [true, true, false], "only follow-up settlement releases the replacement hold");
			assert.equal(provider?.isActive(), false, "the woken run releases the retained wake");
			assert.equal(session.getLastAssistantText(), "Processed completion after reload.");
		} finally {
			if (session) await (session.extensionRunner as unknown as { emit(event: unknown): Promise<unknown> }).emit({ type: "session_shutdown", reason: "quit" });
			session?.dispose();
			if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			if (term === undefined) delete process.env.TERM;
			else process.env.TERM = term;
			if (programStatus === undefined) delete process.env.PI_PROGRAM_STATUS;
			else process.env.PI_PROGRAM_STATUS = programStatus;
			if (previousRegistry === undefined) delete globals[registryKey];
			else globals[registryKey] = previousRegistry;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
