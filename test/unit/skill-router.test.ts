import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const skillPath = path.join(repoRoot, "skills/pi-subagents/SKILL.md");

describe("pi-subagents skill router", () => {
	it("excludes one routine scout or reviewer from skill loading", () => {
		const skill = fs.readFileSync(skillPath, "utf-8");

		assert.match(
			skill,
			/Do not use for one ordinary read-only quick-scout or\s+quick-review launch/,
		);
		assert.match(
			skill,
			/do not load this\s+skill or its references/,
		);
		assert.doesNotMatch(skill, /routine-launches\.md/);
	});
});
