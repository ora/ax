// How one run of a set counts. Studio owns every grade: this maps the status it reports and the
// verdict it wrote into a bucket, status first, and judges nothing itself. It is the only place a
// run's bucket is derived.

/** Final statuses whose verdict counts. */
export const GRADED_STATUSES: readonly string[] = ["succeeded", "completed"];

/**
 * Final statuses that never count against the site: the platform's fault (a harness crash is
 * stored as failed, the stuck run reaper writes lost) or the caller's choice (a cancel). Studio's
 * own verdict calls most of them failed; a set excludes them instead.
 */
export const EXCLUDED_STATUSES: readonly string[] = [
	"failed",
	"timeout",
	"timed_out",
	"error",
	"canceled",
	"cancelled",
	"lost",
];

export type RunPhase = "in_flight" | "graded" | "excluded";

export type Bucket =
	| "satisfied"
	| "partial"
	| "unsatisfied"
	| "not_graded_yet"
	| "not_gradable"
	| "excluded"
	| "in_flight";

/** A run that never started (a create's failed[] entry or a 502), or its latest status and verdict. */
export type RunFacts =
	| { started: false; reason: string }
	| { started: true; status: string; verdict?: string | null };

export interface RunOutcome {
	bucket: Bucket;
	/** The final status of an excluded run that started. */
	rawStatus?: string;
	/** The verdict as Studio wrote it, on a not gradable run. */
	rawVerdict?: string;
	/** Why an excluded run never started. */
	reason?: string;
}

const NOT_MEASURED = "not_measured";

// A Map, not an object literal: the verdict is a server string, and "constructor" must not resolve.
const VERDICT_BUCKETS = new Map<string, Bucket>([
	["succeeded", "satisfied"],
	["partial", "partial"],
	["failed", "unsatisfied"],
	[NOT_MEASURED, "not_graded_yet"],
]);

/** Any status outside both sets is still in flight. */
export function runPhase(status: string): RunPhase {
	if (GRADED_STATUSES.includes(status)) return "graded";
	if (EXCLUDED_STATUSES.includes(status)) return "excluded";
	return "in_flight";
}

/** A graded run whose verdict the judge has not written yet. */
export function awaitsGrade(status: string, verdict: string | null | undefined): boolean {
	return runPhase(status) === "graded" && (verdict == null || verdict === NOT_MEASURED);
}

export function runBucket(run: RunFacts): RunOutcome {
	if (!run.started) return { bucket: "excluded", reason: run.reason };
	const phase = runPhase(run.status);
	if (phase === "excluded") return { bucket: "excluded", rawStatus: run.status };
	if (phase === "in_flight") return { bucket: "in_flight" };
	if (run.verdict == null) return { bucket: "not_graded_yet" };
	const bucket = VERDICT_BUCKETS.get(run.verdict);
	return bucket ? { bucket } : { bucket: "not_gradable", rawVerdict: run.verdict };
}
