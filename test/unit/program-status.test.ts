import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { registerProgramStatusReporter, type ProgramStatusReporter } from "../../src/integrations/program-status.ts";
import { createParentWake } from "../../src/shared/parent-wake.ts";
import type { AsyncJobState } from "../../src/shared/types.ts";

type Job = Pick<AsyncJobState, "asyncId" | "status"> & Partial<AsyncJobState>;

function job(asyncId: string, status: AsyncJobState["status"], extra: Partial<AsyncJobState> = {}): AsyncJobState {
	return { asyncId, asyncDir: `/runs/${asyncId}`, status, agents: ["worker"], ...extra } as AsyncJobState;
}

function decode(report: string): Record<string, string> {
	const match = /^\x1b\]7501;(.*)\x1b\\$/.exec(report);
	assert.ok(match, `not an OSC 7501 report: ${JSON.stringify(report)}`);
	const fields = Object.fromEntries(match[1]!.split(":").map((pair) => {
		const at = pair.indexOf("=");
		return [pair.slice(0, at), pair.slice(at + 1)];
	}));
	for (const key of ["title", "msg"]) {
		if (fields[key] !== undefined) fields[key] = Buffer.from(fields[key], "base64").toString("utf-8");
	}
	return fields;
}

const reporters: ProgramStatusReporter[] = [];

function reporter(input: { jobs?: Job[]; hasBackgroundWork?: () => boolean; hasPendingWake?: () => boolean; getQueuedWake?: () => string | undefined; isParentPreparing?: () => boolean; now?: () => number; pending?: Array<{ id: string; runId: string }>; enabled?: boolean; isTTY?: boolean; env?: Record<string, string>; hasUI?: boolean; mode?: string } = {}) {
	const writes: string[] = [];
	const jobs = new Map<string, AsyncJobState>((input.jobs ?? []).map((entry) => [entry.asyncId, entry as AsyncJobState]));
	const pending = input.pending ?? [];
	const holds: boolean[] = [];
	const instance = registerProgramStatusReporter({
		enabled: input.enabled ?? true,
		getJobs: () => jobs.values(),
		hasBackgroundWork: input.hasBackgroundWork ?? (() => false),
		hasPendingWake: input.hasPendingWake,
		getQueuedWake: input.getQueuedWake,
		isParentPreparing: input.isParentPreparing,
		now: input.now,
		getPendingRequests: () => pending,
		write: (data) => writes.push(data),
		isTTY: input.isTTY ?? true,
		env: input.env ?? { TERM: "xterm-ghostty" },
	});
	instance.sessionStarted({ hasUI: input.hasUI ?? true, mode: input.mode ?? "tui", setBackgroundWork: (_key, active) => holds.push(active) });
	reporters.push(instance);
	return { instance, writes, jobs, pending, holds, records: () => writes.map(decode) };
}

describe("OSC 7501 program status", () => {
	// Each active reporter holds a process SIGCONT listener until it is disposed.
	afterEach(() => {
		for (const instance of reporters.splice(0)) instance.dispose("quit");
	});

	it("reports one record per run under subagents/, and only when a record changes", () => {
		const runId = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
		const { instance, writes, jobs, records } = reporter({ jobs: [job(runId, "running", { currentTool: "bash" })] });
		assert.equal(writes[0], `\x1b]7501;state=working:id=subagents/0f1e2d3c4b5a:app=pi-subagents:title=${Buffer.from("worker").toString("base64")}:msg=${Buffer.from("Running bash").toString("base64")}\x1b\\`);
		instance.sync();
		instance.sync();
		assert.equal(writes.length, 1);

		const states: Array<[AsyncJobState["status"], string, string]> = [
			["complete", "done", "Finished"],
			["failed", "error", "Failed"],
			["partial", "error", "Finished with failures"],
			["rejected", "error", "Rejected"],
			["stopped", "idle", "Stopped"],
			["paused", "idle", "Paused"],
			["queued", "working", "Running"],
		];
		for (const [status, state, msg] of states) {
			jobs.set(runId, job(runId, status));
			instance.sync();
			assert.deepEqual(records().at(-1), { state, id: "subagents/0f1e2d3c4b5a", app: "pi-subagents", title: "worker", msg });
		}
	});

	it("defers workflow and child results until the parent settles, clearing them on its next start", () => {
		const workflow = "abcdef12-3456-7890-abcd-ef1234567890";
		const { instance, jobs, records, writes } = reporter({ jobs: [
			job(workflow, "running", { mode: "workflow" }),
			job("child", "running", { parentWorkflowRunId: workflow, workflowKey: "code" }),
			job("other", "running"),
		] });
		instance.agentStarted();
		jobs.get(workflow)!.status = "complete";
		jobs.get("child")!.status = "complete";
		instance.sync();
		assert.deepEqual(records().slice(3), [
			{ state: "clear", id: "subagents/abcdef123456" },
			{ state: "clear", id: "subagents/abcdef123456.code" },
		]);
		assert.ok(!records().some(({ state }) => state === "done"));
		instance.sync();
		assert.equal(writes.length, 5, "unchanged results stay suppressed");
		if (process.platform !== "win32") {
			process.emit("SIGCONT");
			assert.deepEqual(records().slice(5).map(({ state, id }) => [state, id]), [["working", "subagents/other"]]);
		}
		instance.agentSettled();
		assert.deepEqual(records().slice(-2).map(({ state }) => state), ["done", "done"]);
		instance.agentStarted();
		assert.deepEqual(records().slice(-2).map(({ state, id }) => [state, id]), [
			["clear", "subagents/abcdef123456"],
			["clear", "subagents/abcdef123456.code"],
		]);
		assert.equal(jobs.size, 3, "terminal projection does not remove inspectable results");
	});

	it("defers failures to the working parent without hiding failures that arrive while idle", () => {
		for (const status of ["failed", "partial", "rejected"] as const) {
			const { instance, jobs, records } = reporter();
			instance.agentStarted();
			jobs.set("result", job("result", status));
			instance.sync();
			assert.deepEqual(records(), [], status);
			instance.agentSettled();
			assert.equal(records().at(-1)?.state, "error", status);
			instance.agentStarted();
			assert.deepEqual(records().at(-1), { state: "clear", id: "subagents/result" });
		}
		const idle = reporter();
		idle.jobs.set("late", job("late", "failed"));
		idle.instance.sync();
		assert.equal(idle.records().at(-1)?.state, "error");
	});

	it("defers terminal completions until parallel work, delivery, and the parent follow-up drain", () => {
		let pendingDelivery = false;
		let liveWork = true;
		const { instance, jobs, records, holds } = reporter({
			jobs: [job("first", "running"), job("second", "running")],
			hasBackgroundWork: () => liveWork || pendingDelivery,
		});
		instance.agentStarted();
		jobs.set("first", job("first", "complete"));
		instance.agentSettled();
		assert.deepEqual(holds, [true]);
		assert.ok(!records().some(({ state }) => state === "done"));

		jobs.set("second", job("second", "failed"));
		liveWork = false;
		pendingDelivery = true;
		instance.sync();
		assert.ok(!records().some(({ state }) => state === "done" || state === "error"));

		instance.agentStarted();
		pendingDelivery = false;
		instance.sync();
		assert.deepEqual(holds, [true]);
		assert.ok(!records().some(({ state }) => state === "done" || state === "error"));
		instance.agentSettled();
		assert.deepEqual(holds, [true, false]);
		assert.deepEqual(records().filter(({ state }) => state === "done" || state === "error").map(({ state }) => state), ["done", "error"]);
	});

	it("keeps a queued result across a long busy turn and into its follow-up", () => {
		let now = 0;
		let queuedWake: string | undefined;
		let preparing = false;
		let running = true;
		const { instance, jobs, holds, records } = reporter({ jobs: [job("review", "running")],
			hasBackgroundWork: () => running, getQueuedWake: () => queuedWake, isParentPreparing: () => preparing, now: () => now });
		instance.agentStarted();
		queuedWake = "busy-turn-result";
		running = false;
		jobs.get("review")!.status = "complete";
		instance.sync();
		now += 60_000;
		instance.agentSettled();
		preparing = true;
		now += 60_000;
		instance.sync();
		assert.deepEqual(holds, [true]);
		assert.ok(!records().some(({ state }) => state === "done"));
		instance.agentStarted();
		queuedWake = undefined;
		instance.sync();
		assert.deepEqual(holds, [true]);
		instance.agentSettled();
		assert.deepEqual(holds, [true, false]);
		assert.equal(records().at(-1)?.state, "done");
	});

	it("holds a busy wait-subscription wake after a non-waking result is delivered", () => {
		let now = 0;
		let idle = true;
		let delivering = true;
		const wake = createParentWake({ sendMessage() {} }, () => now);
		wake.bindSession({ isIdle: () => idle, sessionManager: { getSessionId: () => "wait" } as Parameters<typeof wake.bindSession>[0]["sessionManager"] });
		const { instance, holds, records } = reporter({ jobs: [job("review", "complete")],
			hasBackgroundWork: () => delivering, getQueuedWake: wake.getQueuedWait, isParentPreparing: () => !idle, now: () => now });
		instance.agentStarted();
		idle = false;
		const notice = { customType: "subagent-wait-subscription", content: "review ready", display: true };
		wake.sendMessage(notice, { triggerTurn: true });
		delivering = false;
		instance.sync();
		idle = true;
		instance.agentSettled();
		idle = false;
		now += 60_000;
		instance.sync();
		assert.deepEqual(holds, [true]);
		assert.deepEqual(records(), []);
		instance.agentStarted();
		wake.messageStarted({ role: "custom", ...notice });
		assert.equal(wake.getQueuedWait(), undefined);
		idle = true;
		instance.agentSettled();
		assert.deepEqual(holds, [true, false]);
		assert.equal(records().at(-1)?.state, "done");
	});

	it("holds a deferred compaction wake across its transition to a parent wake", () => {
		let now = 0;
		let compacting = true;
		let deferred = true;
		let pending = false;
		const { instance, holds, records } = reporter({ jobs: [job("review", "complete")], now: () => now,
			hasPendingWake: () => (deferred && compacting) || pending,
			getQueuedWake: () => deferred ? "compaction" : undefined });
		now += 60_000;
		instance.sync();
		compacting = false;
		instance.sync();
		deferred = false;
		pending = true;
		instance.sync();
		assert.deepEqual(holds, [true]);
		assert.deepEqual(records(), []);
		instance.agentStarted();
		pending = false;
		instance.agentSettled();
		assert.deepEqual(holds, [true, false]);
		assert.equal(records().at(-1)?.state, "done");
	});

	it("releases a failed wake after its reservation expires, but not while Pi is preparing it", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let now = 0;
		let idle = true;
		const wake = createParentWake({ sendMessage() {} }, () => now);
		wake.bindSession({ isIdle: () => idle, sessionManager: { getSessionId: () => "status" } as Parameters<typeof wake.bindSession>[0]["sessionManager"] });
		wake.sendMessage({ customType: "review", content: "result", display: false }, { triggerTurn: true });
		const { holds, records } = reporter({ jobs: [job("review", "complete")], hasPendingWake: wake.isPending });
		const advance = (ms: number) => { now += ms; t.mock.timers.tick(ms); };
		advance(9_000);
		assert.deepEqual(holds, [true]);
		idle = false;
		advance(2_000);
		assert.deepEqual(holds, [true], "preparation keeps the expired reservation live");
		assert.deepEqual(records(), []);
		idle = true;
		advance(1_000);
		assert.deepEqual(holds, [true, false]);
		assert.equal(records().at(-1)?.state, "done");
	});

	it("does not rearm an expired queued wake on an unrelated turn", () => {
		let now = 0;
		let queued = "first";
		const { instance, holds } = reporter({ getQueuedWake: () => queued, now: () => now });
		now += 60_000;
		instance.sync();
		assert.deepEqual(holds, [true, false]);
		instance.agentStarted();
		instance.agentSettled();
		assert.deepEqual(holds, [true, false]);
		queued = "second";
		instance.sync();
		assert.deepEqual(holds, [true, false, true]);
		instance.dispose("quit");
	});

	it("reports blocked only while the parent is idle after settling without answering the request", () => {
		const { instance, records, pending } = reporter({ jobs: [job("run-a", "running")] });
		pending.push({ id: "req-1", runId: "run-a" });
		instance.sync();
		assert.equal(records().length, 1, "a new request is the parent's to handle first");
		instance.agentStarted();
		instance.agentSettled();
		assert.deepEqual(records().at(-1), { state: "blocked", id: "subagents/runa", app: "pi-subagents", kind: "question", title: "worker", msg: "Waiting for a reply" });
		instance.agentStarted();
		assert.equal(records().at(-1)?.state, "working", "the parent is working on it again");
		pending.length = 0;
		instance.agentSettled();
		assert.equal(records().at(-1)?.state, "working");
		assert.equal(records().length, 3);
	});

	it("keeps title and msg free of control characters and within 192 and 2048 bytes", () => {
		const longTool = `bash\x1b[31m\u0085${"界".repeat(1000)}`;
		const { records } = reporter({ jobs: [job("run-b", "running", { currentTool: longTool, workflowKey: `lane\x1b[2J${"界".repeat(100)}` })] });
		const record = records()[0]!;
		const bytes = Buffer.byteLength(record.msg!, "utf-8");
		assert.ok(bytes <= 2048, `msg is ${bytes} bytes`);
		assert.ok(bytes > 2040, "truncated close to the limit, on a code point boundary");
		assert.doesNotMatch(record.msg!, /[\u0000-\u001f\u007f-\u009f�]/);
		const titleBytes = Buffer.byteLength(record.title!, "utf-8");
		assert.ok(titleBytes <= 192 && titleBytes > 186, `title is ${titleBytes} bytes`);
		assert.doesNotMatch(record.title!, /[\u0000-\u001f\u007f-\u009f�]/);
	});

	it("shows at most 64 records, active runs first", () => {
		const running = reporter({ jobs: Array.from({ length: 65 }, (_, index) => job(`run-${index}`, "running", { updatedAt: index + 1 })) });
		assert.equal(running.writes.length, 64);
		assert.ok(!running.records().some((record) => record.id === "subagents/run0"), "the least recently updated run is not shown");
		running.jobs.set("done-new", job("done-new", "complete", { updatedAt: 1000 }));
		running.instance.sync();
		running.instance.sync();
		assert.equal(running.writes.length, 64, "a finished run never displaces an active one, and unchanged jobs write nothing");
	});

	it("clears the least recently updated finished record when an active run needs the room", () => {
		const { instance, jobs, records } = reporter({ jobs: Array.from({ length: 64 }, (_, index) => job(`done-${index}`, "complete", { updatedAt: index + 1 })) });
		jobs.set("new-run", job("new-run", "running", { updatedAt: 100 }));
		instance.sync();
		assert.deepEqual(records().slice(64).map(({ state, id }) => `${state} ${id}`), ["clear subagents/done0", "working subagents/newrun"]);
	});

	it("gives a workflow child one flat id segment next to its run, so clearing the run never touches the child", () => {
		const workflowRunId = "abcdef12-3456-7890-abcd-ef1234567890";
		const { instance, jobs, records } = reporter({ jobs: [
			job(workflowRunId, "complete", { mode: "workflow", updatedAt: 1 }),
			job("child-run", "running", { parentWorkflowRunId: workflowRunId, workflowKey: "worker", updatedAt: 2 }),
		] });
		assert.deepEqual(records().map(({ state, id }) => `${state} ${id}`), ["working subagents/abcdef123456.worker", "done subagents/abcdef123456"]);
		jobs.delete(workflowRunId);
		instance.sync();
		instance.sync();
		assert.deepEqual(records().slice(2), [{ state: "clear", id: "subagents/abcdef123456" }]);
	});

	it("keeps workflow child ids within one 32-character segment without collisions", () => {
		const parentWorkflowRunId = "abcdef12-3456-7890-abcd-ef1234567890";
		const longA = `review-${"a".repeat(30)}-one`;
		const longB = `review-${"a".repeat(30)}-two`;
		const { records } = reporter({ jobs: [
			job("child-dots", "running", { parentWorkflowRunId, workflowKey: "lint.fix/s1 x", updatedAt: 3 }),
			job("child-a", "running", { parentWorkflowRunId, workflowKey: longA, updatedAt: 2 }),
			job("child-b", "running", { parentWorkflowRunId, workflowKey: longB, updatedAt: 1 }),
		] });
		const ids = records().map((record) => record.id!);
		assert.equal(new Set(ids).size, ids.length, ids.join(" "));
		for (const id of ids) {
			const [root, segment, ...rest] = id.split("/");
			assert.equal(root, "subagents");
			assert.deepEqual(rest, []);
			assert.match(segment!, /^[A-Za-z0-9_+-]{12}\.[A-Za-z0-9_+-]{1,19}$/);
		}
	});

	it("keeps keys apart that differ only in characters the id cannot carry", () => {
		const parentWorkflowRunId = "abcdef12-3456-7890-abcd-ef1234567890";
		const { records } = reporter({ jobs: [
			job("child-dot", "running", { parentWorkflowRunId, workflowKey: "a.b", updatedAt: 2 }),
			job("child-dash", "running", { parentWorkflowRunId, workflowKey: "a-b", updatedAt: 1 }),
		] });
		const ids = records().map((record) => record.id);
		assert.equal(ids[1], "subagents/abcdef123456.a-b");
		assert.notEqual(ids[0], ids[1]);
	});

	it("clears every record it sent when its runtime is replaced, but leaves them when Pi quits", () => {
		const jobs = [job("run-f", "complete"), job("run-g", "running")];
		const reloaded = reporter({ jobs });
		reloaded.instance.dispose("reload");
		reloaded.instance.sync();
		assert.deepEqual(reloaded.records().slice(2).map(({ state, id }) => `${state} ${id}`).sort(), ["clear subagents/runf", "clear subagents/rung"]);

		const replaced = reporter({ jobs });
		replaced.instance.dispose();
		assert.equal(replaced.records().slice(2).length, 2, "a replacement without a shutdown event clears too");

		const quit = reporter({ jobs });
		quit.instance.dispose("quit");
		quit.instance.sync();
		assert.equal(quit.writes.length, 2, "done and error records stay after Pi exits");
	});

	it("writes nothing when turned off or not on an interactive terminal", () => {
		const cases = [
			{ enabled: false },
			{ isTTY: false },
			{ env: { TERM: "dumb" } },
			{ env: { TERM: "xterm-ghostty", PI_PROGRAM_STATUS: "0" } },
			{ hasUI: false },
			{ mode: "rpc" },
		];
		for (const input of cases) {
			const { instance, writes } = reporter({ ...input, jobs: [job("run-e", "running")] });
			instance.agentSettled();
			instance.sync();
			assert.deepEqual(writes, [], JSON.stringify(input));
		}
	});

	it("sends its records again when Pi resumes from a suspend, until it is disposed", { skip: process.platform === "win32" ? "no SIGCONT on Windows" : undefined }, () => {
		const { instance, writes } = reporter({ jobs: [job("run-h", "running"), job("run-i", "complete")] });
		const shown = [...writes];
		process.emit("SIGCONT");
		assert.deepEqual(writes.slice(2), shown);
		instance.dispose("quit");
		process.emit("SIGCONT");
		assert.equal(writes.length, 4);
	});
});
