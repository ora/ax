// The local record of a trial: one JSON file per trial under ~/.ax/trials/, written before the
// first journey is created and extended the moment each create returns, so `trial view`, `list`
// and `cancel` can pick a trial up after the terminal is gone. The record holds the parsed spec,
// the resolved agents, the planned cells and one entry per create. It has no field for a key or a
// token and never will: the secret lives in the environment only (AGENTS.md invariant 7).
// Everything here is synchronous, so a read-modify-write cannot interleave with another in the
// same process.

import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Level } from "./levels";
import type { AgentChoice, PlannedCell, TrialSpec } from "./spec";

export const DEFAULT_TRIALS_DIR = join(homedir(), ".ax", "trials");

export const TRIAL_ID_PATTERN = /^t-[a-z0-9]{10}$/;

const RECORD_FILE = /^(t-[a-z0-9]{10})\.json$/;

export type StoppedReason = "quota" | "platform_down" | "api_error" | "interrupted";

/** An agent whose run did not start in a create, with the reason the server gave. */
export interface FailedAgent {
	harness: string;
	model?: string;
	reason: string;
}

/**
 * One create. `task` is the index into `spec.tasks` and `repeat` counts from 1. `journeyId` is
 * null when a 502 carried no journey. `runIds` are the runs that started.
 */
export interface JourneyEntry {
	journeyId: string | null;
	task: number;
	level: Level;
	repeat: number;
	runIds: string[];
	failed: FailedAgent[];
	createdAt: string;
}

export interface TrialRecord {
	id: string;
	createdAt: string;
	spec: TrialSpec;
	/** The agents as the catalog resolved them (the spec's own list is empty when --agents was omitted). */
	agents: AgentChoice[];
	cells: PlannedCell[];
	journeys: JourneyEntry[];
	stoppedReason?: StoppedReason;
	/** Runs that never started because launching stopped. */
	notLaunched?: number;
}

export interface NewRecord {
	spec: TrialSpec;
	agents: AgentChoice[];
	cells: PlannedCell[];
}

export interface RecordSummary {
	id: string;
	createdAt: string;
	site: string;
	journeys: number;
	/** Runs that started, summed over the journeys. */
	runs: number;
}

export interface RecordList {
	records: RecordSummary[];
	/** File names that did not parse as a trial record. */
	skipped: string[];
}

export function isTrialId(id: string): boolean {
	return TRIAL_ID_PATTERN.test(id);
}

function newId(dir: string): string {
	for (;;) {
		const id = `t-${randomBytes(5).toString("hex")}`;
		if (!existsSync(recordPath(id, dir))) return id;
	}
}

/** The only place a path is built from an id; the id is checked first. */
function recordPath(id: string, dir: string): string {
	if (!isTrialId(id)) throw new Error(`invalid trial id ${JSON.stringify(id)}`);
	return join(dir, `${id}.json`);
}

/** A file that exists but is not a trial record; `listRecords` skips these, `readRecord` surfaces them. */
class CorruptRecordError extends Error {
	constructor(id: string, why: string) {
		super(`trial record ${id} ${why}`);
	}
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Write a temp file beside the target, then rename it over: a reader sees the old or the new file. */
function writeAtomic(path: string, record: TrialRecord, dir: string): void {
	const text = `${JSON.stringify(record, null, "\t")}\n`;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `.${record.id}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		writeFileSync(temp, text, { mode: 0o600 });
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

function looksLikeRecord(value: unknown): value is TrialRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<TrialRecord>;
	return (
		typeof record.id === "string" &&
		typeof record.createdAt === "string" &&
		typeof record.spec?.site === "string" &&
		Array.isArray(record.journeys)
	);
}

function parseRecord(text: string, id: string): TrialRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		// Only a malformed file is expected here; anything else propagates.
		if (!(error instanceof SyntaxError)) throw error;
		throw new CorruptRecordError(id, "is not valid JSON");
	}
	if (!looksLikeRecord(parsed) || parsed.id !== id) {
		throw new CorruptRecordError(id, "is not a trial record");
	}
	return parsed;
}

/** Create the record before the first journey: the spec, the resolved agents, the cells, no journeys. */
export function createRecord(input: NewRecord, dir = DEFAULT_TRIALS_DIR): TrialRecord {
	const id = newId(dir);
	const record: TrialRecord = {
		id,
		createdAt: new Date().toISOString(),
		spec: input.spec,
		agents: input.agents,
		cells: input.cells,
		journeys: [],
	};
	writeAtomic(recordPath(id, dir), record, dir);
	return record;
}

/** The record for `id`, or null when the id is not well formed or no such record exists. */
export function readRecord(id: string, dir = DEFAULT_TRIALS_DIR): TrialRecord | null {
	if (!isTrialId(id)) return null;
	let text: string;
	try {
		text = readFileSync(recordPath(id, dir), "utf8");
	} catch (error) {
		// A missing file or directory is how an unknown id looks; other errors propagate.
		if (isNotFound(error)) return null;
		throw error;
	}
	return parseRecord(text, id);
}

function readExisting(id: string, dir: string): TrialRecord {
	recordPath(id, dir); // throws on an invalid id; readRecord alone would answer null
	const record = readRecord(id, dir);
	if (!record) throw new Error(`no trial record ${id} in ${dir}`);
	return record;
}

function update(id: string, dir: string, change: (record: TrialRecord) => void): TrialRecord {
	const record = readExisting(id, dir);
	change(record);
	writeAtomic(recordPath(id, dir), record, dir);
	return record;
}

/** Append one create's outcome, in the order the creates returned. */
export function appendJourney(
	id: string,
	journey: JourneyEntry,
	dir = DEFAULT_TRIALS_DIR,
): TrialRecord {
	return update(id, dir, (record) => {
		record.journeys.push(journey);
	});
}

/** Record that launching stopped early and how many runs never started. */
export function markStopped(
	id: string,
	stoppedReason: StoppedReason,
	notLaunched: number,
	dir = DEFAULT_TRIALS_DIR,
): TrialRecord {
	return update(id, dir, (record) => {
		record.stoppedReason = stoppedReason;
		record.notLaunched = notLaunched;
	});
}

function summarize(record: TrialRecord): RecordSummary {
	const runs = record.journeys.reduce((total, journey) => total + journey.runIds.length, 0);
	return {
		id: record.id,
		createdAt: record.createdAt,
		site: record.spec.site,
		journeys: record.journeys.length,
		runs,
	};
}

function newestFirst(a: RecordSummary, b: RecordSummary): number {
	return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/** One summary per record file, newest first. Local only: no server is asked. */
export function listRecords(dir = DEFAULT_TRIALS_DIR): RecordList {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		// No directory yet means no trial has run on this machine.
		if (isNotFound(error)) return { records: [], skipped: [] };
		throw error;
	}
	const records: RecordSummary[] = [];
	const skipped: string[] = [];
	for (const name of names.sort()) {
		const match = RECORD_FILE.exec(name);
		if (!match) continue;
		try {
			records.push(summarize(parseRecord(readFileSync(join(dir, name), "utf8"), match[1])));
		} catch (error) {
			// A corrupt file is reported by name; a failed read (permissions, I/O) is not ours to hide.
			if (!(error instanceof CorruptRecordError)) throw error;
			skipped.push(name);
		}
	}
	return { records: records.sort(newestFirst), skipped };
}
