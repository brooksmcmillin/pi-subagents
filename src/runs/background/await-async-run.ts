import * as fs from "node:fs";
import { isStorageAccessError, readStatus } from "../../shared/utils.ts";
import { workflowAwaitedAsyncResultPath } from "./async-execution.ts";
import { waitForImportedAsyncRoot, type ImportedAsyncRootResult } from "./chain-root-attachment.ts";
import { indexedResultPayloadVisibility, readResultPayload, resultPayloadMatchesSessionRun, resultPayloadPathForSessionRun, resultSnapshotReplaced, withResultRunLease, type ResultSnapshot } from "./result-files.ts";
import { checkRecordedPidLiveness } from "./stale-run-reconciler.ts";

type ExistingAsyncRunOutcome =
	| { status: "settled"; result: ImportedAsyncRootResult & { importedPublication: NonNullable<ImportedAsyncRootResult["importedPublication"]> } }
	| { status: "unavailable"; reason: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read-only probe: the runner is gone while status still says it is active and no result was published. */
function runnerExitedWithoutResult(asyncDir: string, resultPath: string, status: NonNullable<ReturnType<typeof readStatus>>): boolean {
	if ((status.state !== "running" && status.state !== "queued") || typeof status.pid !== "number") return false;
	// A pid from another namespace never reads as dead here, so the runner is not presumed gone.
	if (checkRecordedPidLiveness({ pid: status.pid, pidNamespaceScope: status.pidNamespaceScope, bootId: status.bootId }) !== "dead") return false;
	if (!status.sessionId) return true;
	try {
		const direct = readResultPayload(resultPath);
		if (direct !== undefined && resultPayloadMatchesSessionRun(JSON.parse(direct), status.sessionId, status.runId)) return false;
	} catch (error) {
		if (isStorageAccessError(error)) return false;
		if (!(error instanceof SyntaxError)) throw error;
	}
	return indexedResultPayloadVisibility(asyncDir, status.sessionId, status.runId) === "absent";
}

/**
 * Waits for an existing workflow-awaited async child, identified by its async
 * directory and exact run id, and returns its published result without
 * launching, consuming, or rewriting anything. Anything short of a published
 * result file for that exact run is `unavailable`. Rejects with the signal's
 * reason when aborted.
 */
export async function awaitExistingAsyncRun(asyncDir: string, runId: string, signal: AbortSignal): Promise<ExistingAsyncRunOutcome> {
	signal.throwIfAborted();
	let status: ReturnType<typeof readStatus>;
	try {
		status = readStatus(asyncDir);
	} catch (error) {
		return { status: "unavailable", reason: `Async status for run '${runId}' is unreadable: ${errorMessage(error)}` };
	}
	if (!status) return { status: "unavailable", reason: `No async status exists for run '${runId}' at ${asyncDir}.` };
	if (status.runId !== runId) return { status: "unavailable", reason: `Async status at ${asyncDir} belongs to run '${status.runId}', not '${runId}'.` };
	// The launcher's initial status has no workflow identity until the runner starts, so only the
	// mode is checked here; a run that does not publish to the workflow result path stays unavailable.
	if (status.mode !== "single") return { status: "unavailable", reason: `Async run '${runId}' is not a single-agent run.` };
	const resultPath = workflowAwaitedAsyncResultPath(asyncDir);
	const expectedSessionId = status.sessionId;
	if (!expectedSessionId) return { status: "unavailable", reason: `Async run '${runId}' has no session identity.` };
	let runnerExited = false;
	let identityChanged = false;
	let completed: ImportedAsyncRootResult;
	try {
		completed = await waitForImportedAsyncRoot({ runId, asyncDir, resultPath, index: 0 }, {
			requireExactIdentity: true,
			shouldAbort: (current) => {
				if (signal.aborted) return true;
				if (!current || current.runId !== runId || current.sessionId !== expectedSessionId) return (identityChanged = true);
				return (runnerExited = runnerExitedWithoutResult(asyncDir, resultPath, current));
			},
		});
	} catch (error) {
		signal.throwIfAborted();
		return { status: "unavailable", reason: `Could not await async run '${runId}': ${errorMessage(error)}` };
	}
	signal.throwIfAborted();
	if (identityChanged) return { status: "unavailable", reason: `Async run '${runId}' changed identity while waiting.` };
	if (runnerExited) return { status: "unavailable", reason: `Async runner for run '${runId}' exited without publishing a result.` };
	// Only a parsed result file carries importedPublication; status-derived fallbacks do not.
	if (!completed.importedPublication) return { status: "unavailable", reason: `Async run '${runId}' ended without a result file at ${resultPath}.` };
	return { status: "settled", result: { ...completed, importedPublication: completed.importedPublication } };
}

/**
 * Renames the published result to a file owned by `claimant`, if it is still the payload the
 * claimant read. Only one of several concurrent importers can win the rename; the others, and a
 * claimant whose payload a newer one replaced, get undefined and launch fresh.
 */
export function claimWorkflowAwaitedResult(asyncDir: string, claimant: string, read: ResultSnapshot & { payloadPath?: string }): string | undefined {
	const resultPath = workflowAwaitedAsyncResultPath(asyncDir);
	const claimedPath = `${resultPath}.${claimant}.claimed`;
	try {
		return withResultRunLease(asyncDir, read.runId, () => {
			if (resultSnapshotReplaced(resultPath, read)) return undefined;
			const candidates = read.payloadPath && read.payloadPath !== resultPath ? [read.payloadPath, resultPath] : [resultPath];
			const claim = (sourcePath: string): string | undefined => {
				if (readResultPayload(sourcePath) !== read.snapshot) return undefined;
				try {
					fs.renameSync(sourcePath, claimedPath);
					return claimedPath;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			};
			for (const candidate of candidates) {
				const claimed = claim(candidate);
				if (claimed) return claimed;
			}
			if (!read.payloadPath || !read.sessionId) return undefined;
			const indexedPath = resultPayloadPathForSessionRun(asyncDir, read.sessionId, read.runId, undefined, { promote: false });
			if (indexedPath && !candidates.includes(indexedPath) && !resultSnapshotReplaced(indexedPath, read)) return claim(indexedPath);
			return undefined;
		});
	} catch {
		return undefined;
	}
}
