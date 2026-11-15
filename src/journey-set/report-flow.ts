import { join } from "node:path";
import { StudioApiError, StudioConnectionError, StudioShapeError } from "../api/studio";
import type { StudioAgentPair, StudioClient } from "../api/studio-types";
import { reportError } from "../report/json-error";
import { axCall, type NextStep, placeholder, printNext } from "../report/next-line";
import { plain } from "../ui/ansi";
import { collectSet } from "./collect";
import { countSet, type SetCount } from "./count";
import { type FollowInput, followJourneys } from "./follow";
import { type LaunchResult, launchSet } from "./launch";
import {
	CorruptRecordError,
	DEFAULT_SETS_DIR,
	isSetId,
	readRecord,
	type SetRecord,
} from "./record";
import { progressLine, readFailureMessage, stopMessage } from "./render-preview";
import { renderSetReport } from "./render-report";
import { reportJson, runsAwaitingGrade, runsInFlight } from "./report-json";

// A set from its written record to its report, the path a set takes once the person said yes
// and `ax journey view` takes from a record id: pick the record up (view only), launch (run
// only), follow the recorded journeys, collect and count what they read, and print the report or
// the --json document with its Next line. Ctrl-C is wired per phase. Lines for a person go to
// stderr; stdout carries only the report or the document. Exit codes stay with the commands.

/** `reported`: a report printed. `interrupted`: Ctrl-C. `failed`: the platform, and no report. */
export type FlowEnd = "reported" | "interrupted" | "failed";

export interface FollowFlowInput {
	client: Pick<StudioClient, "journey" | "insightLanded" | "trajectory">;
	/** The record as it is on disk: its journeys and any launch stop. */
	record: SetRecord;
	waitMinutes: number;
	json: boolean;
	now: () => number;
	sleep: FollowInput["sleep"];
}

export interface LaunchFlowInput extends Omit<FollowFlowInput, "client"> {
	client: Pick<StudioClient, "createJourney" | "journey" | "insightLanded" | "trajectory">;
	/** The resolved agents; every create sends all of them. */
	agents: readonly StudioAgentPair[];
	/** The run command as typed: the Next line when launching stopped before any journey. */
	runCall: string;
	/** The record directory; tests pass a temp one. */
	dir?: string;
}

const DETACHED = "Stopped following. Runs that started keep running.";

/** Runs whose steps could not be read carry no flags, so the report would undercount them. */
function unflaggedLine(runs: number): string {
	const noun = runs === 1 ? "1 run" : `${runs} runs`;
	return `The steps of ${noun} could not be read, so the report does not flag them as blocked or never visited.`;
}

function jsonWords(json: boolean): string[] {
	return json ? ["--json"] : [];
}

/** A set of journeys in its general form, for a Next line that has no typed call to repeat. */
export const SET_USAGE_CALL = axCall([
	"journey",
	placeholder("goal"),
	"--domain",
	placeholder("site"),
	"--levels",
]);

export function viewStep(id: string, json: boolean): NextStep {
	return {
		call: axCall(["journey", "view", id, ...jsonWords(json)]),
		why: "picks the set up and prints its report",
	};
}

export function cancelStep(id: string, json: boolean): NextStep {
	return {
		call: axCall(["journey", "cancel", id, ...jsonWords(json)]),
		why: "stops the runs that started",
	};
}

/**
 * The --json envelope's code for one of the platform's failures, for every set command: the
 * platform's own code when it sent one, else `API_ERROR` as the other commands use, and a code
 * each for no connection and a malformed answer.
 */
export function failureCode(error: unknown): string {
	if (error instanceof StudioConnectionError) return "API_UNREACHABLE";
	if (error instanceof StudioShapeError) return "API_BAD_ANSWER";
	if (error instanceof StudioApiError && error.code) return error.code;
	return "API_ERROR";
}

/**
 * Run one phase with Ctrl-C wired to its signal. The listener is added once, so a second Ctrl-C
 * finds none and gets Node's default exit, and it comes off when the phase ends either way.
 */
export async function withInterrupt<T>(phase: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const onSignal = () => controller.abort();
	process.once("SIGINT", onSignal);
	try {
		return await phase(controller.signal);
	} finally {
		process.removeListener("SIGINT", onSignal);
	}
}

/** One stderr line that changes as a phase runs: repainted on a terminal, printed on change otherwise. */
function statusLine(): { show(text: string): void; end(): void } {
	const live = Boolean(process.stderr.isTTY);
	let last = "";
	return {
		show(text) {
			if (text === last) return;
			last = text;
			if (live) process.stderr.write(`\r\x1b[K${text}`);
			else console.error(text);
		},
		end() {
			if (live && last) process.stderr.write("\n");
			last = "";
		},
	};
}

async function withStatus<T>(phase: (show: (text: string) => void) => Promise<T>): Promise<T> {
	const status = statusLine();
	try {
		return await phase((text) => status.show(text));
	} finally {
		status.end();
	}
}

/** View while runs are still going or awaiting a grade, which a later view picks up; otherwise the audit. */
function reportNext(record: SetRecord, count: SetCount, json: boolean): NextStep {
	if (runsInFlight(count) + runsAwaitingGrade(count) > 0) return viewStep(record.id, json);
	return {
		call: axCall(["audit", record.spec.site, ...jsonWords(json)]),
		why: "the readiness audit: which checks explain what the agents hit",
	};
}

function follow(input: FollowFlowInput) {
	const journeyIds = input.record.journeys.flatMap((entry) =>
		entry.journeyId === null ? [] : [entry.journeyId],
	);
	return withStatus((show) =>
		withInterrupt((signal) =>
			followJourneys({
				client: input.client,
				journeyIds,
				waitMinutes: input.waitMinutes,
				signal,
				now: input.now,
				sleep: input.sleep,
				onProgress: (progress) => show(progressLine(progress)),
			}),
		),
	);
}

/**
 * Follow, then report. A Ctrl-C while following prints the view line and no report: collecting
 * would make more platform calls after the person asked to stop. Reads that kept failing print
 * their last error first, then the report of what was read, or only the view line when no read
 * ever worked. The report's own incomplete line is the one place that says why it is incomplete.
 */
export async function followAndReport(input: FollowFlowInput): Promise<FlowEnd> {
	const { client, record, json } = input;
	const followed = await follow(input);
	const view = viewStep(record.id, json);
	if (followed.ended === "detached") {
		reportError({ code: "INTERRUPTED", message: DETACHED, next: view }, { json });
		return "interrupted";
	}
	if (followed.ended === "read_failed") {
		const lines = readFailureMessage(followed.lastError);
		if (followed.journeys.size === 0) {
			const code = failureCode(followed.lastError);
			reportError({ code, message: lines.join("\n"), next: view }, { json });
			return "failed";
		}
		for (const line of lines) console.error(line);
	}
	const journeys = [...followed.journeys.values()];
	const collected = await collectSet({ record, journeys, client });
	if (collected.trajectoryFailures > 0) console.error(unflaggedLine(collected.trajectoryFailures));
	const count = countSet(collected.runs, collected.shape);
	const report = { record, count, ended: followed.ended };
	if (json) process.stdout.write(`${JSON.stringify(reportJson(report), null, 2)}\n`);
	else for (const line of renderSetReport(report)) console.log(line);
	printNext(reportNext(record, count, json), { stderr: json });
	return "reported";
}

function launch(input: LaunchFlowInput): Promise<LaunchResult> {
	const { record } = input;
	return withStatus((show) =>
		withInterrupt((signal) =>
			launchSet({
				client: input.client,
				recordId: record.id,
				site: record.spec.site,
				cells: record.cells,
				agents: input.agents,
				repeat: record.spec.repeat,
				signal,
				onProgress: ({ created, planned }) =>
					show(`${created} of ${planned} ${planned === 1 ? "journey" : "journeys"} created`),
				now: () => new Date(input.now()),
				dir: input.dir,
			}),
		),
	);
}

function stopCode(result: LaunchResult): string {
	if (result.stoppedReason === "interrupted") return "INTERRUPTED";
	if (result.stoppedReason === "platform_down") return "PLATFORM_DOWN";
	return failureCode(result.lastError);
}

/** Launching stopped with no report to follow: the stop, then view, and cancel once a run started. */
function launchStopped(result: LaunchResult, record: SetRecord, input: LaunchFlowInput): FlowEnd {
	const { json } = input;
	const steps: NextStep[] =
		record.journeys.length === 0
			? [{ call: input.runCall, why: "launches the same set again" }]
			: [viewStep(record.id, json)];
	if (result.launchedRuns > 0) steps.push(cancelStep(record.id, json));
	const [next, ...more] = steps;
	reportError({ code: stopCode(result), message: stopMessage(result).join("\n"), next }, { json });
	for (const step of more) printNext(step, { stderr: true });
	return result.stoppedReason === "interrupted" ? "interrupted" : "failed";
}

const LIST_STEP: NextStep = {
	call: axCall(["journey", "list"]),
	why: "see the sets recorded on this machine",
};

/** The record for `id`, for every set command; null once the refusal (an invalid, unknown or damaged record) is reported. */
export function pickUpRecord(id: string, json: boolean, dir?: string): SetRecord | null {
	const refuse = (code: string, message: string) => {
		reportError({ code, message, next: LIST_STEP }, { json });
		return null;
	};
	if (!isSetId(id)) {
		return refuse(
			"INVALID_SET_ID",
			`${JSON.stringify(plain(id))} is not a set id. Ids look like j-0123456789.`,
		);
	}
	try {
		return readRecord(id, dir) ?? refuse("UNKNOWN_SET", `No set ${id} on this machine.`);
	} catch (error) {
		if (!(error instanceof CorruptRecordError)) throw error;
		const file = `${id}.json`;
		const where = plain(join(dir ?? DEFAULT_SETS_DIR, file));
		return refuse(
			"CORRUPT_SET_RECORD",
			`The record ${file} is damaged, so ax cannot read it. It is at ${where}.`,
		);
	}
}

/**
 * Launch into the written record, then follow and report. A quota stop prints why and follows
 * what started; any other stop prints why and the commands to pick the set up, without
 * following: the platform is failing, or the person pressed Ctrl-C.
 */
export async function launchAndReport(input: LaunchFlowInput): Promise<FlowEnd> {
	const result = await launch(input);
	const record = readRecord(input.record.id, input.dir);
	if (!record) throw new Error(`the record of set ${input.record.id} is gone`);
	if (result.stoppedReason && result.stoppedReason !== "quota") {
		return launchStopped(result, record, input);
	}
	for (const line of stopMessage(result)) console.error(line);
	return followAndReport({ ...input, record });
}
