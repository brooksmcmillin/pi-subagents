import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseExpressionAt } from "acorn";
import { readSubagentGuide } from "../../src/extension/subagent-guide.ts";
import { SubagentParams } from "../../src/extension/schemas.ts";
import { SUBAGENT_ACTIONS } from "../../src/shared/types.ts";

const skillDir = path.resolve(import.meta.dirname, "..", "..", "skills", "pi-subagents");
const skillFiles = ["SKILL.md", ...fs.readdirSync(path.join(skillDir, "references")).map((name) => path.join("references", name))];
const read = (file: string): string => fs.readFileSync(path.join(skillDir, file), "utf-8");
const packageExports = JSON.parse(fs.readFileSync(path.join(skillDir, "../../package.json"), "utf-8")).exports;

function checkCallFields(source: string, file: string): void {
	for (const call of source.matchAll(/^[ \t]*(?:(?:const|let) \w+ = )?subagent\((?=\s*\{)/gm)) {
		const input = parseExpressionAt(source, call.index + call[0].length, { ecmaVersion: "latest" });
		assert.equal(input.type, "ObjectExpression");
		for (const property of input.properties) {
			assert.ok(property.type === "Property" && !property.computed && property.key.type === "Identifier", `${file}: expected a named subagent field`);
			const field = property.key.name;
			assert.ok(Object.hasOwn(SubagentParams.properties, field), `${file}: subagent field ${field}`);
		}
	}
}

it("checks assigned and multiline calls without confusing strings and nested options for fields", () => {
	checkCallFields(`const run = subagent({\n  options: { script: 'return runs.run("check", { agent: "scout" })' },\n})`, "fixture");
	assert.throws(() => checkCallFields("const run = subagent({\n  workflowScript: 'return 1',\n})", "fixture"), /subagent field workflowScript/);
});

// The skill points agents at tool lookups instead of copying them, so every name it uses must exist in the tool.
describe("pi-subagents skill names resolve in the tool", () => {
	for (const file of skillFiles) {
		it(`${file} names only real guide sections, actions, links, and call fields`, () => {
			const text = read(file);
			for (const [, address] of text.matchAll(/`([a-z][a-z-]*\/[a-z0-9-]+)`/g)) {
				if (address === "provider/id" || address === "provider/model") continue;
				if (address!.startsWith("pi-subagents/")) {
					assert.ok(Object.hasOwn(packageExports, address!.replace("pi-subagents/", "./")), `${file}: package export ${address}`);
				} else {
					assert.doesNotMatch(readSubagentGuide(address!), /^Unknown (subagents guide topic|section)/, `${file}: guide section ${address}`);
				}
			}
			for (const [, action] of text.matchAll(/subagent\(\{\s*action: "([^"]+)"/g)) {
				assert.ok((SUBAGENT_ACTIONS as readonly string[]).includes(action!), `${file}: action ${action}`);
			}
			for (const [, target] of text.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)) {
				assert.ok(fs.existsSync(path.resolve(skillDir, path.dirname(file), target!)), `${file}: link ${target}`);
			}
			checkCallFields(text, file);
		});
	}
});
