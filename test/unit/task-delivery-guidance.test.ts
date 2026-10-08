import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { runWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

const recipePath = "skills/pi-subagents/references/task-delivery.md";
const read = (path: string) => readFileSync(resolve(path), "utf8");
const recipe = read(recipePath);
const skill = read("skills/pi-subagents/SKILL.md");
const script = recipe.match(/```js workflow\n([\s\S]*?)\n```/)?.[1];
assert.ok(script, "recipe must include the executable two-stage example");

// Prose guards and fake launches prove documentation composition, not model compliance.
test("compact route is discoverable without unconditional broad reference loading", () => {
	assert.match(skill, /Compact task delivery.*references\/task-delivery.md/);
	assert.match(skill, /Do not preload the broad references/);
	assert.doesNotMatch(skill, /For an authorized complex delegated workflow, read/);
	for (const file of ["docs/workflows.md", "prompts/review-loop.md"]) {
		assert.match(read(file), /task-delivery.md/);
	}
	for (const match of recipe.matchAll(/\]\(([^)]+)\)/g)) {
		assert.ok(existsSync(resolve(dirname(recipePath), match[1].split("#")[0])), match[1]);
	}
	assert.match(recipe, /Multiple independent contracts require the multi-lane branch/);
	assert.match(recipe, /Read an advanced branch.*only when its trigger applies/s);
});

test("mandatory contracts survive the compact route", () => {
	for (const pattern of [
		/Confirm delegation authority/, /Parent owns scope, decisions, acceptance/,
		/canonical cwd.*Git root\/common-dir/s, /uncertain or foreign ownership blocks/,
		/one writer per canonical cwd\/worktree/, /old writer terminal/,
		/same explicit cwd\/scope/, /cold-start packet/, /capability ceilings/,
		/quiescent, pinned candidate/, /context: "fresh"/, /review run may still report blockers/,
		/same-protocol retry/, /fallback.*needs owner\n\s*approval/s,
		/Never\n\s*rewrite a failed run as successful/, /Missing records mean unknown/,
		/request only missing evidence/, /rerun affected\n\s*validation/,
		/Quiet\/needs-attention is not terminal proof/, /record the completion wake trigger and yield/,
		/actual push remote/, /Unknown requirements\n\s*are not an empty requirement set/,
		/open required PR is under review/, /cleanup additionally requires its own authority/,
	]) assert.match(recipe, pattern);
});

test("simple-path reference payload stays below 25000 characters", (t) => {
	const chars = [...skill].length + [...recipe].length;
	const baseline = 149_000; // Approximate observed historical references, not total session tokens.
	t.diagnostic(JSON.stringify({ characters: chars, observedBaseline: baseline,
		reductionPercent: Number((100 * (1 - chars / baseline)).toFixed(1)) }));
	assert.ok(chars < 25_000, `compact route grew to ${chars} characters`);
});

for (const writerOk of [true, false]) {
	test(`offline two-stage recipe replay: writer ${writerOk ? "completes" : "fails"}`, async () => {
		const launches: Array<{ key: string; params: Record<string, unknown> }> = [];
		const execution = runWorkflowScript({
			script,
			args: { cwd: "/fixture/verified-worktree", writerPacket: "Approved bounded implementation",
				reviewPacket: "Read-only review; verify candidate identity" },
			async launch(key, params) {
				launches.push({ key, params });
				return { key, ok: key === "delivery-write" ? writerOk : true,
					output: "candidate tree abc; focused checks pass; finding needs parent disposition",
					runId: `${key}-run`, artifactPaths: [] };
			},
			async status() { throw new Error("recipe must not poll"); },
		});
		if (!writerOk) {
			await assert.rejects(execution, /Run 'delivery-write' failed/);
			assert.deepEqual(launches.map(({ key }) => key), ["delivery-write"]);
			return;
		}
		const result = await execution;
		assert.deepEqual(launches.map(({ key }) => key), writerOk
			? ["delivery-write", "delivery-review"] : ["delivery-write"]);
		for (const { params } of launches) {
			assert.equal(params.cwd, "/fixture/verified-worktree");
			assert.equal(params.context, "fresh");
			assert.equal(params.async, undefined, "await must consume a completed result");
			assert.match(String(params.output), /^delivery\//);
			assert.ok(params.label);
		}
		assert.match(String(launches[1].params.task), /candidate tree abc/);
		assert.equal((result.value as { stage: string }).stage, "parent-disposition");
	});
}
