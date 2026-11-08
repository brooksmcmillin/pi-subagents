import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { createStructuredOutputRuntime } from "../../src/runs/shared/structured-output.ts";

const secret = "credential-and-private-prompt-MUST-NOT-APPEAR";

describe("structured-output factory startup gate", () => {
	for (const fault of ["registration", "inactive", "inline-load", "startup-handler"] as const) {
		it(`rejects ${fault} failure before any model request with safe runtime diagnostics`, async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-structured-startup-"));
			const previous = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
			const faux = fauxProvider({ provider: "startup-probe", models: [{ id: "local" }] });
			faux.setResponses([fauxAssistantMessage("must not run")]);
			let shutdowns = 0;
			const launch = buildInProcessChildLaunch({
				host: "parent", cwd: root, runId: "startup-run", childAgentName: "quick-review", childIndex: 0,
				sessionEnabled: false, waitToolEnabled: false, tools: ["read", "bash"], model: "startup-probe/local",
				inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
				structuredOutput: createStructuredOutputRuntime({ type: "object" }, root),
			});
			const hooks = launch.session.hooks.map((hook) => hook.name !== "pi-subagents:prompt-runtime" ? hook : {
				...hook,
				factory: (api: ExtensionAPI) => {
					if (fault === "inline-load") throw new SyntaxError(secret);
					if (fault === "startup-handler") api.on("session_start", () => { throw new TypeError(secret); });
					return hook.factory(new Proxy(api, {
						get(target, property) {
							if (property === "registerTool") return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
								if (tool.name === "structured_output" && fault === "registration") return;
								target.registerTool(tool.name === "structured_output" && fault === "inactive" ? { ...tool, exposure: "hidden" } : tool);
							};
							return Reflect.get(target, property, target);
						},
					}));
				},
			});
			hooks.push({ name: "probe", factory: (api) => {
				api.registerProvider(faux.provider);
				api.on("session_shutdown", () => { shutdowns++; });
			} });
			const reported: unknown[] = [];
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: () => import("@earendil-works/pi-coding-agent") });
			try {
				await assert.rejects(factory.create({ ...launch.session, hooks, onExtensionError: (error) => { reported.push(error); } }), (error: Error) => {
					assert.match(error.message, /^Structured-output child startup failed:/);
					const diagnostic = JSON.parse(error.message.slice(error.message.indexOf("{")));
					assert.ok(diagnostic.required.includes("structured_output"));
					assert.ok(Array.isArray(diagnostic.registered));
					assert.ok(Array.isArray(diagnostic.active));
					assert.match(diagnostic.sdk, /@earendil-works\/pi-coding-agent@/);
					assert.equal(diagnostic.runner, "in-process");
					assert.equal(diagnostic.pid, process.pid);
					assert.equal(diagnostic.runId, "startup-run");
					assert.equal(diagnostic.agent, "quick-review");
					assert.equal(diagnostic.childIndex, 0);
					if (fault === "registration") assert.ok(!diagnostic.registered.includes("structured_output"));
					if (fault === "inactive") {
						assert.ok(diagnostic.registered.includes("structured_output"));
						assert.ok(!diagnostic.active.includes("structured_output"));
					}
					if (fault === "inline-load" || fault === "startup-handler") {
						assert.equal(diagnostic.extensionErrors[0].event, fault === "inline-load" ? "load" : "session_start");
						// Pi projects these exceptions to message-only strings.
						assert.equal(diagnostic.extensionErrors[0].kind, "ExtensionError");
						assert.match(diagnostic.extensionErrors[0].fingerprint, /^[a-f0-9]{64}$/);
					}
					assert.ok(error.message.length < 6000);
					assert.ok(!error.message.includes(secret));
					return true;
				});
				assert.equal(faux.state.callCount, 0);
				assert.equal(shutdowns, fault === "inline-load" ? 0 : 1);
				assert.ok(!JSON.stringify(reported).includes(secret));
			} finally {
				await factory.dispose();
				if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previous;
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}
});
