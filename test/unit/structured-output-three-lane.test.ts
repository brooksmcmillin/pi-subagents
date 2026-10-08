import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import type { ChildSession, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { beginStructuredOutputCompletion, createStructuredOutputFileCapture, createStructuredOutputRuntime, MISSING_STRUCTURED_OUTPUT_CALL_ERROR, readStructuredOutput, STRUCTURED_OUTPUT_COMPLETION_PROMPT } from "../../src/runs/shared/structured-output.ts";

it("three-lane report fixture replaces two parent recoveries without replaying review", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "three-lane-completion-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "fixture.ts"), "export const stable = true;\n");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("add", "fixture.ts");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "immutable fixture-v1");
	const schema = {
		type: "object", required: ["status", "subject", "evidence"], additionalProperties: false,
		properties: { status: { const: "clean" }, subject: { const: "fixture-v1" }, evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } },
	};
	const report = { status: "clean", subject: "fixture-v1", evidence: ["fixture.ts:1: stable export inspected"] };
	const measurements = [];
	for (const mode of ["single-turn-parent-baseline", "automatic"] as const) {
		let parentRecoveryOperations = 0;
		const start = performance.now();
		const lanes = await Promise.all([0, 1, 2].map(async (index) => {
			const runtime = createStructuredOutputRuntime(schema, dir);
			const events: unknown[] = [];
			const messages: ChildSession["messages"][number][] = [];
			let prompts = 0;
			let inspections = 0;
			let creates = 0;
			let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
			let submit!: (id: string, params: { value: unknown }) => Promise<unknown>;
			const factory: ChildSessionFactory = {
				async create(input) {
					creates++;
					for (const hook of input.hooks) hook.factory({
						on() {}, events: { on() {} },
						registerTool(tool: { name: string; execute: typeof submit }) { if (tool.name === "structured_output") submit = tool.execute; },
					} as never);
					return {
						messages, sessionId: `${mode}-lane-${index}`, modelId: "fixture/model", sessionFile: undefined,
						subscribe(next) { listener = next; return () => {}; },
						async prompt(text) {
							prompts++;
							if (prompts === 1) {
								inspections++;
								assert.equal(fs.readFileSync(path.join(dir, "fixture.ts"), "utf8"), "export const stable = true;\n");
								const evidence = { role: "toolResult" as const, toolCallId: "read-fixture", toolName: "read", content: [{ type: "text" as const, text: report.evidence[0]! }], isError: false, timestamp: Date.now() };
								messages.push(evidence);
								listener({ type: "tool_execution_start", toolName: "read" });
								listener({ type: "tool_execution_end", toolName: "read" });
								listener({ type: "tool_result_end", message: evidence });
							} else assert.equal(text, STRUCTURED_OUTPUT_COMPLETION_PROMPT);
							if (index === 0 || prompts === 2) {
								listener({ type: "tool_execution_start", toolName: "structured_output" });
								await submit("report", { value: report });
								listener({ type: "tool_execution_end", toolName: "structured_output" });
							}
							const message = fauxAssistantMessage("fixture.ts:1 reviewed; stable export, no findings.");
							messages.push(message);
							listener({ type: "message_end", message });
							listener({ type: "agent_settled" });
						},
						async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
					};
				},
				async dispose() {},
			};
			const launch = buildInProcessChildLaunch({ host: "runner", cwd: dir, childAgentName: "quick-review", childIndex: index, runId: `${mode}-run-${index}`, sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, structuredOutput: runtime });
			launch.config.structuredOutput!.capture = createStructuredOutputFileCapture(runtime);
			if (mode === "single-turn-parent-baseline") {
				// A controlled replay of single-turn completion and parent report correction,
				// not a claim to execute the historical installed runner or its status UI.
				const session = await factory.create(launch.session);
				await session.prompt("Review fixture-v1");
				const initial = await readStructuredOutput(runtime);
				if (initial.error) {
					assert.equal(initial.error, MISSING_STRUCTURED_OUTPUT_CALL_ERROR);
					events.push({ originalError: initial.error, sessionId: session.sessionId });
					assert.equal(beginStructuredOutputCompletion(launch.config.structuredOutput, messages, dir), true);
					parentRecoveryOperations++;
					await session.prompt(STRUCTURED_OUTPUT_COMPLETION_PROMPT);
				}
				await session.dispose();
			} else {
				const result = await runChildSession({ factory, launch, prompt: "Review fixture-v1", childEventContext: { runId: `${mode}-run-${index}`, stepIndex: index, agent: "quick-review" }, appendChildEvent(event) { events.push(event); }, writeOutputLine() {} });
				assert.equal(result.exitCode, 0);
				assert.equal(result.error, undefined);
				if (index !== 0) assert.ok(events.some((event) => (event as { originalError?: string }).originalError === MISSING_STRUCTURED_OUTPUT_CALL_ERROR));
			}
			assert.deepEqual((await readStructuredOutput(runtime)).value, report);
			assert.deepEqual(JSON.parse(fs.readFileSync(runtime.outputPath, "utf8")), report);
			assert.equal(creates, 1);
			assert.equal(inspections, 1);
			assert.equal(prompts, index === 0 ? 1 : 2);
			assert.equal(messages[0]?.role, "toolResult", "original substantive evidence remains first");
			return { index, inspections, prompts, creates, validatedArtifact: true, originalFailureRetained: index === 0 || events.length > 0 };
		}));
		measurements.push({ mode, parentRecoveryOperations, durationMs: Number((performance.now() - start).toFixed(3)), lanes });
	}
	assert.equal(measurements[0]!.parentRecoveryOperations, 2);
	assert.equal(measurements[1]!.parentRecoveryOperations, 0);
	t.diagnostic(JSON.stringify({ fixture: "sanitized-three-lane", paidModelCalls: 0, measurements }));
});
