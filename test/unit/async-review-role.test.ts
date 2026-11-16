import assert from "node:assert/strict";
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import type { RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";
import { DIRS } from "../../src/shared/types.ts";
import { makeAgent } from "../support/helpers.ts";

it("preserves review role through async single serialization into retention opt-in", async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "async-review-role-")));
	const schema = { type: "object", properties: { status: { type: "string" } } };
	const runIds: string[] = [];
	const configPaths: string[] = [];
	let step: RunnerSubagentStep | undefined;
	const spawn = t.mock.method(childProcess, "spawn", (_command, args) => {
		const configPath = args!.at(-1)!;
		configPaths.push(configPath);
		step = JSON.parse(fs.readFileSync(configPath, "utf8")).steps[0];
		throw new Error("captured detached spawn");
	});
	syncBuiltinESMExports();
	try {
		for (const [role, structured] of [["read-only", true], ["writer", true], [undefined, true], ["read-only", false]] as const) {
			const id = `review-role-${runIds.length}-${Date.now().toString(36)}`;
			runIds.push(id);
			step = undefined;
			const result = await executeAsyncSingle(id, {
				agent: "reviewer", task: "Inspect the review subject", agentConfig: makeAgent("reviewer", { acceptanceRole: role }),
				ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "review-role-parent" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1, acceptance: false,
				...(structured ? { structuredOutputSchema: schema } : {}),
			});
			assert.equal(result.isError, true);
			assert.match(result.content[0]!.text, /captured detached spawn/);
			assert.equal(spawn.mock.callCount(), runIds.length);
			assert.ok(step);
			assert.equal(step.acceptanceRole, role, "the serialized runner step must preserve the role");
			assert.equal(step.parentSessionId, "review-role-parent");
			assert.deepEqual(step.structuredOutputSchema, structured ? schema : undefined);
			const launch = buildRunnerChildLaunch(step, { cwd: root, id, flatIndex: 0 }, {
				sessionEnabled: false, watchdogStatus() {},
				...(structured ? { structuredOutput: { schema: step.structuredOutputSchema! } } : {}),
			});
			assert.equal(launch.config.retainReportCorrection, role === "read-only" && structured ? true : undefined);
		}
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		for (const file of configPaths) fs.rmSync(file, { force: true });
		for (const id of runIds) fs.rmSync(path.join(DIRS.async, id), { recursive: true, force: true });
		fs.rmSync(root, { recursive: true, force: true });
	}
});
