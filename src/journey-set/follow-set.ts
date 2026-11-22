import type { SetDocument, SetsClient } from "../api/sets";
import { LineProgress, type SetProgress } from "./set-progress";

// FOLLOWING A SET until it is over, the wait runs out or Ctrl-C detaches. The runs go on at the platform either way:
// following only watches. Without --watch, a line each time the state changes, from a read every few seconds. With
// --watch, every document goes to the progress (set-progress.ts), from the platform's live stream, and from reads
// where the stream ends early.

const POLL_MS = 5_000;

/** The clock following waits on. Tests hand in their own. */
export interface FollowClock {
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

export type FollowEnd = "complete" | "stopped" | "failed" | "wait_limit" | "detached";

/**
 * Read the set until it is over, the wait runs out or Ctrl-C detaches. The runs go on at the
 * platform either way: following only watches. One line on stderr each time the state changes.
 */
export async function followSet(
	client: SetsClient,
	first: SetDocument,
	options: {
		waitMinutes: number;
		interrupt: AbortSignal;
		watch?: boolean;
		progress?: SetProgress;
	} & FollowClock,
): Promise<{ set: SetDocument; end: FollowEnd }> {
	if (!options.watch) return readUntilOver(client, first, options);
	const progress = options.progress ?? new LineProgress();
	try {
		return await watchUntilOver(client, first, options, progress);
	} finally {
		progress.close();
	}
}

/** Without --watch: a line each time the state changes, reading the set every few seconds. */
async function readUntilOver(
	client: SetsClient,
	first: SetDocument,
	options: { waitMinutes: number; interrupt: AbortSignal } & FollowClock,
): Promise<{ set: SetDocument; end: FollowEnd }> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? abortableSleep;
	const deadline = now() + options.waitMinutes * 60_000;
	let set = first;
	let said = "";
	for (;;) {
		if (set.state === "complete" || set.state === "stopped" || set.state === "failed")
			return { set, end: set.state };
		const line = `${set.state}: ${set.runs.started} of ${set.runs.planned} runs started`;
		if (line !== said) console.error(`  ${line}`);
		said = line;
		if (options.interrupt.aborted) return { set, end: "detached" };
		if (now() >= deadline) return { set, end: "wait_limit" };
		await sleep(POLL_MS, options.interrupt);
		if (options.interrupt.aborted) return { set, end: "detached" };
		set = await client.get(set.setId);
	}
}

/** With --watch: every document to the progress, from the live stream, or from reads where the stream ends early. */
async function watchUntilOver(
	client: SetsClient,
	first: SetDocument,
	options: { waitMinutes: number; interrupt: AbortSignal } & FollowClock,
	progress: SetProgress,
): Promise<{ set: SetDocument; end: FollowEnd }> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? abortableSleep;
	const deadline = now() + options.waitMinutes * 60_000;
	progress.show(first);
	const live = await watchSet(
		client,
		first,
		{ deadline, now, interrupt: options.interrupt },
		progress,
	);
	if (live.end !== null) return { set: live.set, end: live.end };
	// ora closes a study's live stream once it is settled, or (on a platform that predates that) a minute after its
	// last run: a stream ora ended while the set was grading is not a failure, so ax reads on and says nothing about
	// it. Any other end (it would not open, or broke while runs were going) is said.
	if (!(live.closedByOra && live.set.state === "grading"))
		progress.note("Live updates are not available right now; checking every few seconds.");
	let set = live.set;
	for (;;) {
		if (set.state === "complete" || set.state === "stopped" || set.state === "failed")
			return { set, end: set.state };
		if (options.interrupt.aborted) return { set, end: "detached" };
		if (now() >= deadline) return { set, end: "wait_limit" };
		await sleep(POLL_MS, options.interrupt);
		if (options.interrupt.aborted) return { set, end: "detached" };
		set = await client.get(set.setId);
		progress.show(set);
	}
}

/**
 * Follow the set over the platform's live stream, handing each document to the progress. `end` is null
 * when the stream could not say how the set ended (it would not open, or closed early): the caller
 * then reads the set instead. `closedByOra` says the stream ended on ora's side, normally (not an
 * error, not our own close). The wait limit and Ctrl-C close the stream; the runs go on.
 */
async function watchSet(
	client: SetsClient,
	first: SetDocument,
	options: { deadline: number; now: () => number; interrupt: AbortSignal },
	progress: SetProgress,
): Promise<{ set: SetDocument; end: FollowEnd | null; closedByOra: boolean }> {
	const over = (set: SetDocument): FollowEnd | null =>
		set.state === "complete" || set.state === "stopped" || set.state === "failed"
			? set.state
			: null;
	if (over(first)) return { set: first, end: over(first), closedByOra: false };
	const stop = new AbortController();
	let outOfTime = false;
	const timer = setTimeout(
		() => {
			outOfTime = true;
			stop.abort();
		},
		Math.max(0, options.deadline - options.now()),
	);
	const onInterrupt = () => stop.abort();
	options.interrupt.addEventListener("abort", onInterrupt, { once: true });
	let latest = first;
	let closedByOra = false;
	try {
		await client.follow(
			first.setId,
			(set) => {
				progress.show(set);
				latest = set;
			},
			stop.signal,
		);
		closedByOra = !stop.signal.aborted;
	} catch (error) {
		// A stream we closed ourselves is not a failure; any other one falls back to reading.
		if (!stop.signal.aborted && !(error instanceof Error)) throw error;
	} finally {
		clearTimeout(timer);
		options.interrupt.removeEventListener("abort", onInterrupt);
	}
	if (options.interrupt.aborted) return { set: latest, end: "detached", closedByOra };
	if (outOfTime) return { set: latest, end: "wait_limit", closedByOra };
	return { set: latest, end: over(latest), closedByOra };
}
