import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import { captureGitBaseline, captureIndexTree, hasHiddenTrackedFiles } from "./structured-output.ts";
import { snapshotTrackedMutations } from "./mutation-evidence.ts";

export const REPORT_CORRECTION_SOURCE = "subagent-report-correction-source";

/** A digest, not a replacement for the retained inspection transcript. */
export function reviewSubject(cwd: string, ancestors = new Set<string>()): string | undefined {
	const baseline = captureGitBaseline(cwd);
	if (!baseline || ancestors.has(baseline.root) || ancestors.size >= 16 || hasHiddenTrackedFiles(baseline.root) !== false) return undefined;
	const visited = new Set([...ancestors, baseline.root]);
	const tree = captureIndexTree(baseline.root);
	const mutations = snapshotTrackedMutations(baseline.root, Date.now() + 2_000);
	if (!tree || mutations.unavailable || mutations.truncated) return undefined;
	const git = (args: string[]) => spawnSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: baseline.root, encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024, windowsHide: true });
	// Include refs so a changed review base cannot silently reuse retained evidence.
	const refs = git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"]);
	const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
	const index = git(["ls-files", "--stage", "-z"]);
	if (refs.error || refs.status !== 0 || untracked.error || untracked.status !== 0 || index.error || index.status !== 0) return undefined;
	const files = untracked.stdout.split("\0").filter(Boolean).sort();
	if (files.length > 500) return undefined;
	try {
		const digest = createHash("sha256").update(JSON.stringify({ baseline, tree, mutations, refs: refs.stdout }));
		// A dirty gitlink's parent diff does not identify its changing contents.
		for (const entry of index.stdout.split("\0")) {
			if (!entry.startsWith("160000 ")) continue;
			const submodule = entry.slice(entry.indexOf("\t") + 1);
			const nested = reviewSubject(path.join(baseline.root, submodule), visited);
			if (!nested) return undefined;
			digest.update(JSON.stringify([submodule, nested]));
		}
		for (const file of files) {
			const target = path.join(baseline.root, file);
			const stat = fs.lstatSync(target);
			if (stat.size > 1024 * 1024 || (!stat.isFile() && !stat.isSymbolicLink())) return undefined;
			digest.update(JSON.stringify([file, stat.mode]));
			digest.update(stat.isSymbolicLink() ? fs.readlinkSync(target) : fs.readFileSync(target));
		}
		return digest.digest("hex");
	} catch { return undefined; }
}

export interface ReportCorrectionSource {
	version: 1;
	runId: string;
	parentSessionId: string;
	sessionId: string;
	cwd: string;
	model: string;
	schema: NonNullable<ChildRuntimeConfig["structuredOutput"]>["schema"];
	subject: string;
	evidenceEntryIds: string[];
	state: "rejected" | "captured-blocked";
	original?: unknown;
	acceptanceReport?: "optional" | "required";
	requiredExtensions?: ChildRuntimeConfig["requiredExtensions"];
}

function submittedReport(messages: readonly unknown[], captured: boolean): { invoked: boolean; original?: unknown; inspected: boolean } {
	let invoked = false;
	let original: unknown;
	let accepted: unknown;
	const calls = new Map<string, unknown>();
	let inspected = false;
	for (const item of messages) {
		const message = item as { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; content?: unknown };
		if (message.role === "toolResult" && message.toolName === "structured_output" && !message.isError && message.toolCallId) accepted = calls.get(message.toolCallId);
		if (message.role === "toolResult" && ["read", "grep", "find", "ls", "bash", "watchdog_diff"].includes(message.toolName ?? "") && !message.isError && Array.isArray(message.content)
			&& message.content.some((part) => part.type === "text" && part.text?.trim())) inspected = true;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "toolCall" && part.name === "structured_output") {
				invoked = true;
				original = part.arguments?.value;
				calls.set(part.id, original);
			}
		}
	}
	return { invoked, original: captured ? accepted : original, inspected };
}

/** Opted-in read-only hosts retain identity once; no prompts or tools are changed. */
export function registerReportCorrectionSource(pi: ExtensionAPI, config: ChildRuntimeConfig): void {
	const structured = config.structuredOutput;
	if (!config.retainReportCorrection || !structured || !config.runId || !config.parentSessionId || !config.cwd) return;
	let subject: string | undefined;
	let historicalEntryIds: Set<string> | undefined;
	const schema = JSON.stringify(structured.schema);
	pi.on("session_start", (_event, ctx) => {
		historicalEntryIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
		subject = reviewSubject(config.cwd!);
	});
	pi.on("agent_settled", (event, ctx: ExtensionContext) => {
		if (!subject || !historicalEntryIds || event.aborted || structured.completionRecovery?.error || JSON.stringify(structured.schema) !== schema || reviewSubject(config.cwd!) !== subject) return;
		const entries = ctx.sessionManager.buildSessionProjection().entries.filter((entry) => !historicalEntryIds!.has(entry.sourceEntry.id) && entry.messages.length);
		const messages = entries.flatMap((entry) => entry.messages);
		const lastAssistant = messages.findLast((message) => message.role === "assistant");
		if (!lastAssistant || lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted" || lastAssistant.errorMessage || ctx.hasPendingMessages()) return;
		if (!structured.terminalState?.captured && lastAssistant.stopReason !== "stop") return;
		const { invoked, original, inspected } = submittedReport(messages, structured.terminalState?.captured === true);
		const blocked = original && typeof original === "object" && (original as { status?: unknown }).status === "blocked";
		if (!inspected || !invoked || (structured.terminalState?.captured && !blocked) || !ctx.model) return;
		const source: ReportCorrectionSource = {
			version: 1, runId: config.runId!, parentSessionId: config.parentSessionId!,
			sessionId: ctx.sessionManager.getSessionId(), cwd: config.cwd!, model: `${ctx.model.provider}/${ctx.model.id}`,
			schema: JSON.parse(schema), subject, evidenceEntryIds: entries.map((entry) => entry.sourceEntry.id),
			state: structured.terminalState?.captured ? "captured-blocked" : "rejected",
			...(original !== undefined ? { original } : {}),
			...(structured.acceptanceReport ? { acceptanceReport: structured.acceptanceReport } : {}),
			...(config.requiredExtensions?.length ? { requiredExtensions: config.requiredExtensions } : {}),
		};
		pi.appendEntry(REPORT_CORRECTION_SOURCE, source);
	});
}
