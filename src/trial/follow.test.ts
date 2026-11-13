import { afterEach, describe, expect, it, vi } from "vitest";
import detailFinal from "../api/__fixtures__/studio/journey-detail-final.json";
import detailRunning from "../api/__fixtures__/studio/journey-detail-running.json";
import { StudioApiError } from "../api/studio";
import type { JourneyAgentRun, JourneyDetail } from "../api/studio-types";
import {
	abortableSleep,
	type FollowInput,
	type FollowProgress,
	followJourneys,
	POLL_INTERVAL_MS,
	READ_FAILURE_LIMIT,
	SETTLE_WINDOW_MS,
} from "./follow";
import { DEFAULT_WAIT_MINUTES } from "./spec";

// Journey reads are M2.2's recorded fixtures (src/api/__fixtures__/studio/journey-detail-*.json,
// provenance in src/api/studio.test.ts), unwrapped from their { success, data } envelope as that
// test does. Each case changes only the fields it needs, through the named deltas below. The
// insight fake answers false where Studio answers its insight_not_ready 404; that body also says
// terminal: true once the run has ended (runs-api run-detail-proxy-routes.ts:80), and studio.ts
// maps it to false all the same, so every not-ready case here is the terminal one.

/** Run 0 running (started), run 1 queued (no startedAt). */
const RUNNING: JourneyDetail = detailRunning.data;
/** Both runs succeeded, with verdicts succeeded and failed. */
const FINAL: JourneyDetail = detailFinal.data;

function withRun(detail: JourneyDetail, index: number, delta: Partial<JourneyAgentRun>) {
	const agents = detail.agents.map((run, i) => (i === index ? { ...run, ...delta } : run));
	return { ...detail, agents };
}

/** Another journey of the same trial: the same read under new journey and run ids. */
function asJourney(detail: JourneyDetail, n: number): JourneyDetail {
	const agents = detail.agents.map((run) => ({ ...run, runId: `${run.runId}-${n}` }));
	return { ...detail, id: `${detail.id}-${n}`, agents };
}

/** Graded, and the judge has not written its verdict yet. */
const AWAITING = withRun(FINAL, 0, { verdict: "not_measured" });
/** Run 0 graded and awaiting its verdict, run 1 still queued. */
const MIXED = withRun(RUNNING, 0, {
	status: "succeeded",
	verdict: "not_measured",
	finishedAt: FINAL.agents[0].finishedAt,
});
/** Run 0 finished, run 1 started and running. */
const SECOND_RUNNING = withRun(FINAL, 1, {
	status: "running",
	verdict: null,
	finishedAt: null,
});
/** Run 0 canceled; Studio writes not_measured on a cancel (see outcome.test.ts). */
const CANCELED = withRun(FINAL, 0, { status: "canceled", verdict: "not_measured" });
/** A create where no agent started. */
const NOTHING_STARTED: JourneyDetail = { ...FINAL, agents: [] };

const ID = FINAL.id;
const RUN_0 = FINAL.agents[0].runId;

type Step<T> = T | Error;

/** Scripted reads per journey id and per run id; the last step repeats once a script runs out. */
function fakeStudio(
	journeys: Record<string, Step<JourneyDetail>[]>,
	insights: Record<string, Step<boolean>[]> = {},
) {
	const counts = { journey: new Map<string, number>(), insight: new Map<string, number>() };
	const next = <T>(script: Step<T>[] | undefined, count: Map<string, number>, id: string): T => {
		if (!script) throw new Error(`unscripted read of ${id}`);
		const n = count.get(id) ?? 0;
		count.set(id, n + 1);
		const step = script[Math.min(n, script.length - 1)];
		if (step instanceof Error) throw step;
		return step;
	};
	return {
		client: {
			journey: async (id: string) => next(journeys[id], counts.journey, id),
			insightLanded: async (runId: string) => next(insights[runId], counts.insight, runId),
		},
		reads: (id: string) => counts.journey.get(id) ?? 0,
		insightReads: (runId: string) => counts.insight.get(runId) ?? 0,
	};
}

/** A clock that only moves when follow sleeps or a test advances it. */
function fakeClock() {
	let t = 0;
	const sleeps: number[] = [];
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		sleep: async (ms: number) => {
			sleeps.push(ms);
			t += ms;
		},
		sleeps,
	};
}

function follow(
	client: FollowInput["client"],
	journeyIds: readonly string[],
	options: Partial<FollowInput> & { clock?: ReturnType<typeof fakeClock> } = {},
) {
	const { clock = fakeClock(), ...rest } = options;
	const progress: FollowProgress[] = [];
	const done = followJourneys({
		client,
		journeyIds,
		waitMinutes: DEFAULT_WAIT_MINUTES,
		now: clock.now,
		sleep: clock.sleep,
		onProgress: (p) => progress.push(p),
		...rest,
	});
	return { done, clock, progress };
}

describe("followJourneys", () => {
	it("pins its named constants", () => {
		expect([POLL_INTERVAL_MS, SETTLE_WINDOW_MS, READ_FAILURE_LIMIT]).toEqual([10_000, 600_000, 3]);
	});

	it("settles after one round when every run is final and graded, without sleeping", async () => {
		const studio = fakeStudio({ [ID]: [FINAL] });
		const { done, clock } = follow(studio.client, [ID]);
		const result = await done;
		expect(result.ended).toBe("settled");
		expect(result.journeys).toEqual(new Map([[ID, FINAL]]));
		expect(result.pendingGrades).toBe(0);
		expect(result).not.toHaveProperty("lastError");
		expect(clock.sleeps).toEqual([]);
		expect(studio.insightReads(RUN_0)).toBe(0);
	});

	it("settles a journey with no agents on its first read, and no journeys at once", async () => {
		const studio = fakeStudio({ [ID]: [NOTHING_STARTED] });
		expect((await follow(studio.client, [ID]).done).ended).toBe("settled");
		expect(studio.reads(ID)).toBe(1);
		expect((await follow(studio.client, []).done).ended).toBe("settled");
	});

	it("keeps polling a not_measured graded run while its insight is not ready", async () => {
		const studio = fakeStudio(
			{ [ID]: [AWAITING, AWAITING, AWAITING, FINAL] },
			{ [RUN_0]: [false] },
		);
		const { done, clock } = follow(studio.client, [ID]);
		const result = await done;
		expect(result.ended).toBe("settled");
		expect(result.journeys.get(ID)).toEqual(FINAL);
		expect(studio.reads(ID)).toBe(4);
		expect(studio.insightReads(RUN_0)).toBe(3);
		expect(clock.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
	});

	it("reads the journey once more after the insight lands, then settles on not_measured", async () => {
		const studio = fakeStudio({ [ID]: [AWAITING] }, { [RUN_0]: [false, true] });
		const result = await follow(studio.client, [ID]).done;
		expect(result.ended).toBe("settled");
		expect(result.journeys.get(ID)?.agents[0].verdict).toBe("not_measured");
		expect(result.pendingGrades).toBe(0);
		expect(studio.reads(ID)).toBe(3);
		expect(studio.insightReads(RUN_0)).toBe(2);
	});

	it("asks for no insight until every run in the journey is final, and none after it lands", async () => {
		const studio = fakeStudio({ [ID]: [MIXED, MIXED, AWAITING] }, { [RUN_0]: [true] });
		const result = await follow(studio.client, [ID]).done;
		expect(result.ended).toBe("settled");
		expect(studio.reads(ID)).toBe(4);
		expect(studio.insightReads(RUN_0)).toBe(1);
	});

	it("never asks for the insight of an excluded run, whatever its verdict", async () => {
		const studio = fakeStudio({ [ID]: [CANCELED] });
		const result = await follow(studio.client, [ID]).done;
		expect(result.ended).toBe("settled");
		expect(studio.insightReads(RUN_0)).toBe(0);
	});

	it("does not read a settled journey again", async () => {
		const other = asJourney(RUNNING, 2);
		const studio = fakeStudio({ [ID]: [FINAL], [other.id]: [other, other, asJourney(FINAL, 2)] });
		const result = await follow(studio.client, [ID, other.id]).done;
		expect(result.ended).toBe("settled");
		expect(studio.reads(ID)).toBe(1);
		expect(studio.reads(other.id)).toBe(3);
	});

	it("ends settle_limit when a grade is pending SETTLE_WINDOW_MS after the last run became final", async () => {
		const studio = fakeStudio({ [ID]: [RUNNING, AWAITING] }, { [RUN_0]: [false] });
		const { done, clock } = follow(studio.client, [ID]);
		const result = await done;
		expect(result.ended).toBe("settle_limit");
		expect(result.pendingGrades).toBe(1);
		expect(result.journeys.get(ID)).toEqual(AWAITING);
		expect(clock.now()).toBe(POLL_INTERVAL_MS + SETTLE_WINDOW_MS);
	});

	it("ends wait_limit with runs in flight, never sleeping past the wait deadline", async () => {
		const studio = fakeStudio({ [ID]: [RUNNING] });
		const clock = fakeClock();
		const slowRead = async (id: string) => {
			clock.advance(3_000);
			return studio.client.journey(id);
		};
		const client = { ...studio.client, journey: slowRead };
		const result = await follow(client, [ID], { clock, waitMinutes: 1 }).done;
		expect(result.ended).toBe("wait_limit");
		expect(result.pendingGrades).toBe(0);
		expect(clock.sleeps).toEqual([10_000, 10_000, 10_000, 10_000, 5_000]);
		expect(clock.now()).toBe(63_000);
	});

	it("ends settle_limit, not wait_limit, when the wait runs out with every run final", async () => {
		const studio = fakeStudio(
			{ [ID]: [RUNNING, RUNNING, RUNNING, AWAITING] },
			{ [RUN_0]: [false] },
		);
		const { done, clock } = follow(studio.client, [ID], { waitMinutes: 1 });
		const result = await done;
		expect(result.ended).toBe("settle_limit");
		expect(result.pendingGrades).toBe(1);
		expect(clock.now()).toBe(60_000);
	});
});

describe("followJourneys detaching", () => {
	it("detaches when the signal aborts mid sleep, keeping the last reads", async () => {
		const controller = new AbortController();
		const clock = fakeClock();
		const sleep = async (ms: number) => {
			await clock.sleep(ms);
			if (clock.sleeps.length === 2) controller.abort();
		};
		const studio = fakeStudio({ [ID]: [RUNNING, MIXED] });
		const options = { clock, sleep, signal: controller.signal };
		const result = await follow(studio.client, [ID], options).done;
		expect(result.ended).toBe("detached");
		expect(result.journeys.get(ID)).toEqual(MIXED);
		expect(result.pendingGrades).toBe(1);
		expect(studio.reads(ID)).toBe(2);
	});

	it("detaches when an injected sleep rejects on abort, and rethrows any other rejection", async () => {
		const controller = new AbortController();
		const studio = fakeStudio({ [ID]: [RUNNING] });
		const abortingSleep = async () => {
			controller.abort();
			throw new Error("sleep aborted");
		};
		const options = { sleep: abortingSleep, signal: controller.signal };
		expect((await follow(studio.client, [ID], options).done).ended).toBe("detached");

		const broken = new Error("timer broke");
		const brokenSleep = async () => {
			throw broken;
		};
		await expect(follow(studio.client, [ID], { sleep: brokenSleep }).done).rejects.toBe(broken);
	});

	it("detaches between reads without reading the next journey or reporting progress", async () => {
		const controller = new AbortController();
		const other = asJourney(RUNNING, 2);
		const studio = fakeStudio({ [ID]: [RUNNING], [other.id]: [other] });
		const abortingRead = async (id: string) => {
			controller.abort();
			return studio.client.journey(id);
		};
		const client = { ...studio.client, journey: abortingRead };
		const { done, progress } = follow(client, [ID, other.id], { signal: controller.signal });
		const result = await done;
		expect(result.ended).toBe("detached");
		expect([...result.journeys.keys()]).toEqual([ID]);
		expect(studio.reads(other.id)).toBe(0);
		expect(progress).toEqual([]);
	});

	it("detaches before any read when the signal has already aborted", async () => {
		const studio = fakeStudio({ [ID]: [RUNNING] });
		const result = await follow(studio.client, [ID], { signal: AbortSignal.abort() }).done;
		expect(result.ended).toBe("detached");
		expect(result.journeys.size).toBe(0);
		expect(studio.reads(ID)).toBe(0);
	});
});

describe("followJourneys read failures", () => {
	const unavailable = new StudioApiError("ora request failed (503)", {
		status: 503,
		payload: null,
		code: null,
		missingScopes: [],
	});

	it("retries a failed round, keeping its successful reads, past two failures in a row", async () => {
		const other = asJourney(RUNNING, 2);
		const studio = fakeStudio({
			[ID]: [unavailable, unavailable, FINAL],
			[other.id]: [other, asJourney(FINAL, 2)],
		});
		const result = await follow(studio.client, [ID, other.id]).done;
		expect(result.ended).toBe("settled");
		expect(studio.reads(ID)).toBe(3);
		expect(studio.reads(other.id)).toBe(2);
		expect([...result.journeys.keys()]).toEqual([ID, other.id]);
	});

	it("ends read_failed after READ_FAILURE_LIMIT failed rounds, with the error and the last good reads", async () => {
		const studio = fakeStudio({ [ID]: [RUNNING, unavailable] });
		const result = await follow(studio.client, [ID]).done;
		expect(result.ended).toBe("read_failed");
		expect(result.lastError).toBe(unavailable);
		expect(result.journeys.get(ID)).toEqual(RUNNING);
		expect(studio.reads(ID)).toBe(1 + READ_FAILURE_LIMIT);
	});

	it("resets the count after a round with no failure", async () => {
		const studio = fakeStudio({
			[ID]: [unavailable, unavailable, RUNNING, unavailable, unavailable, FINAL],
		});
		const result = await follow(studio.client, [ID]).done;
		expect(result.ended).toBe("settled");
		expect(studio.reads(ID)).toBe(6);
	});

	it("lets an error that is not the platform's propagate instead of retrying it", async () => {
		const bug = new RangeError("a bug in ax, not a failed read");
		const studio = fakeStudio({ [ID]: [bug] });
		await expect(follow(studio.client, [ID]).done).rejects.toBe(bug);
		expect(studio.reads(ID)).toBe(1);
	});

	it("counts a failed insight read as a failed round", async () => {
		const notFound = new StudioApiError("ora request failed (404 run_not_found)", {
			status: 404,
			payload: { error: "run_not_found" },
			code: "run_not_found",
			missingScopes: [],
		});
		const studio = fakeStudio({ [ID]: [AWAITING] }, { [RUN_0]: [notFound] });
		const result = await follow(studio.client, [ID]).done;
		expect(result.ended).toBe("read_failed");
		expect(result.lastError).toBe(notFound);
		expect(result.journeys.get(ID)).toEqual(AWAITING);
		expect(result.pendingGrades).toBe(1);
		expect(studio.insightReads(RUN_0)).toBe(READ_FAILURE_LIMIT);
	});
});

describe("followJourneys progress", () => {
	it("counts queued, running and finished runs after each round, settled journeys included", async () => {
		const other = asJourney(FINAL, 2);
		const studio = fakeStudio({ [ID]: [RUNNING, SECOND_RUNNING, FINAL], [other.id]: [other] });
		const { done, progress } = follow(studio.client, [ID, other.id]);
		expect((await done).ended).toBe("settled");
		expect(progress).toEqual([
			{ queued: 1, running: 1, finished: 2, waitingForSlot: true },
			{ queued: 0, running: 1, finished: 3, waitingForSlot: false },
			{ queued: 0, running: 0, finished: 4, waitingForSlot: false },
		]);
		expect(studio.reads(other.id)).toBe(1);
	});
});

describe("abortableSleep", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves after the given time", async () => {
		vi.useFakeTimers();
		let woke = false;
		const sleeping = abortableSleep(POLL_INTERVAL_MS).then(() => {
			woke = true;
		});
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
		expect(woke).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await sleeping;
		expect(woke).toBe(true);
	});

	it("resolves as soon as the signal aborts and clears its timer", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const sleeping = abortableSleep(POLL_INTERVAL_MS, controller.signal);
		controller.abort();
		await sleeping;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("resolves at once on a signal that has already aborted", async () => {
		vi.useFakeTimers();
		await abortableSleep(POLL_INTERVAL_MS, AbortSignal.abort());
		expect(vi.getTimerCount()).toBe(0);
	});
});
