import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AFTER_HANDOFF_TOOLS = new Set(["read", "grep", "find", "ls", "contact_supervisor"]);

function publishedBranch(cwd: string): boolean {
	try {
		const options: ExecFileSyncOptionsWithStringEncoding = { cwd, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] };
		const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], options).trim();
		const upstream = execFileSync("git", ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`], options).trim();
		return Boolean(upstream) || execFileSync("git", ["for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/"], options).split("\n").includes(branch);
	} catch {
		// A rewrite is not safe when publication state cannot be inspected.
		return true;
	}
}

/** File-only output is a terminal handoff, never a progress file. Not a shell sandbox. */
export function registerFileHandoffGuard(pi: ExtensionAPI, outputPath: string | undefined): void {
	if (!outputPath) return;
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nFile-only output is a write-once terminal handoff. Finish implementation, publication, verification, and any needed supervisor requests first. Write ${outputPath} as the sole tool call in its batch, then finish. Never overwrite this artifact. Once your branch is published, use follow-up commits and normal pushes, not history rewrites.`,
	}));
	let publishing: string | undefined;
	let published = existsSync(outputPath);
	pi.on("tool_call", (event, ctx) => {
		published ||= existsSync(outputPath);
		if ((published || publishing) && !AFTER_HANDOFF_TOOLS.has(event.toolName)) {
			return { block: true, reason: "The file-only handoff is immutable. Finish this run; ask the parent for a new output path before further mutation." };
		}
		const input = event.input as Record<string, unknown>;
		if (event.toolName === "bash" && typeof input.command === "string"
			&& /\bgit\b/.test(input.command)
			&& /--amend\b|\brebase\b|\breset\b|--force(?:-with-lease|-if-includes)?\b|\bpush\b[^\n]*(?:\s-f\b|\s\+\S)/.test(input.command)
			&& (/(?:^|\s)-C\S*|--(?:git-dir|work-tree)\b|\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)\b|\b(?:cd|pushd|popd)\b/.test(input.command) || publishedBranch(ctx.cwd))) {
			return { block: true, reason: "This output-bound worker branch is published, its publication state cannot be verified, or the command rebinds its Git target. Preserve ancestry with follow-up commits and a normal push; do not amend, rebase, reset, or force-push." };
		}
		if (event.toolName === "write" && typeof input.path === "string" && resolve(ctx.cwd, input.path.replace(/^@/, "")) === resolve(outputPath)) {
			const message = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			if (message?.type === "message" && message.message.role === "assistant" && Array.isArray(message.message.content)
				&& message.message.content.filter((block) => block.type === "toolCall").length > 1) {
				return { block: true, reason: "Publish the file-only handoff as the sole tool call, after all implementation and verification has finished." };
			}
			publishing = event.toolCallId;
		}
	});
	pi.on("tool_result", (event) => {
		if (event.toolCallId !== publishing) return;
		published ||= existsSync(outputPath);
		publishing = undefined;
	});
}
