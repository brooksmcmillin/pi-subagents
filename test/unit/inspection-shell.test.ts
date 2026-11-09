import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildInspectionArgs, validateInspectionCommand } from "../../src/extension/inspection-shell.ts";

describe("inspection shell", () => {
	it("allows explicitly read-only git and GitHub queries", () => {
		assert.deepEqual(validateInspectionCommand({ program: "git", args: ["diff", "origin/main...HEAD"] }), { ok: true });
		assert.deepEqual(validateInspectionCommand({ program: "gh", args: ["pr", "checks", "123"] }), { ok: true });
		assert.deepEqual(validateInspectionCommand({ program: "gh", args: ["api", "/repos/acme/project/pulls/123"] }), { ok: true });
	});

	it("parses directory options before validating and hardening the subcommand", () => {
		for (const prefix of [
			["-C", "/tmp/pi-audit-3-20261109/checkout"],
			["-C", "/tmp/review checkout"],
			["--no-pager", "-C", "/tmp", "-C", "checkout", "--no-optional-locks"],
			["-C", "log"],
		]) {
			for (const command of ["log", "diff", "show"]) {
				const args = [...prefix, command, "HEAD"];
				assert.deepEqual(validateInspectionCommand({ program: "git", args }), { ok: true });
				assert.deepEqual(buildInspectionArgs("git", args), [
					"-c", "core.fsmonitor=false", "-c", "core.pager=cat", "--no-pager",
					...prefix, command, "--no-textconv", "HEAD",
				]);
			}
			assert.equal(validateInspectionCommand({ program: "git", args: [...prefix, "commit"] }).ok, false);
		}
	});

	it("executes a hardened history query in the selected checkout", () => {
		const directory = mkdtempSync(join(tmpdir(), "inspection-history-"));
		try {
			execFileSync("git", ["init", "--quiet", directory]);
			execFileSync("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
				"-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture history"]);
			for (const prefix of [["-C", directory], ["-C", directory, "-C", "."]]) {
				const args = [...prefix, "log", "-1", "--format=%s"];
				assert.deepEqual(validateInspectionCommand({ program: "git", args }), { ok: true });
				assert.equal(execFileSync("git", buildInspectionArgs("git", args), { cwd: tmpdir(), encoding: "utf8" }).trim(), "fixture history");
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects missing subcommands and unsupported global options", () => {
		for (const args of [
			["-C"], ["-C", "log"], ["-C/tmp"], ["-C/tmp", "log"],
			["--unknown", "log"], ["--help", "log"],
			["-C", "log", "reset", "--hard"],
			["-Clog", "reset", "--hard"],
			["-C", "/tmp", "-c", "alias.log=commit", "log"],
			["-C", "/tmp", "--paginate", "log"],
			["-C", "/tmp", "log", "--textconv"],
		]) {
			assert.equal(validateInspectionCommand({ program: "git", args }).ok, false, JSON.stringify(args));
		}
	});

	it("blocks baseline-mutating scanners and GitHub mutation paths", () => {
		const scanner = validateInspectionCommand({ program: "git", args: ["detect-secrets", "scan", "--baseline", ".secrets.baseline"] });
		assert.equal(scanner.ok, false);
		const ghMutation = validateInspectionCommand({ program: "gh", args: ["api", "/repos/acme/project/issues", "--method", "POST"] });
		assert.equal(ghMutation.ok, false);
		const attachedGhMethod = validateInspectionCommand({ program: "gh", args: ["api", "/repos/acme/project/issues", "-XPOST"] });
		assert.equal(attachedGhMethod.ok, false);
		const browserLaunch = validateInspectionCommand({ program: "gh", args: ["pr", "view", "123", "--web"] });
		assert.equal(browserLaunch.ok, false);
		const alternateHost = validateInspectionCommand({ program: "gh", args: ["api", "/repos/acme/project", "--hostname=metadata.internal"] });
		assert.equal(alternateHost.ok, false);
		const absoluteEndpoint = validateInspectionCommand({ program: "gh", args: ["api", "https://metadata.internal/latest"] });
		assert.equal(absoluteEndpoint.ok, false);
		const gitMutation = validateInspectionCommand({ program: "git", args: ["commit", "-m", "nope"] });
		assert.equal(gitMutation.ok, false);
		const redirectedDiff = validateInspectionCommand({ program: "git", args: ["diff", "--output=.secrets.baseline"] });
		assert.equal(redirectedDiff.ok, false);
		const abbreviatedTextconv = validateInspectionCommand({ program: "git", args: ["diff", "--textc"] });
		assert.equal(abbreviatedTextconv.ok, false);
		const attachedGitConfig = validateInspectionCommand({ program: "git", args: ["-ccredential.helper=!command", "ls-remote", "origin"] });
		assert.equal(attachedGitConfig.ok, false);
		const forcedBranch = validateInspectionCommand({ program: "git", args: ["branch", "--force", "main"] });
		assert.equal(forcedBranch.ok, false);
		const executableTransport = validateInspectionCommand({ program: "git", args: ["ls-remote", "-u", "command", "ext::echo unsafe"] });
		assert.equal(executableTransport.ok, false);
		const indexRefreshingStatus = validateInspectionCommand({ program: "git", args: ["status"] });
		assert.equal(indexRefreshingStatus.ok, false);
		const forcedPager = validateInspectionCommand({ program: "git", args: ["--paginate", "log"] });
		assert.equal(forcedPager.ok, false);
		const grepPager = validateInspectionCommand({ program: "git", args: ["grep", "--open-files-in-pager", "needle"] });
		assert.equal(grepPager.ok, false);
		const configuredFilter = validateInspectionCommand({ program: "git", args: ["cat-file", "--filters", "HEAD:package.json"] });
		assert.equal(configuredFilter.ok, false);
	});

	it("hardens Git invocations against configured external helpers", () => {
		assert.deepEqual(buildInspectionArgs("git", ["diff", "HEAD"]), ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "--no-pager", "diff", "--no-textconv", "HEAD"]);
	});

	it("rejects shell syntax even within an allowlisted command", () => {
		const result = validateInspectionCommand({ program: "git", args: ["status", ";", "touch", "baseline"] });
		assert.equal(result.ok, false);
	});
});
