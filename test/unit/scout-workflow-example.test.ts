import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { runWorkflowScript, validateWorkflowScript } from "../../src/workflows/scripted-workflow.ts";
import { normalizeWorkflowArgs } from "../../src/workflows/workflow-resources.ts";

for (const lineEnding of ["\n", "\r\n"]) it(`executes the shared-schema scout example with ${lineEnding === "\n" ? "LF" : "CRLF"} line endings`, async () => {
	const docs = readFileSync(new URL("../../docs/workflows.md", import.meta.url), "utf8").replace(/\r?\n/g, lineEnding);
	const section = docs.split(/### Reuse scouting output contracts\r?\n/)[1]!.split("### Named workflow resources")[0]!;
	const input = JSON.parse(section.match(/```json\r?\n([\s\S]*?)\r?\n```/)![1]!);
	assert.equal(input.action, "validate");
	assert.equal("error" in normalizeWorkflowArgs(input.args), false);
	assert.equal(validateWorkflowScript(input.options.script).ok, true);
	const launches: Array<{ key: string; params: Record<string, unknown> }> = [];
	const result = await runWorkflowScript({
		script: input.options.script,
		args: input.args,
		async launch(key, params) {
			launches.push({ key, params });
			return {
				key, ok: true, output: "", runId: `run-${key}`, artifactPaths: [`${key}.json`],
				structuredOutput: { status: "ready", summary: key, evidence: ["src/example.ts:1"] },
			};
		},
		async status() { throw new Error("Example must not poll"); },
	});
	assert.deepEqual(launches.map(({ key }) => key), ["boundary", "client"]);
	for (const { key, params } of launches) {
		assert.deepEqual(params.outputSchema, input.args.outputSchema);
		assert.equal(params.output, `${key}.json`);
		assert.equal(params.outputMode, "file-only");
		assert.equal(params.context, "fresh");
	}
	assert.deepEqual(result.value, ["boundary", "client"].map(key => ({
		key, report: { status: "ready", summary: key, evidence: ["src/example.ts:1"] },
		artifacts: [`${key}.json`], runId: `run-${key}`,
	})));
});
