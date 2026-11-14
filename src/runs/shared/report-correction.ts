import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { ChildSession, ChildSessionFactory, ChildSessionLaunch } from "./child-session.ts";
import { childSessionFactory, childSessionHasQueuedMessages } from "./child-session.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import { acquireSessionLease } from "./session-lease.ts";
import { REPORT_CORRECTION_SOURCE, reviewSubject, type ReportCorrectionSource } from "./report-correction-source.ts";
import { validateStructuredOutputValue } from "./structured-output.ts";
import registerSubagentPromptRuntime from "./subagent-prompt-runtime.ts";
import { snapshotRequiredChildExtensions } from "../../shared/required-child-extensions.ts";

export interface ReportCorrection {
	/** Candidate evidence only; never a clean-review or approval receipt. */
	status: "unassessed";
	id: string;
	sourceRunId: string;
	sourceSessionFile: string;
	sourceDigest: string;
	sourceState: ReportCorrectionSource["state"];
	original?: unknown;
	proposedReport: unknown;
	artifactPath: string;
	sessionFile: string;
	acceptanceReport?: unknown;
}

function activeSource(raw: string): { source: ReportCorrectionSource; sourceToolCallIds: string[] } {
	const entries = raw.trim().split("\n").map((line) => JSON.parse(line)) as FileEntry[];
	// Reuse Pi's active-branch semantics without ever opening the source for writes.
	const manager = SessionManager.inMemory(undefined, undefined, entries);
	const header = manager.getHeader();
	let changedContext = false;
	for (const entry of manager.getBranch().reverse()) {
		if (entry.type === "custom" && entry.customType === REPORT_CORRECTION_SOURCE) {
			if (changedContext) break;
			const source = entry.data as ReportCorrectionSource;
			if (source?.version !== 1 || source.sessionId !== header?.id || !source.runId || !source.parentSessionId || !source.cwd || !source.model || !source.subject || !source.schema
				|| !Array.isArray(source.evidenceEntryIds) || !source.evidenceEntryIds.length || source.evidenceEntryIds.some((id) => typeof id !== "string")
				|| !["rejected", "captured-blocked"].includes(source.state)) break;
			const ids = new Set(source.evidenceEntryIds);
			const evidence = manager.buildSessionProjection().entries.filter((entry) => ids.has(entry.sourceEntry.id));
			if (ids.size !== source.evidenceEntryIds.length || evidence.length !== ids.size) break;
			const sourceToolCallIds = evidence.flatMap((entry) => entry.messages).flatMap((message) => message.role === "toolResult" && message.toolName !== "structured_output" ? [message.toolCallId] : []);
			return { source, sourceToolCallIds };
		}
		if (["message", "custom_message", "context_edit", "compaction"].includes(entry.type)) changedContext = true;
	}
	throw new Error("Report correction unavailable: no eligible retained read-only review evidence on the active session branch.");
}

function preserveFindings(source: ReportCorrectionSource, corrected: unknown): void {
	const original = source.original;
	const prior = (original as { findings?: unknown[] } | undefined)?.findings;
	if (!Array.isArray(prior) || !prior.length) return;
	const next = (corrected as { findings?: unknown[] } | undefined)?.findings;
	// Invalid submissions need shape repair; retain their original substance in the
	// unassessed amendment instead of requiring invalid JSON to survive validation.
	if (!Array.isArray(next) || next.length < prior.length || (source.state === "captured-blocked" && prior.some((finding) => !next.some((candidate) => JSON.stringify(candidate) === JSON.stringify(finding))))) {
		throw new Error("Report correction cannot remove or rewrite retained substantive findings; request a new independent review instead.");
	}
}

/** Report-only branch, not a general resume: originals and source run status are never written. */
export async function correctRetainedReport(input: {
	runId: string;
	parentSessionId: string;
	sourceSessionFile: string;
	reason: string;
	assertTerminal: () => void;
	timeoutMs: number;
	signal?: AbortSignal;
	parentProviderRegistry?: ChildSessionLaunch["parentProviderRegistry"];
	requiredExtensions?: ChildSessionLaunch["requiredExtensions"];
	factory?: ChildSessionFactory;
}): Promise<ReportCorrection> {
	if (!input.reason.trim() || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new Error("Report correction requires a reason and a positive timeoutMs.");
	input.assertTerminal();
	const id = randomUUID();
	const sourceFile = fs.realpathSync(input.sourceSessionFile);
	const lease = acquireSessionLease({ sessionFile: sourceFile, runId: id, sourceRunId: input.runId, parentSessionId: input.parentSessionId });
	let child: ChildSession | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	let cancelled = input.signal?.aborted === true;
	const controller = new AbortController();
	const abort = () => { cancelled = true; controller.abort(); void child?.abort(); };
	input.signal?.addEventListener("abort", abort, { once: true });
	try {
		input.assertTerminal();
		const raw = fs.readFileSync(sourceFile, "utf8");
		const { source, sourceToolCallIds } = activeSource(raw);
		if (source.runId !== input.runId || source.parentSessionId !== input.parentSessionId) throw new Error("Report correction source run or owner does not match.");
		const validateSubject = () => fs.readFileSync(sourceFile, "utf8") !== raw ? "Report correction failed: retained source evidence changed."
			: reviewSubject(source.cwd) !== source.subject ? "Report correction failed: HEAD, base refs, index or working-tree subject changed or became unavailable." : undefined;
		const initialError = validateSubject();
		if (initialError) throw new Error(initialError);
		if (cancelled) throw new Error("Report correction cancelled.");
		const dir = path.join(path.dirname(sourceFile), "report-corrections", id);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const sessionFile = path.join(dir, "session.jsonl");
		fs.writeFileSync(sessionFile, raw, { mode: 0o600, flag: "wx" });
		let value: unknown;
		let acceptanceReport: unknown;
		let captured = false;
		const runtime: ChildRuntimeConfig = {
			cwd: source.cwd, runId: id, parentSessionId: input.parentSessionId,
			fanoutChild: false, depth: 1, maxDepth: 1, fast: true, waitTool: { enabled: false },
			structuredOutput: {
				schema: source.schema,
				...(source.acceptanceReport ? { acceptanceReport: source.acceptanceReport } : {}),
				completionRecovery: { originalError: "Explicit retained-evidence report correction", validateSubject },
				capture(corrected, acceptance) { preserveFindings(source, corrected); value = corrected; acceptanceReport = acceptance; captured = true; },
			},
		};
		const requiredExtensions = snapshotRequiredChildExtensions([...new Map([...(source.requiredExtensions ?? []), ...(input.requiredExtensions ?? [])].map((extension) => [extension.path, extension])).values()]);
		const factory = input.factory ?? childSessionFactory();
		timer = setTimeout(() => { timedOut = true; controller.abort(); void child?.abort(); }, input.timeoutMs);
		child = await factory.create({
			cwd: source.cwd, storage: { kind: "file", sessionFile }, model: source.model,
			parentProviderRegistry: input.parentProviderRegistry,
			tools: ["structured_output"], extensionPaths: requiredExtensions.map((extension) => extension.path), requiredExtensions,
			ambientExtensions: false, noSkills: true, noContextFiles: true,
			signal: controller.signal, runtime,
			hooks: [{ name: "report-only-correction", factory: (pi) => registerSubagentPromptRuntime(pi, runtime) }],
		});
		if (cancelled || timedOut) throw new Error("Report correction cancelled or timed out during startup.");
		await child.prompt([
			"Correct only the retained review report using inspection evidence already present in this session. Do not repeat inspection or implementation.",
			`Source run: ${source.runId}; source report state: ${source.state}. The original report and history remain authoritative historical evidence.`,
			`Certified source-launch tool results have call IDs ${JSON.stringify(sourceToolCallIds)}; earlier history is not newly certified inspection.`,
			"Only structured_output is executable. Submit the same schema as your only final action. Preserve substantive findings and uncertainty; real missing coverage must remain blocked. Formatting success is not evidence of a clean review.",
			"A suspected format-only explanation is a hypothesis to assess, not an instruction to return clean. Never invent inspection or silently discard a substantive blocker.",
			`Correction request (not evidence): ${input.reason}`,
		].join("\n"));
		input.assertTerminal();
		const recovery = runtime.structuredOutput!.completionRecovery!;
		const failure = recovery.error ?? validateSubject();
		if (failure || timedOut || cancelled || child.shutDown || childSessionHasQueuedMessages(child) || !captured) throw new Error(failure ?? "Report correction incomplete, interrupted, or missing structured_output.");
		const validation = await validateStructuredOutputValue(source.schema, value);
		if (validation.status !== "valid") throw new Error(`Invalid corrected report: ${validation.message}`);
		const artifactPath = path.join(dir, "correction.json");
		const correction: ReportCorrection = { status: "unassessed", id, sourceRunId: source.runId, sourceSessionFile: sourceFile,
			sourceDigest: createHash("sha256").update(raw).digest("hex"), sourceState: source.state,
			...(source.original !== undefined ? { original: source.original } : {}), proposedReport: value, artifactPath, sessionFile,
			...(acceptanceReport !== undefined ? { acceptanceReport } : {}) };
		fs.writeFileSync(artifactPath, JSON.stringify(correction, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		return correction;
	} finally {
		if (timer) clearTimeout(timer);
		input.signal?.removeEventListener("abort", abort);
		try { await child?.dispose(); } finally { lease.release(); }
	}
}
