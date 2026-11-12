import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it, type TestContext } from "node:test";
import { ExtensionRunner, SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { setChildSessionFactory, type ChildSessionFactory, type ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { correctRetainedReport } from "../../src/runs/shared/report-correction.ts";
import { registerReportCorrectionSource, reviewSubject, REPORT_CORRECTION_SOURCE } from "../../src/runs/shared/report-correction-source.ts";
import { createStructuredOutputRuntime } from "../../src/runs/shared/structured-output.ts";

const schema = { type: "object", additionalProperties: false, required: ["status", "scopeChecked", "findings", "blockedReason"], properties: {
	status: { type: "string", enum: ["clean", "findings", "blocked"] }, scopeChecked: { type: "string", minLength: 1 },
	findings: { type: "array", items: { type: "object", required: ["severity", "evidence", "impact"], properties: { severity: { type: "string", enum: ["blocker", "risk", "note"] }, evidence: { type: "string" }, impact: { type: "string" } } } }, blockedReason: { type: "string" },
}, allOf: [{ if: { properties: { status: { const: "clean" } } }, then: { properties: { findings: { maxItems: 0 }, blockedReason: { maxLength: 0 } } } },
	{ if: { properties: { status: { const: "blocked" } } }, then: { properties: { blockedReason: { minLength: 1 } } } }] };
const clean = { status: "clean", scopeChecked: "fixture.ts:1 inspected in the retained read result", findings: [], blockedReason: "" };
const formatBlocked = { ...clean, status: "blocked", blockedReason: "Could not format the report for the schema." };

function fixture(t: TestContext, options: { rejected?: boolean; original?: unknown; inspected?: boolean; readOnly?: boolean; interrupted?: boolean; submodule?: boolean; historicalInspection?: boolean; compactHistory?: boolean } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-correction-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const cwd = path.join(root, "repo"); fs.mkdirSync(cwd);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q"); fs.writeFileSync(path.join(cwd, "fixture.ts"), "export const stable = true;\n");
	git("add", "fixture.ts"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "review subject");
	if (options.submodule) {
		const seed = path.join(root, "module-seed"); fs.mkdirSync(seed);
		const moduleGit = (...args: string[]) => execFileSync("git", args, { cwd: seed, stdio: "ignore" });
		moduleGit("init", "-q"); fs.writeFileSync(path.join(seed, "child.ts"), "export const child = true;\n");
		moduleGit("add", "child.ts"); moduleGit("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "module");
		git("-c", "protocol.file.allow=always", "submodule", "add", "-q", seed, "module");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qam", "add module");
		fs.appendFileSync(path.join(cwd, "module", "child.ts"), "// first dirty content\n");
	}
	const original = options.original ?? (options.rejected ? { ...clean, status: "invalid" } : formatBlocked);
	const historical = options.historicalInspection || options.compactHistory ? [{ role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "different subject inspected during an earlier launch" }] },
		...(options.compactHistory ? Array.from({ length: 10 }, () => fauxAssistantMessage("earlier-launch history")) : [])] : [];
	const messages = [
		...historical,
		...(options.inspected === false ? [] : [{ role: "toolResult", toolName: "read", toolCallId: "inspect", isError: false, content: [{ type: "text", text: "fixture.ts:1 export const stable = true;" }] }]),
		{ ...fauxAssistantMessage(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "submit", name: "structured_output", arguments: { value: original } }] },
		{ role: "toolResult", toolName: "structured_output", toolCallId: "submit", isError: options.rejected === true, content: [{ type: "text", text: options.rejected ? "Structured output validation failed: status: must be one of clean, findings, blocked" : "Structured output captured." }] },
		...(options.rejected ? [fauxAssistantMessage("I could not format the report; retained inspection is above.")] : []),
	];
	const entries: Record<string, unknown>[] = [{ type: "session", version: 3, id: "review-session", cwd, timestamp: new Date().toISOString() }];
	let parentId: string | null = null;
	for (const message of messages) { const id = `message-${entries.length}`; entries.push({ type: "message", id, parentId, timestamp: new Date().toISOString(), message }); parentId = id; }
	const initialEntries = entries.slice(0, historical.length + 1) as FileEntry[];
	if (options.compactHistory) {
		const id = "compaction";
		entries.push({ type: "compaction", id, parentId, timestamp: new Date().toISOString(), summary: "Earlier history summarized", firstKeptEntryId: entries[historical.length + 1]!.id, tokensBefore: 10000 });
		parentId = id;
	}
	const source = path.join(root, "source.jsonl");
	const append = (type: string, data: unknown) => { const id = `entry-${entries.length}`; entries.push({ type: "custom", customType: type, data, id, parentId, timestamp: new Date().toISOString() }); parentId = id; };
	const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const launch = buildInProcessChildLaunch({ cwd, host: "parent", childAgentName: "quick-review", childIndex: 0, runId: "source-run", parentSessionId: "parent-session", sessionEnabled: true,
		inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, readOnlyReview: options.readOnly !== false,
		structuredOutput: createStructuredOutputRuntime(schema, root) });
	launch.config.structuredOutput!.terminalState!.captured = !options.rejected;
	registerReportCorrectionSource({ on(name: string, handler: typeof hooks extends Map<string, infer H> ? H : never) { hooks.set(name, handler); }, appendEntry: append } as never, launch.config);
	hooks.get("session_start")?.({}, { sessionManager: SessionManager.inMemory(undefined, undefined, initialEntries) });
	hooks.get("agent_settled")?.({ aborted: options.interrupted === true }, { model: { provider: "fixture", id: "reviewer" }, hasPendingMessages: () => false,
		sessionManager: SessionManager.inMemory(undefined, undefined, entries as FileEntry[]) });
	fs.writeFileSync(source, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const artifact = path.join(root, "original-report.json"); fs.writeFileSync(artifact, JSON.stringify(original));
	return { root, cwd, source, artifact, git, original, entries };
}

function factory(report: unknown, options: { forbidden?: string; lateForbidden?: string; before?: () => void | Promise<void>; queued?: boolean } = {}) {
	let launches = 0;
	const value: ChildSessionFactory = {
		async create(launch: ChildSessionLaunch) {
			launches++;
			assert.deepEqual(launch.tools, []); assert.equal(launch.ambientExtensions, false); assert.equal(launch.noSkills, true); assert.equal(launch.noContextFiles, true);
			const handlers = new Map<string, Array<(event: unknown) => unknown>>();
			let submit!: (id: string, params: { value: unknown }) => Promise<unknown>;
			const pi = { on(name: string, handler: (event: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
				registerTool(tool: { name: string; execute: typeof submit }) { if (tool.name === "structured_output") submit = tool.execute; }, events: { on() {} } };
			for (const hook of launch.hooks) await hook.factory(pi as never);
			const runner = Object.assign(Object.create(ExtensionRunner.prototype) as ExtensionRunner, { extensions: [{ handlers }], createContext: () => ({}) });
			return { messages: [], sessionFile: launch.storage.kind === "file" ? launch.storage.sessionFile : undefined, sessionId: "correction-session", modelId: "fixture/reviewer",
				async prompt(text: string) {
					assert.match(text, /not an instruction to return clean/); assert.match(text, /Do not repeat inspection/);
					await options.before?.();
					if (options.forbidden) { const gate = await runner.emitToolCall({ type: "tool_call", toolName: options.forbidden, toolCallId: "forbidden", input: {} }); assert.equal(gate?.block, true); }
					await submit("corrected-report", { value: report });
					if (options.lateForbidden) { const gate = await runner.emitToolCall({ type: "tool_call", toolName: options.lateForbidden, toolCallId: "late-forbidden", input: {} }); assert.equal(gate?.block, true); }
				},
				async steer() {}, async followUp() {}, async abort() {}, async dispose() {}, hasQueuedMessages: () => options.queued === true,
			};
		}, async dispose() {}, async disposeForParent() {},
	};
	return { value, launches: () => launches };
}

function request(f: ReturnType<typeof fixture>, stub: ReturnType<typeof factory>, extra: Partial<Parameters<typeof correctRetainedReport>[0]> = {}) {
	return correctRetainedReport({ runId: "source-run", parentSessionId: "parent-session", sourceSessionFile: f.source,
		reason: "Reassess the suspected report-format explanation from retained evidence, not fresh inspection.", timeoutMs: 5_000,
		assertTerminal() {}, factory: stub.value, ...extra });
}

for (const rejected of [true, false]) {
	it(`PR57-style ${rejected ? "rejected submission" : "captured erroneous blocker"} obtains a substantive decision without rewriting prior evidence`, async (t) => {
		const f = fixture(t, { rejected }); const before = fs.readFileSync(f.source); const original = fs.readFileSync(f.artifact);
		const stub = factory(clean); const result = await request(f, stub);
		assert.equal(result.sourceState, rejected ? "rejected" : "captured-blocked"); assert.equal(result.status, "unassessed"); assert.deepEqual(result.proposedReport, clean);
		assert.deepEqual(result.original, f.original); assert.equal(stub.launches(), 1);
		assert.deepEqual(fs.readFileSync(f.source), before); assert.deepEqual(fs.readFileSync(f.artifact), original);
		assert.deepEqual(JSON.parse(fs.readFileSync(result.artifactPath, "utf8")), result);
		assert.deepEqual(fs.readFileSync(result.sessionFile), before, "the provider seam is simulated; source transcript was copied verbatim");
		assert.equal(fs.statSync(result.artifactPath).mode & 0o777, 0o600);
	});
}

it("real missing coverage remains an explicit blocked report, not a successful-format clean conversion", async (t) => {
	const gap = { ...formatBlocked, scopeChecked: "fixture.ts:1 only; integration behavior was not inspected", blockedReason: "Missing integration coverage." };
	const f = fixture(t, { original: gap }); const result = await request(f, factory(gap));
	assert.equal((result.proposedReport as typeof gap).status, "blocked"); assert.deepEqual(result.original, gap);
});

it("an unsupported clean proposal cannot erase the original coverage blocker or become a ready-review receipt", async (t) => {
	const gap = { ...formatBlocked, blockedReason: "Integration coverage was not inspected." };
	const f = fixture(t, { original: gap }); const source = fs.readFileSync(f.source);
	const result = await request(f, factory(clean));
	assert.equal(result.status, "unassessed"); assert.equal((result.proposedReport as typeof clean).status, "clean");
	assert.deepEqual(result.original, gap); assert.deepEqual(fs.readFileSync(f.source), source);
	assert.equal("structuredOutput" in result, false, "a proposal is not a normal authoritative child result");
});

it("rejected malformed findings can be shape-repaired while preserving their original substance", async (t) => {
	const malformed = { severity: "critical", evidence: "fixture.ts:1", impact: "Incorrect export" };
	const original = { ...clean, status: "findings", findings: [malformed] };
	const corrected = { ...original, findings: [{ ...malformed, severity: "blocker" }] };
	const f = fixture(t, { rejected: true, original }); const result = await request(f, factory(corrected));
	assert.equal(result.status, "unassessed"); assert.deepEqual(result.original, original); assert.deepEqual(result.proposedReport, corrected);
	await assert.rejects(request(f, factory(clean)), /cannot remove or rewrite/);
});

it("two different dirty submodule contents cannot reuse the same parent gitlink evidence", async (t) => {
	const f = fixture(t, { submodule: true }); const before = f.git("diff", "HEAD");
	fs.appendFileSync(path.join(f.cwd, "module", "child.ts"), "// second dirty content\n");
	assert.equal(f.git("diff", "HEAD"), before, "the parent's dirty-gitlink diff is unchanged");
	const stub = factory(clean); await assert.rejects(request(f, stub), /subject changed|unavailable/); assert.equal(stub.launches(), 0);
});

it("nested tracked-file flags remain visibly ineligible", async (t) => {
	const f = fixture(t, { submodule: true });
	f.git("-C", path.join(f.cwd, "module"), "update-index", "--assume-unchanged", "child.ts");
	await assert.rejects(request(f, factory(clean)), /subject changed|unavailable/);
});

it("substantive findings cannot be erased or rewritten", async (t) => {
	const f = fixture(t, { original: { ...formatBlocked, findings: [{ severity: "blocker", evidence: "fixture.ts:1", impact: "Incorrect export" }] } });
	await assert.rejects(request(f, factory(clean)), /cannot remove or rewrite/);
});

for (const tool of ["read", "write", "edit", "bash", "subagent", "mcp", "contact_supervisor"]) {
	it(`native dispatch denies ${tool} during correction and cannot publish a clean artifact afterward`, async (t) => {
		const f = fixture(t); const before = fs.readFileSync(path.join(f.cwd, "fixture.ts"));
		await assert.rejects(request(f, factory(clean, { forbidden: tool })), /only structured_output/);
		assert.deepEqual(fs.readFileSync(path.join(f.cwd, "fixture.ts")), before);
	});
}

for (const scenario of ["no-inspection", "writer", "clean", "aborted"]) {
	it(`${scenario} source cannot fabricate retained-review eligibility`, async (t) => {
		const f = fixture(t, { inspected: scenario !== "no-inspection", readOnly: scenario !== "writer", interrupted: scenario === "aborted", ...(scenario === "clean" ? { original: clean } : {}) });
		const stub = factory(clean); await assert.rejects(request(f, stub), /no eligible retained/); assert.equal(stub.launches(), 0);
	});
}

for (const mismatch of [{ runId: "unrelated-run" }, { parentSessionId: "other-owner" }]) {
	it(`refuses unrelated identity ${JSON.stringify(mismatch)}`, async (t) => {
		const f = fixture(t); const stub = factory(clean); await assert.rejects(request(f, stub, mismatch), /run or owner does not match/); assert.equal(stub.launches(), 0);
	});
}

for (const mutation of ["HEAD", "base", "index", "working", "untracked", "assume-unchanged", "skip-worktree"]) {
	for (const during of [false, true]) {
		it(`refuses ${mutation} subject change ${during ? "during correction" : "before launch"}`, async (t) => {
			const f = fixture(t);
			const mutate = () => {
				if (mutation === "HEAD") f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "changed HEAD");
				else if (mutation === "base") f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD"));
				else if (mutation === "index") { const blob = f.git("hash-object", "-w", "--stdin"); f.git("update-index", "--cacheinfo", "100644", blob, "fixture.ts"); }
				else if (mutation === "working") fs.appendFileSync(path.join(f.cwd, "fixture.ts"), "// changed\n");
				else if (mutation === "untracked") fs.writeFileSync(path.join(f.cwd, "new.ts"), "unreviewed");
				else f.git("update-index", `--${mutation}`, "fixture.ts");
			};
			if (!during) mutate();
			const stub = factory(clean, during ? { before: mutate } : {});
			await assert.rejects(request(f, stub), /subject changed|unavailable/);
			if (!during) assert.equal(stub.launches(), 0);
		});
	}
}

it("retained transcript changes invalidate publication", async (t) => {
	const f = fixture(t); await assert.rejects(request(f, factory(clean, { before: () => fs.appendFileSync(f.source, "\n") })), /source evidence changed/);
});

it("live, paused or changed source admission cannot be bypassed", async (t) => {
	const f = fixture(t); const stub = factory(clean);
	await assert.rejects(request(f, stub, { assertTerminal() { throw new Error("Source is live"); } }), /Source is live/); assert.equal(stub.launches(), 0);
});

it("session lease prevents duplicate live report correctors", async (t) => {
	const f = fixture(t); let release!: () => void; let started!: () => void;
	const entered = new Promise<void>((resolve) => { started = resolve; });
	const hold = new Promise<void>((resolve) => { release = resolve; });
	const first = request(f, factory(clean, { before: async () => { started(); await hold; } }));
	await entered;
	const second = factory(clean); await assert.rejects(request(f, second), /lease|owned|already/i); assert.equal(second.launches(), 0);
	release(); await first;
});

it("queued input prevents publication despite a schema-valid report", async (t) => {
	const f = fixture(t); await assert.rejects(request(f, factory(clean, { queued: true })), /incomplete|interrupted/);
});

it("a post-submission forbidden native tool call prevents amendment publication", async (t) => {
	const f = fixture(t); await assert.rejects(request(f, factory(clean, { lateForbidden: "bash" })), /only structured_output/);
	const corrections = path.join(f.root, "report-corrections");
	for (const entry of fs.readdirSync(corrections)) assert.equal(fs.existsSync(path.join(corrections, entry, "correction.json")), false);
});

it("source evidence is branch-bound, not an abandoned custom entry", async (t) => {
	const f = fixture(t); const header = f.entries[0];
	fs.appendFileSync(f.source, JSON.stringify({ type: "custom", id: "other-branch", parentId: null, customType: "unrelated", data: header }) + "\n");
	await assert.rejects(request(f, factory(clean)), /no eligible retained/);
});

it("public report.correct consumes the retained producer record without rewriting source run status", async (t) => {
	const f = fixture(t); const stub = factory(clean); setChildSessionFactory(stub.value); t.after(() => setChildSessionFactory(undefined));
	const retained = { runId: "source-run", sessionId: "parent-session", cwd: f.cwd, mode: "single", children: [{ agent: "quick-review", status: "completed", sessionFile: f.source }] };
	const original = JSON.stringify(retained);
	const state = { baseCwd: f.cwd, currentSessionId: "parent-session", asyncJobs: new Map(), foregroundRuns: new Map([["source-run", retained]]), foregroundControls: new Map(),
		lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} } };
	const executor = createSubagentExecutor({ pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName: () => "parent" }, state,
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} }, asyncByDefault: false, tempArtifactsDir: f.root, getSubagentSessionRoot: () => f.root,
		expandTilde: (value: string) => value, discoverAgents: () => ({ agents: [] }) } as never);
	const ctx = { cwd: f.cwd, hasUI: false, sessionManager: { getSessionId: () => "parent-session", getSessionFile: () => null }, modelRegistry: { getAvailable: () => [] } } as never;
	const result = await executor.execute("correction", { action: "report.correct", id: "source-run", message: "Reassess the format blocker." }, new AbortController().signal, undefined, ctx);
	assert.notEqual(result.isError, true, JSON.stringify(result.content));
	assert.deepEqual(result.details.reportCorrection?.proposedReport, clean); assert.equal(stub.launches(), 1); assert.equal(JSON.stringify(retained), original);
	const refused = await executor.execute("override", { action: "report.correct", id: "source-run", message: "Reassess", outputSchema: { type: "string" } }, new AbortController().signal, undefined, ctx);
	assert.equal(refused.isError, true); assert.equal(stub.launches(), 1);
});

it("a later source message invalidates the earlier retained terminal record", async (t) => {
	const f = fixture(t); const latest = f.entries.at(-1)!;
	fs.appendFileSync(f.source, JSON.stringify({ type: "message", id: "later", parentId: latest.id, message: fauxAssistantMessage("new work") }) + "\n");
	await assert.rejects(request(f, factory(clean)), /no eligible retained/);
});

it("an earlier launch's inspection cannot certify a new subject with no current-launch inspection", async (t) => {
	const f = fixture(t, { historicalInspection: true, inspected: false }); const stub = factory(clean);
	await assert.rejects(request(f, stub), /no eligible retained/); assert.equal(stub.launches(), 0);
});

it("current-launch inspection remains eligible alongside unrelated historical context", async (t) => {
	const f = fixture(t, { historicalInspection: true }); const source = f.entries.find((entry) => entry.customType === REPORT_CORRECTION_SOURCE)!.data as { evidenceEntryIds: string[] };
	assert.equal(source.evidenceEntryIds.includes("message-1"), false); assert.ok(source.evidenceEntryIds.includes("message-2"));
	const result = await request(f, factory(clean)); assert.deepEqual(result.proposedReport, clean);
});

it("native compaction preserves current-launch evidence by SDK entry provenance, not shifted message counts", async (t) => {
	const f = fixture(t, { compactHistory: true });
	const projection = SessionManager.inMemory(undefined, undefined, f.entries as FileEntry[]).buildSessionProjection();
	assert.ok(projection.messages.length < 11, "native compaction shifted projected positions below the historical boundary");
	const result = await request(f, factory(clean)); assert.deepEqual(result.proposedReport, clean);
});

it("native compaction of historical inspection alone cannot fabricate current-launch evidence", async (t) => {
	const f = fixture(t, { compactHistory: true, inspected: false });
	await assert.rejects(request(f, factory(clean)), /no eligible retained/);
});

it("retention records preserve schema and exact Git-native identity", (t) => {
	const f = fixture(t); const entry = f.entries.find((item) => item.customType === REPORT_CORRECTION_SOURCE)!;
	const data = entry.data as { subject: string; schema: unknown }; assert.equal(data.subject, reviewSubject(f.cwd)); assert.deepEqual(data.schema, schema);
});
