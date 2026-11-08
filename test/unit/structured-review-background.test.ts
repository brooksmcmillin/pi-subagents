import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../../src/agents/agents.ts";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import registerSubagentNotify, { type CompletionNotification } from "../../src/runs/background/notify.ts";
import { resultFilePath } from "../../src/runs/background/result-files.ts";
import { DEFAULT_ARTIFACT_CONFIG, DIRS } from "../../src/shared/types.ts";
import { createEventBus } from "../support/helpers.ts";
import { report } from "../fixtures/structured-review/provider.ts";

async function waitForJson(file: string): Promise<any> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Fixture timed out waiting for ${file}`);
}

// Real discovery -> detached runner -> SDK -> validated tool -> disk -> parent notifier.
// Only the model is deterministic; no scripted ChildSessionFactory or SDK shim.
it("delivers a real named quick-review structured report through the background seam", { timeout: 90_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "structured-review-background-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	const fixture = fileURLToPath(new URL("../fixtures/structured-review/", import.meta.url));
	const schema = {
		type: "object", additionalProperties: false, required: ["status", "scopeChecked", "findings", "next", "blockedReason"],
		properties: { status: { type: "string", enum: ["clean"] }, scopeChecked: { type: "string" }, findings: { type: "array", maxItems: 0 }, next: { type: "string" }, blockedReason: { type: "string" } },
	};
	try {
		const definitions = path.join(root, ".pi", "agents");
		fs.mkdirSync(definitions, { recursive: true });
		fs.copyFileSync(path.join(fixture, "quick-review.md"), path.join(definitions, "quick-review.md"));
		const agent = discoverAgents(root, "project", undefined, { projectTrusted: true }).agents.find((agent) => agent.name === "quick-review");
		assert.ok(agent, "load the named review definition with the real parser");
		assert.deepEqual(agent.tools, ["read", "grep", "find", "ls", "bash"], "no static structured_output workaround");
		for (const structured of [true, false]) {
			const cwd = path.join(root, structured ? "structured" : "ordinary");
			fs.mkdirSync(cwd);
			if (structured) fs.writeFileSync(path.join(cwd, "requires-structured"), "");
			const id = randomUUID();
			const sessionId = `parent-${id}`;
			const owner = `owner-${id}`;
			const events = createEventBus();
			const launch = await executeAsyncSingle(id, {
				agent: agent.name, task: "Review the bounded fixture.",
				agentConfig: { ...agent, extensions: [], subagentOnlyExtensions: [path.join(fixture, "provider.ts")] },
				ctx: { pi: { events } as unknown as ExtensionAPI, cwd, currentSessionId: sessionId, completionOwnerId: owner, projectTrusted: true },
				modelOverride: "structured-review-fixture/local", context: "fresh", output: structured ? path.join(cwd, "report.json") : false,
				outputMode: structured ? "file-only" : "inline", structuredOutputSchema: structured ? schema : undefined,
				artifactConfig: DEFAULT_ARTIFACT_CONFIG, artifactsDir: path.join(cwd, "artifacts"), sessionRoot: path.join(cwd, "sessions"),
				shareEnabled: false, maxSubagentDepth: 1, waitToolEnabled: false, timeoutMs: 25_000,
			});
			assert.notEqual(launch.isError, true, JSON.stringify(launch));
			const payload = await waitForJson(resultFilePath(DIRS.results, id));
			assert.equal(payload.success, true, JSON.stringify(payload));
			const request = await waitForJson(path.join(cwd, "request.json"));
			assert.notEqual(request.pid, process.pid, "a real detached runner hosted the child");
			assert.equal(request.tools.includes("structured_output"), structured);
			assert.equal((await waitForJson(path.join(cwd, "shutdown.json"))).requests, 1, "no report-only recovery or extra provider call");
			const notices: Array<{ content: string }> = [];
			const notifier = registerSubagentNotify({ events, isHeld: () => false, sendMessage: (message) => { notices.push(message); return false; } },
				{ currentSessionId: sessionId, completionOwnerId: owner }, { batchConfig: { enabled: false } });
			try {
				assert.equal(await notifier.deliver(payload as CompletionNotification), true);
				assert.equal(notices.length, 1);
				if (structured) {
					assert.deepEqual(payload.results[0].structuredOutput, report);
					assert.deepEqual(request.parameters.properties.value, schema, "the first request declares the required schema");
					assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, "report.json"), "utf8")), report);
					assert.match(notices[0]!.content, /report\.json/);
				} else {
					assert.equal(payload.results[0].structuredOutput, undefined);
					assert.match(notices[0]!.content, /ordinary fixture response/);
				}
			} finally { notifier.dispose(); }
			await waitForJson(path.join(launch.details.asyncDir!, "process-terminal.json"));
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
