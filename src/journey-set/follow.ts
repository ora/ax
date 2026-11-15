import { isStudioFailure } from "../api/studio";
import type { JourneyAgentRun, JourneyDetail, StudioClient } from "../api/studio-types";
import { awaitsGrade, runPhase } from "./outcome";

// Follows a set's journeys on Studio until every run is final and its grade has settled, or a
// limit is reached. It prints nothing: progress goes to a callback and the ending is returned.
// It never exchanges keys; the client refreshes its own bearer.

/** Time between two rounds of reads. */
export const POLL_INTERVAL_MS = 10_000;

/**
 * How long grades may stay pending after the last run became final. It is the only bound on
 * waiting for an insight: the not-ready 404 says `terminal: true` as soon as the run has ended
 * (runs-api run-detail-proxy-routes.ts:80), and grading happens after that, so the flag never
 * means the insight will not come.
 */
export const SETTLE_WINDOW_MS = 600_000;

/** Failed rounds in a row that end following. */
export const READ_FAILURE_LIMIT = 3;

const MINUTE_MS = 60_000;

export type FollowEnd = "settled" | "settle_limit" | "wait_limit" | "detached" | "read_failed";

export interface FollowProgress {
	/** In flight and not started yet. */
	queued: number;
	/** In flight and started. */
	running: number;
	/** Final: graded or excluded. */
	finished: number;
	/** A run is queued, waiting for the plan's run slot. */
	waitingForSlot: boolean;
}

export interface FollowInput {
	client: Pick<StudioClient, "journey" | "insightLanded">;
	/** The record's journeys that have an id. */
	journeyIds: readonly string[];
	/** Counted from the start of following. */
	waitMinutes: number;
	/** Aborting detaches; the runs keep going on Studio. */
	signal?: AbortSignal;
	now: () => number;
	/** May resolve early or reject when the signal aborts; follow reads the signal afterwards. */
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Called after every round of reads. */
	onProgress?: (progress: FollowProgress) => void;
}

export interface FollowResult {
	/**
	 * The latest successful read of each journey, keyed by journey id in the order of
	 * `journeyIds`. A journey that never read successfully is absent.
	 */
	journeys: Map<string, JourneyDetail>;
	ended: FollowEnd;
	/** Runs still awaiting a grade when following ended. */
	pendingGrades: number;
	/** The error of the last failed read; set only when `ended` is `read_failed`. */
	lastError?: unknown;
}

interface FollowState {
	details: Map<string, JourneyDetail>;
	settled: Set<string>;
	/** Runs whose insight has landed, and whether their journey has been read since. */
	landed: Map<string, boolean>;
}

interface Round {
	aborted: boolean;
	failed: boolean;
	error?: unknown;
}

export async function followJourneys(input: FollowInput): Promise<FollowResult> {
	const state: FollowState = { details: new Map(), settled: new Set(), landed: new Map() };
	const waitDeadline = input.now() + input.waitMinutes * MINUTE_MS;
	let failedRounds = 0;
	let allFinalAt: number | undefined;
	for (;;) {
		const round = await readRound(input, state);
		if (round.aborted) return result(input, state, "detached");
		input.onProgress?.(progressOf(state));
		const now = input.now();
		allFinalAt = everyRunFinal(input.journeyIds, state) ? (allFinalAt ?? now) : undefined;
		failedRounds = round.failed ? failedRounds + 1 : 0;
		const settleDeadline =
			allFinalAt === undefined ? Number.POSITIVE_INFINITY : allFinalAt + SETTLE_WINDOW_MS;
		// Settled wins over an abort that arrived during this round's reads: nothing is left running.
		if (input.journeyIds.every((id) => state.settled.has(id))) {
			return result(input, state, "settled");
		}
		if (input.signal?.aborted) return result(input, state, "detached");
		if (failedRounds >= READ_FAILURE_LIMIT) {
			return result(input, state, "read_failed", round.error);
		}
		if (now >= Math.min(settleDeadline, waitDeadline)) {
			return result(input, state, allFinalAt === undefined ? "wait_limit" : "settle_limit");
		}
		const ms = Math.min(POLL_INTERVAL_MS, settleDeadline - now, waitDeadline - now);
		if (!(await pause(input, ms))) return result(input, state, "detached");
	}
}

/** A real sleep for `followJourneys`: resolves after `ms`, or as soon as the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

/** One read of every journey not settled yet, in order, stopping at an abort. */
async function readRound(input: FollowInput, state: FollowState): Promise<Round> {
	const round: Round = { aborted: false, failed: false };
	for (const id of input.journeyIds) {
		if (state.settled.has(id)) continue;
		await readJourney(input, state, id, round);
		if (round.aborted) break;
	}
	return round;
}

async function readJourney(
	input: FollowInput,
	state: FollowState,
	id: string,
	round: Round,
): Promise<void> {
	if (input.signal?.aborted) {
		round.aborted = true;
		return;
	}
	let detail: JourneyDetail;
	try {
		detail = await input.client.journey(id);
	} catch (error) {
		// The platform's failures fail the round and are retried; READ_FAILURE_LIMIT bounds them.
		if (!isStudioFailure(error)) throw error;
		failRound(round, error);
		return;
	}
	state.details.set(id, detail);
	for (const run of detail.agents) {
		if (state.landed.has(run.runId)) state.landed.set(run.runId, true);
	}
	if (!detail.agents.every(isFinal)) return;
	for (const run of detail.agents) {
		if (!awaitsGrade(run.status, run.verdict) || state.landed.has(run.runId)) continue;
		if (input.signal?.aborted) {
			round.aborted = true;
			return;
		}
		await readInsight(input, state, run.runId, round);
	}
	if (detail.agents.every((run) => gradeSettled(run, state))) state.settled.add(id);
}

/** A landed insight still needs one more read of its journey: the verdict is written after it. */
async function readInsight(
	input: FollowInput,
	state: FollowState,
	runId: string,
	round: Round,
): Promise<void> {
	try {
		if (await input.client.insightLanded(runId)) state.landed.set(runId, false);
	} catch (error) {
		// Same rule as a journey read: the round fails and is retried.
		if (!isStudioFailure(error)) throw error;
		failRound(round, error);
	}
}

/** Sleeps between rounds; false when the signal aborted during the sleep. */
async function pause(input: FollowInput, ms: number): Promise<boolean> {
	try {
		await input.sleep(ms, input.signal);
	} catch (error) {
		// An injected sleep may reject on abort; any other rejection is a real failure.
		if (!input.signal?.aborted) throw error;
	}
	return !input.signal?.aborted;
}

function failRound(round: Round, error: unknown): void {
	round.failed = true;
	round.error = error;
}

function isFinal(run: JourneyAgentRun): boolean {
	return runPhase(run.status) !== "in_flight";
}

/** No grade to wait for, or the insight landed and the journey was read again after it. */
function gradeSettled(run: JourneyAgentRun, state: FollowState): boolean {
	return !awaitsGrade(run.status, run.verdict) || state.landed.get(run.runId) === true;
}

function everyRunFinal(journeyIds: readonly string[], state: FollowState): boolean {
	return journeyIds.every((id) => state.details.get(id)?.agents.every(isFinal) === true);
}

function allRuns(state: FollowState): JourneyAgentRun[] {
	return [...state.details.values()].flatMap((detail) => detail.agents);
}

function progressOf(state: FollowState): FollowProgress {
	const progress = { queued: 0, running: 0, finished: 0 };
	for (const run of allRuns(state)) {
		if (isFinal(run)) progress.finished++;
		else if (run.startedAt) progress.running++;
		else progress.queued++;
	}
	return { ...progress, waitingForSlot: progress.queued > 0 };
}

function result(
	input: FollowInput,
	state: FollowState,
	ended: FollowEnd,
	lastError?: unknown,
): FollowResult {
	const journeys = new Map<string, JourneyDetail>();
	for (const id of input.journeyIds) {
		const detail = state.details.get(id);
		if (detail) journeys.set(id, detail);
	}
	const pendingGrades = allRuns(state).filter((run) => !gradeSettled(run, state)).length;
	const base = { journeys, ended, pendingGrades };
	return ended === "read_failed" ? { ...base, lastError } : base;
}
