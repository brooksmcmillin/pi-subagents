import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import type { ChildSession, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { createStructuredOutputFileCapture, createStructuredOutputRuntime, readStructuredOutput, shouldRecoverStructuredOutputCompletion, STRUCTURED_OUTPUT_COMPLETION_PROMPT } from "../../src/runs/shared/structured-output.ts";
import { makeAgentConfigs } from "../support/helpers.ts";

for (const mode of ["foreground", "background"] as const) {
	for (const scenario of ["empty", "prose", "no-evidence", "already-captured", "repeated-missing", "late-violation", "changed-evidence", "provider-error", "rejected-tool", "pending-tool", "queued-input", "tool-diagnostic", "shutdown", "stop", "interrupt", "timeout", "forced-drain", "deadline-during"] as const) {
		it(`${mode}: bounded same-session structured completion for ${scenario}`, { timeout: 15_000 }, async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "structured-completion-"));
			try {
				const runtime = createStructuredOutputRuntime({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false }, dir);
				let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
				const messages: ChildSession["messages"][number][] = [];
				const prompts: string[] = [];
				let creates = 0;
				let disposed = 0;
				let inspections = 0;
				let stop: (() => void) | undefined;
				let interrupt: (() => void) | undefined;
				let timeout: (() => void) | undefined;
				let aborted = false;
				let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
				const controller = new AbortController();
				const deadlineAt = scenario === "deadline-during" ? Date.now() + 100 : undefined;
				const factory: ChildSessionFactory = {
					async create(input) {
						creates++;
						return {
							messages, sessionId: "same-session", modelId: "mock/model", sessionFile: undefined,
							shutDown: scenario === "shutdown",
							hasQueuedMessages: () => scenario === "queued-input",
							subscribe(next) { listener = next; return () => {}; },
							async prompt(text) {
								prompts.push(text);
								if (prompts.length === 1) {
									inspections++;
									listener({ type: "tool_execution_start", toolName: "read", args: { path: "fixture.ts" } });
									listener({ type: "tool_execution_end", toolName: "read" });
									if (scenario !== "no-evidence") {
										const evidence = { role: "toolResult" as const, toolCallId: "read-fixture", toolName: "read", content: [{ type: "text" as const, text: "fixture.ts:1: export const stable = true;" }], isError: false, timestamp: Date.now() };
										messages.push(evidence);
										listener({ type: "tool_result_end", message: evidence });
									}
								}
								if (scenario === "deadline-during") await new Promise((resolve) => setTimeout(resolve, 60));
								if (scenario === "timeout") {
									if (mode === "background") timeout?.();
									else await new Promise((resolve) => setTimeout(resolve, 120));
								}
								if (scenario === "stop" || scenario === "interrupt") {
									if (mode === "foreground") controller.abort();
									else if (scenario === "stop") stop?.();
									else interrupt?.();
								}
								if (scenario === "pending-tool") listener({ type: "tool_execution_start", toolName: "read", args: { path: "unfinished.ts" } });
								if (scenario === "tool-diagnostic") input.runtime.toolDiagnostic?.({ required: ["structured_output"], available: [], missing: ["structured_output"] });
								const submit = !aborted && (scenario === "already-captured" || (prompts.length === 2 && scenario !== "repeated-missing"));
								if (submit || scenario === "rejected-tool") {
									listener({ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } });
									if (scenario !== "rejected-tool") input.runtime.structuredOutput?.capture?.({ ok: true }, undefined);
									listener({ type: "tool_execution_end", toolName: "structured_output" });
									if (scenario === "late-violation") input.runtime.structuredOutput!.completionRecovery!.error = "Structured completion recovery failed: forbidden tool after capture.";
									if (scenario === "changed-evidence") {
										const original = messages[0];
										if (original?.role === "toolResult" && original.content[0]?.type === "text") original.content[0].text = "changed subject evidence";
									}
								}
								const message = { ...fauxAssistantMessage(scenario === "prose" ? "Review complete, no findings." : ""), ...(scenario === "provider-error" ? { errorMessage: "provider failed", stopReason: "error" as const } : {}) };
								messages.push(message);
								listener({ type: "message_end", message });
								listener({ type: "agent_settled" });
								if (scenario === "forced-drain") await new Promise(() => {});
							},
							async steer() {}, async followUp() {}, async abort() { aborted = true; }, async dispose() { disposed++; },
						};
					},
					async dispose() {},
				};
				const launch = buildInProcessChildLaunch({ host: "runner", cwd: dir, childAgentName: "quick-review", childIndex: 0, sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, structuredOutput: runtime });
				if (launch.config.structuredOutput) launch.config.structuredOutput.capture = createStructuredOutputFileCapture(runtime);
				const result = mode === "foreground"
					? await runSync(dir, makeAgentConfigs(["quick-review"]), "quick-review", "Review the change", {
						childSessionFactory: factory, structuredOutput: runtime, acceptance: false,
						signal: scenario === "stop" ? controller.signal : undefined, abortedAsStopped: scenario === "stop",
						interruptSignal: scenario === "interrupt" ? controller.signal : undefined,
						timeoutMs: scenario === "timeout" || scenario === "deadline-during" ? 100 : undefined, deadlineAt,
					})
					: await runChildSession({
						factory, launch, prompt: "Review the change", appendChildEvent() {}, writeOutputLine() {}, runDeadlineAt: deadlineAt,
						registerStop(handler) { stop = handler; }, registerInterrupt(handler) { interrupt = handler; },
						registerTimeout(handler) {
							timeout = handler;
							if (handler && deadlineAt !== undefined) deadlineTimer = setTimeout(handler, Math.max(0, deadlineAt - Date.now()));
							if (!handler && deadlineTimer) clearTimeout(deadlineTimer);
						},
					});
				const recoverable = ["empty", "prose", "repeated-missing", "deadline-during", "late-violation", "changed-evidence"].includes(scenario);
				assert.equal(prompts.length, recoverable ? 2 : 1);
				if (recoverable) assert.equal(prompts[1], STRUCTURED_OUTPUT_COMPLETION_PROMPT);
				assert.equal(creates, 1);
				assert.equal(disposed, 1);
				assert.equal(inspections, 1, "completion recovery does not replay inspection");
				assert.equal(messages.length, prompts.length + (scenario === "no-evidence" ? 0 : 1), "original substantive evidence is retained");
				if (["empty", "prose", "already-captured"].includes(scenario)) {
					assert.equal(result.exitCode, 0);
					assert.deepEqual((await readStructuredOutput(runtime)).value, { ok: true });
				} else if (scenario === "late-violation" || scenario === "changed-evidence") {
					assert.equal(result.exitCode, 1);
					assert.match(result.error ?? "", /recovery failed/);
					assert.equal(result.structuredOutput, undefined, "a late failure must not expose a clean typed receipt");
				} else {
					assert.match((await readStructuredOutput(runtime)).error ?? "", /Missing structured_output/);
					if (mode === "foreground" && scenario !== "interrupt") assert.equal(result.exitCode, 1);
					if (scenario === "provider-error") assert.equal(result.exitCode, 1);
					if (scenario === "rejected-tool" && mode === "background") assert.equal(result.structuredOutputToolInvoked, true, "runner final validation must reject the uncaptured invocation");
					if (scenario === "deadline-during" || scenario === "timeout") assert.equal(result.timedOut, true);
					if (scenario === "stop") assert.equal(result.stopped, true);
					if (scenario === "interrupt") assert.equal(result.interrupted, true);
				}
			} finally { fs.rmSync(dir, { recursive: true, force: true }); }
		});
	}
}

it("never requests structured completion for blocked or ordinary runs", () => {
	const messages = [fauxAssistantMessage("")];
	assert.equal(shouldRecoverStructuredOutputCompletion({ required: true, toolInvoked: false, messages, blocked: true }), false);
	assert.equal(shouldRecoverStructuredOutputCompletion({ required: false, toolInvoked: false, messages, blocked: false }), false);
});
