// Turns the local record and the latest journey reads into one CountedRun per launched goal,
// level, repeat and agent, plus the SetShape countSet needs. This is the only producer of
// CountedRun and the only caller of runBucket. It prints nothing and decides no grade: Studio's
// status and verdict go through outcome.ts, and flags come from flags.ts over the stored steps.

import { isStudioFailure } from "../api/studio";
import type { JourneyAgentRun, JourneyDetail, StudioClient } from "../api/studio-types";
import type { CountedRun, SetShape } from "./count";
import { deriveSetFlags } from "./flags";
import type { Level } from "./levels";
import { type RunFacts, runBucket, runPhase } from "./outcome";
import type { JourneyEntry, SetRecord } from "./record";
import type { AgentChoice } from "./spec";

/** The column for a run that has no row to name its agent and no resolved agent left to take it. */
export const UNKNOWN_AGENT = "unknown";

export interface CollectInput {
	record: SetRecord;
	/** Whatever the last read returned; a journey that was never read is simply absent. */
	journeys: readonly JourneyDetail[];
	client: Pick<StudioClient, "trajectory">;
}

export interface CollectResult {
	runs: CountedRun[];
	shape: SetShape;
	/** Graded runs whose trajectory read failed; their flags are null. */
	trajectoryFailures: number;
}

/** The status given to a run no read has listed: outside both status sets, so it is in flight. */
const UNSEEN_STATUS = "unseen";

/** A run before its flags are read. */
interface Pending {
	run: CountedRun;
	/** Set only on a graded run: the one whose trajectory is read. */
	gradedRunId?: string;
}

/** `harness/model`, or the bare harness when there is no model (Shared vocabulary 10). */
function agentLabel(agent: { harness: string; model?: string | null }): string {
	return agent.model ? `${agent.harness}/${agent.model}` : agent.harness;
}

/**
 * The column an item belongs to: its label when that is a resolved label; the one resolved agent
 * with its harness when there is exactly one; otherwise its own label, which the shape then adds.
 */
function columnFor(
	item: { harness: string; model?: string | null },
	resolved: readonly AgentChoice[],
): string {
	const own = agentLabel(item);
	if (resolved.some((agent) => agentLabel(agent) === own)) return own;
	const sameHarness = resolved.filter((agent) => agent.harness === item.harness);
	return sameHarness.length === 1 ? agentLabel(sameHarness[0]) : own;
}

function cellOf(entry: JourneyEntry): { goalIndex: number; level: Level; repeat: number } {
	return { goalIndex: entry.goalIndex, level: entry.level, repeat: entry.repeat };
}

function neverStarted(entry: JourneyEntry, resolved: readonly AgentChoice[]): Pending[] {
	return entry.failed.map((item) => ({
		run: {
			...cellOf(entry),
			agent: columnFor(item, resolved),
			...runBucket({ started: false, reason: item.reason }),
			flags: null,
		},
	}));
}

function startedRun(
	entry: JourneyEntry,
	row: JourneyAgentRun,
	resolved: readonly AgentChoice[],
): Pending {
	const facts: RunFacts = { started: true, status: row.status, verdict: row.verdict };
	const run: CountedRun = {
		...cellOf(entry),
		agent: columnFor(row, resolved),
		...runBucket(facts),
		flags: null,
	};
	return runPhase(row.status) === "graded" ? { run, gradedRunId: row.runId } : { run };
}

/** Run ids the journey reads did not list are in flight as far as ax knows. */
function unseenRuns(
	entry: JourneyEntry,
	claimed: ReadonlySet<string>,
	resolved: readonly AgentChoice[],
	count: number,
): Pending[] {
	const free = resolved.map(agentLabel).filter((label) => !claimed.has(label));
	return Array.from({ length: count }, (_, index) => ({
		run: {
			...cellOf(entry),
			agent: free[index] ?? UNKNOWN_AGENT,
			...runBucket({ started: true, status: UNSEEN_STATUS }),
			flags: null,
		},
	}));
}

/**
 * Every run id the entry started: its row when the journey read lists it, else in flight.
 * Rows outside `runIds` are ignored: Studio writes a journey binding before it creates the run,
 * so an agent that failed to start can leave a row that `failed[]` already counted.
 */
function startedRuns(
	entry: JourneyEntry,
	detail: JourneyDetail | undefined,
	resolved: readonly AgentChoice[],
): Pending[] {
	const rows = new Map((detail?.agents ?? []).map((row) => [row.runId, row]));
	const found: Pending[] = [];
	let unseen = 0;
	for (const runId of new Set(entry.runIds)) {
		const row = rows.get(runId);
		if (row) found.push(startedRun(entry, row, resolved));
		else unseen += 1;
	}
	const claimed = new Set([
		...entry.failed.map((item) => columnFor(item, resolved)),
		...found.map((pending) => pending.run.agent),
	]);
	return [...found, ...unseenRuns(entry, claimed, resolved, unseen)];
}

/** One read per graded run, in sequence; a failed read leaves flags null and is counted. */
async function readFlags(
	pending: readonly Pending[],
	site: string,
	client: Pick<StudioClient, "trajectory">,
): Promise<number> {
	let failures = 0;
	for (const { run, gradedRunId } of pending) {
		if (gradedRunId === undefined) continue;
		try {
			const { steps } = await client.trajectory(gradedRunId);
			run.flags = deriveSetFlags(steps, site);
		} catch (error) {
			if (!isStudioFailure(error)) throw error;
			failures += 1;
		}
	}
	return failures;
}

function buildShape(record: SetRecord, runs: readonly CountedRun[]): SetShape {
	const agents = record.agents.map(agentLabel);
	for (const run of runs) if (!agents.includes(run.agent)) agents.push(run.agent);
	return {
		goals: record.spec.goals,
		levelsByGoal: record.spec.goals.map((_, goalIndex) =>
			record.cells.filter((cell) => cell.goalIndex === goalIndex).map((cell) => cell.level),
		),
		agents,
		plannedPerCell: record.spec.repeat,
	};
}

export async function collectSet(input: CollectInput): Promise<CollectResult> {
	const { record, journeys, client } = input;
	const details = new Map(journeys.map((journey) => [journey.id, journey]));
	const pending: Pending[] = [];
	for (const entry of record.journeys) {
		const detail = entry.journeyId === null ? undefined : details.get(entry.journeyId);
		pending.push(
			...neverStarted(entry, record.agents),
			...startedRuns(entry, detail, record.agents),
		);
	}
	const trajectoryFailures = await readFlags(pending, record.spec.site, client);
	const runs = pending.map((item) => item.run);
	return { runs, shape: buildShape(record, runs), trajectoryFailures };
}
