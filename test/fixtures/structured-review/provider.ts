import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const report = { status: "clean", scopeChecked: "fixture startup plumbing", findings: [], next: "none", blockedReason: "" };

export default function registerFixture(pi: ExtensionAPI): void {
	let cwd: string;
	const faux = fauxProvider({ provider: "structured-review-fixture", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses([(context) => {
		const tools = getCurrentTools(context.messages);
		const structured = tools.find((tool) => tool.name === "structured_output");
		const expected = fs.existsSync(path.join(cwd, "requires-structured"));
		assert.equal(Boolean(structured), expected, "required tool must reach the first model request");
		fs.writeFileSync(path.join(cwd, "request.json"), JSON.stringify({ tools: tools.map((tool) => tool.name), parameters: structured?.parameters, sdk: VERSION, pid: process.pid }));
		return expected
			? fauxAssistantMessage(fauxToolCall("structured_output", { value: report }), { stopReason: "toolUse" })
			: fauxAssistantMessage("ordinary fixture response");
	}]);
	pi.registerProvider(faux.provider);
	pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; });
	pi.on("session_shutdown", () => { fs.writeFileSync(path.join(cwd, "shutdown.json"), JSON.stringify({ requests: faux.state.callCount })); });
}
