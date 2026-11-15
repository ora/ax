import { PlatformApiError } from "../api/platform";
import { isStudioFailure, notStartedJourney, StudioApiError } from "../api/studio";
import type {
	CreatedJourney,
	CreateFailure,
	StudioAgentPair,
	StudioClient,
} from "../api/studio-types";
import {
	appendJourney,
	type FailedAgent,
	type JourneyEntry,
	markStopped,
	type StoppedReason,
} from "./record";
import type { PlannedCell } from "./spec";

// Launches a set's journeys against Studio, one create per cell and repeat, and records each one
// the moment it returns, so a crash or Ctrl-C leaves a record that `ax journey view` and
// `ax journey cancel` can pick up. It prints nothing: the progress callback reports state and a
// later module renders.
// Order is repeat first (every cell once, then every cell again), so a set cut short has the
// same cells at every level of help rather than only the first goals. There is no sleep between
// creates; Studio queues runs beyond the plan's slot count itself.

/** Studio's own no-agent-started 502s in a row that stop launching: the platform is not starting runs. */
export const STUDIO_502_LIMIT = 3;

export interface LaunchInput {
	client: Pick<StudioClient, "createJourney">;
	/** The record created before the first create; every entry and the stop are written to it. */
	recordId: string;
	/** Sent as `targetDomain` on every create. */
	site: string;
	/** The planned cells in goal, then ladder order (`planCells`). */
	cells: readonly PlannedCell[];
	/** The resolved agents; every create sends all of them. */
	agents: readonly StudioAgentPair[];
	repeat: number;
	/** Checked before each create; a create in flight is never aborted. */
	signal?: AbortSignal;
	/** Called after each journey is recorded; `planned` counts journeys (cells times repeats). */
	onProgress?: (progress: LaunchProgress) => void;
	now?: () => Date;
	/** The record directory; tests pass a temp one. */
	dir?: string;
}

export interface LaunchProgress {
	created: number;
	planned: number;
}

export interface LaunchResult {
	/** Runs that started, summed over the recorded journeys. */
	launchedRuns: number;
	/** Runs of the creates that were never recorded, `agents.length` each. */
	notLaunched: number;
	stoppedReason?: StoppedReason;
	/** The error that stopped launching; unset for a clean launch and for `interrupted`. */
	lastError?: unknown;
}

/** A create's failed agents as the record keeps them: harness, model and the server's reason, raw. */
function failedAgents(failed: readonly CreateFailure[]): FailedAgent[] {
	return failed.map(({ harness, model, reason }) => ({
		harness,
		...(model !== undefined && { model }),
		reason,
	}));
}

/**
 * Why a create that failed on the platform stops launching. Studio's own 502 is handled before
 * this (it is recorded, not a stop). A gateway 502, no connection, or an answer of the wrong shape
 * leave it unknown whether the create landed, so they read as the platform being down; a 402 is
 * the plan's quota; every other HTTP failure, a bearer refresh failing mid launch included, is an
 * API error.
 */
function stopReasonOf(error: unknown): StoppedReason {
	if (error instanceof StudioApiError && error.gateway) return "platform_down";
	if (error instanceof StudioApiError && error.status === 402) return "quota";
	if (error instanceof PlatformApiError) return "api_error";
	return "platform_down";
}

/**
 * Run every create. Stops on the first of: an abort, a quota, an API error, a gateway or network
 * failure, or three Studio 502s in a row. A stop is written to the record with the runs that never
 * started; a clean launch writes nothing beyond its entries. A failure to write the record
 * itself propagates: launching blind would leave journeys no one can find.
 */
export async function launchSet(input: LaunchInput): Promise<LaunchResult> {
	const { client, recordId, site, cells, agents, repeat, signal, onProgress, dir } = input;
	const now = input.now ?? (() => new Date());
	const planned = cells.length * repeat;
	let recorded = 0;
	let launchedRuns = 0;
	let studio502sInARow = 0;

	const record = (entry: Omit<JourneyEntry, "createdAt">): void => {
		appendJourney(recordId, { ...entry, createdAt: now().toISOString() }, dir);
		recorded++;
		launchedRuns += entry.runIds.length;
		onProgress?.({ created: recorded, planned });
	};

	const stop = (stoppedReason: StoppedReason, lastError?: unknown): LaunchResult => {
		const notLaunched = (planned - recorded) * agents.length;
		markStopped(recordId, stoppedReason, notLaunched, dir);
		return {
			launchedRuns,
			notLaunched,
			stoppedReason,
			...(lastError !== undefined && { lastError }),
		};
	};

	for (let n = 0; n < planned; n++) {
		if (signal?.aborted) return stop("interrupted");
		const cell = cells[n % cells.length];
		const place = {
			goalIndex: cell.goalIndex,
			level: cell.level,
			repeat: Math.floor(n / cells.length) + 1,
		};
		// Only the create sits in the try: a failure writing the record must propagate, not read as a stop.
		let created: CreatedJourney;
		try {
			created = await client.createJourney({
				goal: cell.prompt,
				agents: [...agents],
				targetDomain: site,
			});
		} catch (error) {
			if (!isStudioFailure(error)) throw error;
			const notStarted = notStartedJourney(error);
			if (!notStarted) return stop(stopReasonOf(error), error);
			record({
				journeyId: notStarted.journeyId,
				...place,
				runIds: [],
				failed: failedAgents(notStarted.failed),
			});
			studio502sInARow++;
			if (studio502sInARow >= STUDIO_502_LIMIT) return stop("platform_down", error);
			continue;
		}
		studio502sInARow = 0;
		record({
			journeyId: created.journeyId,
			...place,
			runIds: created.runIds,
			failed: failedAgents(created.failed),
		});
	}
	return { launchedRuns, notLaunched: 0 };
}
