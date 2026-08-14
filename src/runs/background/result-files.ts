import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { MISSION_BINDING_FILE } from "../../missions/lifecycle.ts";

const RESULT_INDEX_VERSION = 1;
const RESULT_INDEX_DIR = "result-index";
const SESSION_INDEX_DIR = "sessions";
const OBSERVER_INDEX_DIR = "observers";
const TOOL_CALL_INDEX_DIR = "tool-calls";
const MISSION_OBSERVER = "mission";

export interface ResultIndexEntry {
	version: 1;
	runId: string;
	sessionId: string;
	file: string;
	writtenAt: number;
	asyncDir?: string;
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resultFileName(runId: string): string {
	return `${runId}.json`;
}

export function resultFilePath(resultsDir: string, runId: string): string {
	return path.join(resultsDir, resultFileName(runId));
}

function sessionIndexDir(resultsDir: string, sessionId: string): string {
	return path.join(resultsDir, RESULT_INDEX_DIR, SESSION_INDEX_DIR, encodeSegment(sessionId));
}

function resultIndexPath(resultsDir: string, sessionId: string, runId: string): string {
	return path.join(sessionIndexDir(resultsDir, sessionId), `${encodeSegment(runId)}.json`);
}

function observerIndexDir(resultsDir: string, observer: string): string {
	return path.join(resultsDir, RESULT_INDEX_DIR, OBSERVER_INDEX_DIR, observer);
}

function observerIndexPath(resultsDir: string, observer: string, runId: string): string {
	return path.join(observerIndexDir(resultsDir, observer), `${encodeSegment(runId)}.json`);
}

function toolCallIndexDir(resultsDir: string, toolCallId: string): string {
	return path.join(resultsDir, RESULT_INDEX_DIR, TOOL_CALL_INDEX_DIR, encodeSegment(toolCallId));
}

function toolCallIndexPath(resultsDir: string, toolCallId: string, runId: string): string {
	return path.join(toolCallIndexDir(resultsDir, toolCallId), `${encodeSegment(runId)}.json`);
}

function parseResultIndexEntry(value: unknown): ResultIndexEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<ResultIndexEntry>;
	if (record.version !== RESULT_INDEX_VERSION
		|| typeof record.runId !== "string"
		|| typeof record.sessionId !== "string"
		|| typeof record.file !== "string"
		|| typeof record.writtenAt !== "number") return undefined;
	return {
		version: RESULT_INDEX_VERSION,
		runId: record.runId,
		sessionId: record.sessionId,
		file: record.file,
		writtenAt: record.writtenAt,
		...(typeof record.asyncDir === "string" ? { asyncDir: record.asyncDir } : {}),
	};
}

export function writeResultIndexForData(resultPath: string, data: Record<string, unknown>): void {
	const runId = nonEmptyString(data.runId) ?? nonEmptyString(data.id) ?? path.basename(resultPath, ".json");
	const sessionId = nonEmptyString(data.sessionId);
	if (!runId || !sessionId) return;
	const file = path.basename(resultPath);
	const entry: ResultIndexEntry = {
		version: RESULT_INDEX_VERSION,
		runId,
		sessionId,
		file,
		writtenAt: Date.now(),
		...(nonEmptyString(data.asyncDir) ? { asyncDir: nonEmptyString(data.asyncDir)! } : {}),
	};
	const resultsDir = path.dirname(resultPath);
	writeAtomicJson(resultIndexPath(resultsDir, sessionId, runId), entry);
	const toolCallId = nonEmptyString(data.toolCallId);
	if (toolCallId) writeAtomicJson(toolCallIndexPath(resultsDir, toolCallId, runId), entry);
	if (entry.asyncDir && fs.existsSync(path.join(entry.asyncDir, MISSION_BINDING_FILE))) {
		writeAtomicJson(observerIndexPath(resultsDir, MISSION_OBSERVER, runId), entry);
	}
}

export function writeAsyncResultFile(resultPath: string, data: Record<string, unknown>): void {
	try {
		writeResultIndexForData(resultPath, data);
	} catch (error) {
		console.error(`Failed to write async result index for '${resultPath}':`, error);
	}
	writeAtomicJson(resultPath, data);
}

export function removeResultIndex(resultsDir: string, sessionId: string | undefined, runId: string | undefined, toolCallId?: string): void {
	if (!runId) return;
	if (sessionId) {
		try {
			fs.rmSync(resultIndexPath(resultsDir, sessionId, runId), { force: true });
		} catch {
			// Index cleanup must not affect result delivery.
		}
	}
	if (toolCallId) {
		try {
			fs.rmSync(toolCallIndexPath(resultsDir, toolCallId, runId), { force: true });
		} catch {
			// Index cleanup must not affect result delivery.
		}
	}
	try {
		fs.rmSync(observerIndexPath(resultsDir, MISSION_OBSERVER, runId), { force: true });
	} catch {
		// Index cleanup must not affect result delivery.
	}
}

export function removeMissionObserverIndex(resultsDir: string, runId: string | undefined): void {
	if (!runId) return;
	try {
		fs.rmSync(observerIndexPath(resultsDir, MISSION_OBSERVER, runId), { force: true });
	} catch {
		// Observer index cleanup must not affect result delivery.
	}
}

function indexedResultFile(resultsDir: string, entry: ResultIndexEntry): string | undefined {
	if (entry.file !== path.basename(entry.file) || !entry.file.endsWith(".json")) return undefined;
	const resultPath = path.join(resultsDir, entry.file);
	return fs.existsSync(resultPath) ? entry.file : undefined;
}

function listIndexFiles(dir: string): string[] {
	let files: string[];
	try {
		files = fs.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => path.join(dir, entry.name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return files;
}

function resultFilesFromIndexDir(resultsDir: string, dir: string): string[] {
	const candidates = new Set<string>();
	for (const entryPath of listIndexFiles(dir)) {
		try {
			const entry = parseResultIndexEntry(JSON.parse(fs.readFileSync(entryPath, "utf-8")));
			if (!entry) {
				fs.rmSync(entryPath, { force: true });
				continue;
			}
			const resultFile = indexedResultFile(resultsDir, entry);
			if (resultFile) candidates.add(resultFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Ignoring invalid async result index '${entryPath}':`, error);
		}
	}
	return [...candidates];
}

export function resultFilesForSession(resultsDir: string, sessionId: string): string[] {
	return resultFilesFromIndexDir(resultsDir, sessionIndexDir(resultsDir, sessionId));
}

export function resultFilesForToolCall(resultsDir: string, toolCallId: string): string[] {
	return resultFilesFromIndexDir(resultsDir, toolCallIndexDir(resultsDir, toolCallId));
}

export function missionObserverResultFiles(resultsDir: string): string[] {
	return resultFilesFromIndexDir(resultsDir, observerIndexDir(resultsDir, MISSION_OBSERVER));
}

export function cleanupResultIndexes(resultsDir: string, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000): number {
	const root = path.join(resultsDir, RESULT_INDEX_DIR);
	const cutoff = now - maxAgeMs;
	let removed = 0;
	const visit = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
				try { fs.rmdirSync(fullPath); } catch {}
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const stat = fs.statSync(fullPath);
				const index = parseResultIndexEntry(JSON.parse(fs.readFileSync(fullPath, "utf-8")));
				if (!index || (!indexedResultFile(resultsDir, index) && stat.mtimeMs <= cutoff)) {
					fs.rmSync(fullPath, { force: true });
					removed += 1;
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Ignoring invalid async result index '${fullPath}':`, error);
				try {
					fs.rmSync(fullPath, { force: true });
					removed += 1;
				} catch {}
			}
		}
	};
	visit(root);
	return removed;
}
