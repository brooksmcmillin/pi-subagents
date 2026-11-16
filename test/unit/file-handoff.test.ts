import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerFileHandoffGuard } from "../../src/runs/shared/file-handoff.ts";

function harness(output: string, cwd: string) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	registerFileHandoffGuard({ on: (name: string, fn: any) => handlers.set(name, fn) } as unknown as ExtensionAPI, output);
	const ctx = { cwd, sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;
	return { ctx, call: (event: any) => handlers.get("tool_call")!(event, ctx) };
}

test("writing an output file does not block research, revisions or structured submission", () => {
	const cwd = mkdtempSync(join(tmpdir(), "handoff-"));
	try {
		const output = join(cwd, "report.json");
		const guard = harness(output, cwd);
		assert.equal(guard.call({ toolName: "write", toolCallId: "report", input: { path: output } }), undefined);
		const tools = ["web_search", "fetch_content", "get_search_content", "source_check", "structured_output", "write", "edit", "bash", "mcp", "morph_fastapply", "contact_supervisor"];
		for (const toolName of tools) assert.equal(guard.call({ toolName, input: {} }), undefined, toolName);
		writeFileSync(output, "{}");
		for (const toolName of tools) {
			assert.equal(guard.call({ toolName, input: { path: output } }), undefined, toolName);
			assert.equal(harness(output, cwd).call({ toolName, input: { path: output } }), undefined, `restart: ${toolName}`);
		}
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("published worker branches reject rewriting but permit ordinary follow-up commits", () => {
	const cwd = mkdtempSync(join(tmpdir(), "handoff-git-"));
	try {
		const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		git("init", "-b", "worker");
		git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
		const guard = harness(join(cwd, "report.json"), cwd);
		assert.equal(guard.call({ toolName: "bash", input: { command: "git commit --amend --no-edit" } }), undefined);
		for (const command of ["git -C /other commit --amend", "git -C/other reset --hard", "git --git-dir=/other/.git rebase main", "git --work-tree /other reset HEAD", "GIT_DIR=/other/.git git commit --amend", "GIT_WORK_TREE=/other git reset HEAD", "GIT_COMMON_DIR=/other git rebase main", "cd /other && git commit --amend", "pushd /other; git reset HEAD"]) {
			assert.equal(guard.call({ toolName: "bash", input: { command } }).block, true, command);
		}
		git("update-ref", "refs/remotes/origin/renamed", git("rev-parse", "HEAD"));
		git("config", "remote.origin.url", "/unused");
		git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
		git("config", "branch.worker.remote", "origin");
		git("config", "branch.worker.merge", "refs/heads/renamed");
		assert.equal(guard.call({ toolName: "bash", input: { command: "git commit --amend" } }).block, true, "differently named upstream is published");
		git("config", "--unset", "branch.worker.remote");
		git("config", "--unset", "branch.worker.merge");
		git("update-ref", "refs/remotes/origin/worker", git("rev-parse", "HEAD"));
		for (const command of ["git commit --amend --no-edit", "git rebase main", "git reset --hard HEAD~", "git push --force-with-lease", "git push -f", "git push origin +HEAD:worker"]) {
			assert.equal(guard.call({ toolName: "bash", input: { command } }).block, true, command);
		}
		assert.equal(guard.call({ toolName: "bash", input: { command: "git commit -m fix && git push" } }), undefined);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a draft write does not impose a terminal tool batch", () => {
	const cwd = mkdtempSync(join(tmpdir(), "handoff-batch-"));
	try {
		const guard = harness(join(cwd, "report.json"), cwd);
		guard.ctx.sessionManager.getBranch = () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall" }, { type: "toolCall" }] } }] as any;
		assert.equal(guard.call({ toolName: "write", toolCallId: "report", input: { path: "report.json" } }), undefined);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
