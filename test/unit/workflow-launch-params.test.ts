import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactSuccessfulFileOnlyWorkflowResult, prepareWorkflowLaunchParams, workflowChildResults } from "../../src/runs/foreground/subagent-executor.ts";
import type { SingleResult } from "../../src/shared/types.ts";

describe("workflow launch params", () => {
	it("reduces successful file-only workflow results to a bounded artifact receipt", () => {
		const result = {
			index: 2,
			agent: "reviewer",
			task: "A large private prompt",
			exitCode: 0,
			usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
			outputMode: "file-only",
			savedOutputPath: "/tmp/review.md",
			outputReference: { path: "/tmp/review.md", authoritative: true },
			structuredOutput: { verdict: "pass" },
			messages: [{ role: "assistant", content: "large" }],
			toolCalls: [{ name: "read", args: {}, text: "read", expandedText: "large" }],
			progress: { recentOutput: ["large"] },
			finalOutput: "Saved output: /tmp/review.md",
		} as unknown as SingleResult;

		const compact = compactSuccessfulFileOnlyWorkflowResult(result);
		assert.equal(compact.task, "[prompt redacted]");
		assert.equal(compact.savedOutputPath, "/tmp/review.md");
		assert.equal(compact.structuredOutput, undefined);
		assert.equal(compact.usage, undefined);
		assert.equal(compact.messages, undefined);
		assert.equal(compact.toolCalls, undefined);
		assert.equal(compact.progress, undefined);
		assert.equal(compact.finalOutput, undefined);
	});

	it("publishes structured workflow output once in the final receipt", () => {
		const compact = {
			index: 2,
			agent: "reviewer",
			task: "[prompt redacted]",
			exitCode: 0,
			outputMode: "file-only",
			savedOutputPath: "/tmp/review.md",
		} as unknown as SingleResult;
		const results = workflowChildResults([{
			key: "review",
			ok: true,
			output: "Saved output: /tmp/review.md",
			structuredOutput: { verdict: "pass" },
			artifactPaths: ["/tmp/review.md"],
			results: [compact],
		}]);

		assert.deepEqual(results[0]?.structuredOutput, { verdict: "pass" });
		assert.equal(results.filter((result) => result.structuredOutput !== undefined).length, 1);
	});

	it("retains complete failed file-only workflow results for diagnosis", () => {
		const failed = {
			index: 0,
			agent: "reviewer",
			task: "Review",
			exitCode: 1,
			error: "review failed",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			outputMode: "file-only",
			savedOutputPath: "/tmp/partial.md",
			messages: [{ role: "assistant", content: "diagnostic" }],
		} as unknown as SingleResult;

		assert.equal(compactSuccessfulFileOnlyWorkflowResult(failed), failed);
	});

	it("keeps omitted workflow child async foreground", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Run" },
				"workflow-run",
				"run",
			),
			{
				agent: "worker",
				task: "Run",
				async: false,
				workflowParentRunId: "workflow-run",
				workflowKey: "run",
			},
		);
	});

	it("preserves explicit async workflow children", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Run", async: true },
				"workflow-run",
				"run",
			),
			{
				agent: "worker",
				task: "Run",
				async: true,
				workflowParentRunId: "workflow-run",
				workflowKey: "run",
			},
		);
	});

	it("keeps a bridge override scoped to the target workflow child", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Run", intercomBridge: { mode: "off" } },
				"workflow-run",
				"isolated",
			),
			{
				agent: "worker",
				task: "Run",
				intercomBridge: { mode: "off" },
				async: false,
				workflowParentRunId: "workflow-run",
				workflowKey: "isolated",
			},
		);
		assert.equal(prepareWorkflowLaunchParams({}, { agent: "worker", task: "Run" }, "workflow-run", "sibling").intercomBridge, undefined);
	});

	it("places workflow child gates inside managed worktree tasks", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Implement", worktree: true, gate: "npm test" },
				"workflow-run",
				"gated",
			),
			{
				worktree: true,
				async: false,
				workflowParentRunId: "workflow-run",
				workflowKey: "gated",
				tasks: [{
					agent: "worker",
					task: "Implement",
					acceptance: { level: "verified", verify: [{ id: "gate", command: "npm test" }] },
				}],
			},
		);
	});

	it("preserves a bridge override for retained workflow children", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ resume: "retained-run", task: "Continue", intercomBridge: { mode: "off" } },
				"workflow-run",
				"continue",
			),
			{
				action: "resume",
				id: "retained-run",
				message: "Continue",
				workflowParentRunId: "workflow-run",
				workflowKey: "continue",
				intercomBridge: { mode: "off" },
			},
		);
	});

	it("rejects gate defaults on retained resume items", () => {
		assert.throws(
			() => prepareWorkflowLaunchParams(
				{ gate: "npm test" },
				{ resume: "retained-run", task: "Continue" },
				"workflow-run",
				"continue",
			),
			/gate is not supported with retained resume/,
		);
		assert.throws(
			() => prepareWorkflowLaunchParams(
				{},
				{ resume: "retained-run", task: "Continue", gate: "npm test" },
				"workflow-run",
				"continue",
			),
			/gate is not supported with retained resume/,
		);
	});

	it("preserves execution limits and fan-out identity when routing retained resume items", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{ turnBudget: { maxTurns: 8 }, toolBudget: { hard: 12, block: ["read"] } },
				{
					resume: " retained-run ",
					task: "Continue carefully",
					maxRuntimeMs: 5_000,
					turnBudget: { maxTurns: 3, graceTurns: 1 },
					toolBudget: { soft: 2, hard: 4, block: "*" },
				},
				"workflow-run",
				"continue",
				{ missionDetached: true, runFanoutBudget: { version: 1, rootRunId: "root-run", directory: "/tmp/fanout", limit: 64, parentPath: "parent" } },
			),
			{
				action: "resume",
				id: "retained-run",
				message: "Continue carefully",
				workflowParentRunId: "workflow-run",
				workflowKey: "continue",
				runFanoutBudget: { version: 1, rootRunId: "root-run", directory: "/tmp/fanout", limit: 64, parentPath: "parent/workflow[continue]" },
				mission: false,
				timeoutMs: 5_000,
				turnBudget: { maxTurns: 3, graceTurns: 1 },
				toolBudget: { soft: 2, hard: 4, block: "*" },
			},
		);
	});
});
