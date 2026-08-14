import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { cleanupResultIndexes, resultFilesForSession, writeAsyncResultFile, writeResultIndexForData } from "../../src/runs/background/result-files.ts";

describe("result file indexes", () => {
	it("removes orphan index entries without deleting flat result files", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-index-"));
		try {
			writeAsyncResultFile(path.join(resultsDir, "kept.json"), { id: "kept", runId: "kept", sessionId: "session-a", success: true });
			writeAsyncResultFile(path.join(resultsDir, "missing.json"), { id: "missing", runId: "missing", sessionId: "session-a", toolCallId: "call-missing", success: true });
			fs.rmSync(path.join(resultsDir, "missing.json"));
			fs.writeFileSync(path.join(resultsDir, "unindexed.json"), JSON.stringify({ id: "unindexed", sessionId: "session-a" }), "utf-8");

			assert.equal(cleanupResultIndexes(resultsDir, Date.now() + 86_400_001, 86_400_000), 2);

			assert.deepEqual(resultFilesForSession(resultsDir, "session-a"), ["kept.json"]);
			assert.equal(fs.existsSync(path.join(resultsDir, "kept.json")), true);
			assert.equal(fs.existsSync(path.join(resultsDir, "unindexed.json")), true);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("keeps a valid index while the result payload is not visible yet", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-late-payload-"));
		try {
			const resultPath = path.join(resultsDir, "late.json");
			writeResultIndexForData(resultPath, { id: "late", runId: "late", sessionId: "session-a", success: true });

			assert.deepEqual(resultFilesForSession(resultsDir, "session-a"), []);

			fs.writeFileSync(resultPath, JSON.stringify({ id: "late", runId: "late", sessionId: "session-a", success: true }), "utf-8");
			assert.deepEqual(resultFilesForSession(resultsDir, "session-a"), ["late.json"]);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});
});
