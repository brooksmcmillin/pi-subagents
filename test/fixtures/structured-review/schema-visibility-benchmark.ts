import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagentPromptRuntime from "../../../src/runs/shared/subagent-prompt-runtime.ts";
import { specialistSchema } from "./specialist-schema.ts";
import { structuredOutputValidatorReady } from "../../../src/runs/shared/structured-output.ts";

// Opt-in live benchmark, never loaded by the test glob. No request bodies or credentials are retained.
export default async function benchmark(pi: ExtensionAPI): Promise<void> {
	await structuredOutputValidatorReady();
	const output = process.env.PI_SCHEMA_BENCHMARK_OUTPUT;
	assert.ok(output, "Set PI_SCHEMA_BENCHMARK_OUTPUT to a new result path");
	assert.ok(!fs.existsSync(output), "Refusing to overwrite benchmark evidence");
	const simulateIncompleteTypes = process.env.PI_SCHEMA_BENCHMARK_INCOMPLETE_TYPES === "1";
	let description = "";
	let parameters: unknown;
	let value: unknown;
	let requests = 0;
	let presentedRequests = 0;
	let calls = 0;
	let errors = 0;
	const errorMessages: string[] = [];
	registerSubagentPromptRuntime(new Proxy(pi, {
		get(target, key) {
			if (key !== "registerTool") return Reflect.get(target, key);
			return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
				if (tool.name === "structured_output") {
					description = tool.description;
					parameters = tool.parameters;
					// Simulate incomplete model-facing types only; raw-value validation stays intact.
					if (simulateIncompleteTypes) tool = { ...tool, parameters: { type: "object", properties: { value: {} }, required: ["value"] } } as typeof tool;
				}
				target.registerTool(tool);
			};
		},
	}), { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false,
		structuredOutput: { schema: specialistSchema, capture: (report) => { value = report; } },
	});
	pi.on("before_provider_request", (event) => {
		requests++;
		const hasDescription = (node: unknown): boolean => {
			if (!node || typeof node !== "object") return false;
			if ((node as { description?: unknown }).description === description) return true;
			return Object.values(node).some(hasDescription);
		};
		if (hasDescription(event.payload)) presentedRequests++;
	});
	pi.on("tool_execution_end", (event) => {
		calls++;
		if (event.isError) {
			errors++;
			errorMessages.push(JSON.stringify(event.result.content).slice(0, 2000));
		}
	});
	pi.on("agent_end", (_event, ctx) => {
		fs.writeFileSync(output, JSON.stringify({
			observedAt: new Date().toISOString(), model: { provider: ctx.model?.provider, id: ctx.model?.id, api: ctx.model?.api },
			schemaSha256: createHash("sha256").update(JSON.stringify(specialistSchema)).digest("hex"),
			argumentSchemaBytes: Buffer.byteLength(JSON.stringify(parameters)), descriptionBytes: Buffer.byteLength(description),
			simulateIncompleteTypes, requests, presentedRequests, calls, errors, errorMessages, value,
			passed: value !== undefined && calls === 1 && errors === 0 && requests === 1 && presentedRequests === 1,
		}, null, 2) + "\n", { mode: 0o600 });
	});
}
