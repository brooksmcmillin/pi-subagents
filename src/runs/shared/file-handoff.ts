import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

/** Preserve published worker history; output snapshots are protected at persistence. */
export function registerFileHandoffGuard(pi: ExtensionAPI, outputPath: string | undefined): void {
	if (!outputPath) return;
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nOnce your branch is published, use follow-up commits and normal pushes, not history rewrites.`,
	}));
	pi.on("tool_call", (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		if (event.toolName === "bash" && typeof input.command === "string"
			&& /\bgit\b/.test(input.command)
			&& /--amend\b|\brebase\b|\breset\b|--force(?:-with-lease|-if-includes)?\b|\bpush\b[^\n]*(?:\s-f\b|\s\+\S)/.test(input.command)
			&& (/(?:^|\s)-C\S*|--(?:git-dir|work-tree)\b|\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)\b|\b(?:cd|pushd|popd)\b/.test(input.command) || publishedBranch(ctx.cwd))) {
			return { block: true, reason: "This output-bound worker branch is published, its publication state cannot be verified, or the command rebinds its Git target. Preserve ancestry with follow-up commits and a normal push; do not amend, rebase, reset, or force-push." };
		}
	});
}
