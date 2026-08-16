import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

if (!process.env.PI_SUBAGENTS_TEMP_ROOT) {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-root-"));
	process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
	// Tests create projects with os.tmpdir() and otherwise discover the real
	// /tmp/.pi. Keep both their temporary projects and their default Pi home
	// isolated, while letting individual tests override HOME or PI_CODING_AGENT_DIR.
	process.env.TMPDIR = tempRoot;
	process.env.TMP = tempRoot;
	process.env.TEMP = tempRoot;
	process.env.HOME = path.join(tempRoot, "home");
	process.env.USERPROFILE = process.env.HOME;
	delete process.env.PI_CODING_AGENT_DIR;
	process.on("exit", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
}
