import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ChildStructuredOutput } from "../../src/runs/shared/child-runtime-config.ts";
import registerSubagentPromptRuntime from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { beginStructuredOutputCompletion, MISSING_STRUCTURED_OUTPUT_CALL_ERROR, shouldRecoverStructuredOutputCompletion } from "../../src/runs/shared/structured-output.ts";

function harness(cwd: string) {
	const captured: unknown[] = [];
	const handlers = new Map<string, Array<(event: unknown) => unknown>>();
	let execute!: (id: string, params: { value: unknown }) => Promise<unknown>;
	const structured: ChildStructuredOutput = {
		schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
		capture(value) { captured.push(value); },
	};
	registerSubagentPromptRuntime({
		on(name: string, handler: (event: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: { name: string; execute: typeof execute }) { if (tool.name === "structured_output") execute = tool.execute; },
		events: { on() {} },
	} as never, { cwd, structuredOutput: structured, fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false });
	const messages = [fauxAssistantMessage("fixture.ts:1 inspected; stable export, no findings.")];
	return {
		structured, captured, messages,
		begin: () => beginStructuredOutputCompletion(structured, messages, cwd),
		submit: (value: unknown = { ok: true }) => execute("report", { value }),
		async emit(name: string, event: unknown) {
			const results = [];
			for (const handler of handlers.get(name) ?? []) results.push(await handler(event));
			return results;
		},
	};
}

it("requires retained substantive evidence rather than a terminal empty response", () => {
	const options = { required: true, toolInvoked: false, blocked: false };
	assert.equal(shouldRecoverStructuredOutputCompletion({ ...options, messages: [fauxAssistantMessage("")] }), false);
	assert.equal(shouldRecoverStructuredOutputCompletion({ ...options, messages: [fauxAssistantMessage("Inspected fixture.ts:1, no findings.")] }), true);
});

it("report-only recovery preserves its original failure and allows no second attempt", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-recovery-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const h = harness(dir);
	assert.equal(h.begin(), true);
	assert.equal(h.begin(), false);
	assert.equal(h.structured.completionRecovery?.originalError, MISSING_STRUCTURED_OUTPUT_CALL_ERROR);
	await h.submit();
	assert.deepEqual(h.captured, [{ ok: true }]);
	assert.equal(h.messages.length, 1);
});

for (const toolName of ["read", "bash", "mcp", "write", "subagent"]) {
	it(`report-only recovery blocks ${toolName} and cannot later capture a clean report`, async (t) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-recovery-"));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		const h = harness(dir);
		assert.equal((await h.emit("tool_call", { toolName })).some((r) => (r as { block?: boolean })?.block), false, "ordinary review is unchanged");
		assert.equal(h.begin(), true);
		assert.equal((await h.emit("tool_call", { toolName })).some((r) => (r as { block?: boolean })?.block), true);
		await assert.rejects(h.submit(), /only structured_output/);
		assert.deepEqual(h.captured, []);
	});
}

for (const kind of ["evidence", "schema", "tracked-tree", "head", "unavailable"] as const) {
	it(`changed ${kind} cannot yield a recovered report`, async (t) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-recovery-"));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
		git("init", "-q");
		fs.writeFileSync(path.join(dir, "fixture.ts"), "export const stable = true;\n");
		git("add", "fixture.ts");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "subject");
		const h = harness(dir);
		assert.equal(h.begin(), true);
		assert.equal(h.structured.completionRecovery?.validateSubject(), undefined);
		if (kind === "evidence") h.messages[0] = fauxAssistantMessage("Replaced evidence");
		if (kind === "schema") h.structured.schema = { type: "string" };
		if (kind === "tracked-tree") fs.writeFileSync(path.join(dir, "fixture.ts"), "export const stable = false;\n");
		if (kind === "head") git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "different subject");
		if (kind === "unavailable") fs.renameSync(path.join(dir, ".git"), path.join(dir, ".git-unavailable"));
		await assert.rejects(h.submit(), /changed|unavailable/);
		assert.deepEqual(h.captured, []);
	});
}

it("a Git workspace with no available HEAD is not treated as a non-Git subject", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-recovery-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	const h = harness(dir);
	assert.equal(h.begin(), false);
	assert.equal(h.structured.completionRecovery, undefined);
});

it("a broken Git worktree pointer is not treated as a non-Git subject", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-recovery-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, ".git"), "gitdir: missing-worktree-metadata\n");
	const h = harness(dir);
	assert.equal(h.begin(), false);
	assert.equal(h.structured.completionRecovery, undefined);
});

it("an expired deadline cannot admit a report attempt after subject preparation", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-recovery-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const h = harness(dir);
	assert.equal(beginStructuredOutputCompletion(h.structured, h.messages, dir, Date.now() - 1), false);
	assert.equal(h.structured.completionRecovery, undefined);
});

it("invalid recovery value remains failed even if a later call would validate", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-recovery-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const h = harness(dir);
	h.begin();
	await assert.rejects(h.submit({ ok: "invalid" }), /validation failed/);
	await assert.rejects(h.submit(), /was rejected/);
	assert.deepEqual(h.captured, []);
});

it("malformed recovery schema does not leak its compiler text in the failure latch", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-recovery-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const h = harness(dir);
	h.structured.schema = { type: "string", pattern: "PRIVATE_SCHEMA_SENTINEL_[invalid" };
	h.begin();
	await assert.rejects(h.submit("value"), /invalid outputSchema/);
	assert.doesNotMatch(h.structured.completionRecovery?.error ?? "", /PRIVATE_SCHEMA_SENTINEL/);
	await assert.rejects(h.submit("value"), /was rejected/);
	assert.deepEqual(h.captured, []);
});

it("a duplicate report cannot overwrite the first capture", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-recovery-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const h = harness(dir);
	h.begin();
	await h.submit();
	await assert.rejects(h.submit({ ok: false }), /already submitted/);
	assert.deepEqual(h.captured, [{ ok: true }]);
	assert.match(h.structured.completionRecovery?.error ?? "", /already submitted/);
});

it("framework argument rejection during recovery also exhausts the attempt", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-recovery-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const h = harness(dir);
	h.begin();
	await h.emit("tool_result", { toolName: "structured_output", isError: true });
	await assert.rejects(h.submit(), /was rejected/);
	assert.deepEqual(h.captured, []);
});
