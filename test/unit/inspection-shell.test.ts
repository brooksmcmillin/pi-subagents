import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInspectionArgs, validateInspectionCommand } from "../../src/extension/inspection-shell.ts";

describe("inspection shell", () => {
	it("allows explicitly read-only git and GitHub queries", () => {
		assert.deepEqual(validateInspectionCommand({ program: "git", args: ["diff", "origin/main...HEAD"] }), { ok: true });
		assert.deepEqual(validateInspectionCommand({ program: "gh", args: ["pr", "checks", "123"] }), { ok: true });
		assert.deepEqual(validateInspectionCommand({ program: "gh", args: ["api", "/repos/acme/project/pulls/123"] }), { ok: true });
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
