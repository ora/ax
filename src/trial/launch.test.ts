import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import quota402 from "../api/__fixtures__/studio/error-402-quota.json";
import created from "../api/__fixtures__/studio/journey-create.json";
import createdPartial from "../api/__fixtures__/studio/journey-create-partial.json";
import { PlatformApiError } from "../api/platform";
import { createStudioClient, StudioApiError, StudioConnectionError } from "../api/studio";
import type { StudioAgentPair } from "../api/studio-types";
import { type LaunchProgress, type LaunchResult, launchTrial } from "./launch";
import { createRecord, readRecord, type TrialRecord } from "./record";
import { type PlannedCell, parseTrialSpec, planCells } from "./spec";

// Every case drives a real createStudioClient through a mocked fetch, so each error has the shape
// the client really throws. Fixtures: src/api/__fixtures__/studio/ (provenance in studio.test.ts).

const BASE = "https://platform.test";
const SITE = "linear.app";
const AGENTS: StudioAgentPair[] = [
	{ harness: "claude-code", model: "claude-haiku-4-5-20251001" },
	{ harness: "claude-code", model: "claude-sonnet-5-5" },
];

const asJson = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

// Studio's own 502 on create: nothing started, the journey id kept, every agent in failed[].
// Delta on journey-create-partial.json, as studio.test.ts builds it.
const NONE_STARTED_502 = {
	...createdPartial,
	success: false,
	data: {
		...createdPartial.data,
		runIds: [],
		streamUrls: [],
		failed: [
			{ ...createdPartial.data.failed[0], model: AGENTS[0].model },
			createdPartial.data.failed[0],
		],
	},
};

type Reply = () => Response | Promise<Response>;

const ok: Reply = () => asJson(created, 201);
const partial: Reply = () => asJson(createdPartial, 201);
const studio502: Reply = () => asJson(NONE_STARTED_502, 502);
const gateway502: Reply = () => new Response("<html>bad gateway</html>", { status: 502 });
const quota: Reply = () => asJson(quota402, 402);
const serverError: Reply = () => asJson({ error: "boom", code: "internal" }, 500);
const networkError: Reply = () => {
	throw new TypeError("fetch failed");
};

/** Answers the key exchange, then each create from `replies` in turn; a create past the script fails loudly. */
function studioMock(replies: Reply[], exchange: Reply = () => asJson({ token: "bearer" })) {
	const bodies: Array<Record<string, unknown>> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init: RequestInit = {}) => {
			const at = String(url);
			if (at.endsWith("/auth/token")) return exchange();
			if (init.method !== "POST" || at !== `${BASE}/studio/v1/journeys`) {
				throw new Error(`unrouted ${init.method} ${at}`);
			}
			bodies.push(JSON.parse(String(init.body)));
			const reply = replies[bodies.length - 1];
			if (!reply) throw new Error(`create ${bodies.length} is past the script`);
			return reply();
		}),
	);
	return { bodies };
}

const client = () => createStudioClient({ apiKey: "ora_sk_local", baseUrl: BASE });

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ax-trial-launch-"));
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

/** Two tasks that name the site, so the need level is skipped: two levels each (brand, exact). */
function plan(repeat: number): { cells: PlannedCell[]; record: TrialRecord } {
	const parsed = parseTrialSpec({
		site: SITE,
		tasks: ["Create an issue on linear.app", "Plan a sprint on linear.app"],
		exact: "https://linear.app/developers",
		repeat: String(repeat),
	});
	if (!parsed.ok) throw new Error(parsed.error);
	const { cells } = planCells(parsed.spec);
	const record = createRecord({ spec: parsed.spec, agents: AGENTS, cells }, dir);
	return { cells, record };
}

function launch(
	record: TrialRecord,
	cells: PlannedCell[],
	extra: { signal?: AbortSignal; onProgress?: (p: LaunchProgress) => void } = {},
): Promise<LaunchResult> {
	return launchTrial({
		client: client(),
		recordId: record.id,
		site: SITE,
		cells,
		agents: AGENTS,
		repeat: record.spec.repeat,
		dir,
		...extra,
	});
}

/** The record on disk says what the launch returned. */
function expectRecordMatches(record: TrialRecord, result: LaunchResult): TrialRecord {
	const onDisk = readRecord(record.id, dir);
	if (!onDisk) throw new Error("record vanished");
	const started = onDisk.journeys.reduce((sum, journey) => sum + journey.runIds.length, 0);
	expect(started).toBe(result.launchedRuns);
	expect(onDisk.stoppedReason).toBe(result.stoppedReason);
	expect(onDisk.notLaunched).toBe(result.stoppedReason ? result.notLaunched : undefined);
	return onDisk;
}

describe("launchTrial", () => {
	it("launches repeat first, then task, then level, with every agent and only targetDomain", async () => {
		const { cells, record } = plan(2);
		expect(cells.map(({ task, level }) => `${task}:${level}`)).toEqual([
			"0:brand",
			"0:exact",
			"1:brand",
			"1:exact",
		]);
		const { bodies } = studioMock(Array(8).fill(ok));
		const progress: LaunchProgress[] = [];
		const result = await launch(record, cells, { onProgress: (p) => progress.push(p) });

		expect(result).toEqual({ launchedRuns: 16, notLaunched: 0 });
		const onDisk = expectRecordMatches(record, result);
		expect(onDisk.journeys.map(({ task, level, repeat }) => `${repeat}:${task}:${level}`)).toEqual(
			[1, 2].flatMap((r) => cells.map((cell) => `${r}:${cell.task}:${cell.level}`)),
		);
		expect(bodies.map((body) => body.goal)).toEqual(
			[1, 2].flatMap(() => cells.map((cell) => cell.prompt)),
		);
		for (const body of bodies) {
			expect(Object.keys(body).sort()).toEqual(["agents", "goal", "targetDomain"]);
			expect(body.targetDomain).toBe(SITE);
			expect(body.agents).toEqual(AGENTS);
			expect(body).not.toHaveProperty("domains");
		}
		expect(progress).toEqual(Array.from({ length: 8 }, (_, i) => ({ created: i + 1, planned: 8 })));
	});

	it("stamps each entry with the clock when its create returned", async () => {
		const { cells, record } = plan(1);
		studioMock(Array(4).fill(ok));
		const times = [1, 2, 3, 4].map((n) => new Date(Date.UTC(2026, 10, 13, 12, 0, n)));
		const result = await launchTrial({
			client: client(),
			recordId: record.id,
			site: SITE,
			cells,
			agents: AGENTS,
			repeat: 1,
			dir,
			now: () => times.shift() ?? new Date(0),
		});
		const onDisk = expectRecordMatches(record, result);
		expect(onDisk.journeys.map((journey) => journey.createdAt)).toEqual([
			"2026-11-13T12:00:01.000Z",
			"2026-11-13T12:00:02.000Z",
			"2026-11-13T12:00:03.000Z",
			"2026-11-13T12:00:04.000Z",
		]);
	});

	it("records a partial create's failed agents raw and keeps launching", async () => {
		const { cells, record } = plan(1);
		studioMock([partial, ok, ok, ok]);
		const result = await launch(record, cells);

		expect(result).toEqual({ launchedRuns: 7, notLaunched: 0 });
		const onDisk = expectRecordMatches(record, result);
		expect(onDisk.journeys).toHaveLength(4);
		expect(onDisk.journeys[0]).toMatchObject({
			journeyId: createdPartial.data.journeyId,
			runIds: createdPartial.data.runIds,
			failed: [
				{
					harness: "claude-code",
					model: "claude-sonnet-5-5",
					reason: createdPartial.data.failed[0].reason,
				},
			],
		});
		expect(onDisk.journeys[0].failed[0]).not.toHaveProperty("site");
		expect(onDisk.journeys[1].failed).toEqual([]);
	});

	it("records Studio's 502 with its journey id and carries on, resetting the count on success", async () => {
		const { cells, record } = plan(2);
		// Two 502s, a success, two more 502s, then successes: never three in a row.
		studioMock([studio502, studio502, ok, studio502, studio502, ok, ok, ok]);
		const result = await launch(record, cells);

		expect(result).toEqual({ launchedRuns: 8, notLaunched: 0 });
		const onDisk = expectRecordMatches(record, result);
		expect(onDisk.journeys).toHaveLength(8);
		expect(onDisk.journeys[0]).toMatchObject({
			journeyId: NONE_STARTED_502.data.journeyId,
			runIds: [],
			failed: NONE_STARTED_502.data.failed,
			task: 0,
			level: "brand",
			repeat: 1,
		});
		expect(onDisk.journeys.map((journey) => journey.runIds.length)).toEqual([
			0, 0, 2, 0, 0, 2, 2, 2,
		]);
	});

	it("stops with platform_down after three Studio 502s in a row", async () => {
		const { cells, record } = plan(2);
		const { bodies } = studioMock([ok, studio502, studio502, studio502, ok]);
		const result = await launch(record, cells);

		expect(bodies).toHaveLength(4);
		// The third 502 is recorded with its failed agents, so it is not also counted as not launched.
		expect(result).toMatchObject({
			launchedRuns: 2,
			notLaunched: 4 * 2,
			stoppedReason: "platform_down",
		});
		expect(result.lastError).toBeInstanceOf(StudioApiError);
		expect(expectRecordMatches(record, result).journeys).toHaveLength(4);
	});

	it("stops at once on a gateway 502 and records nothing for it", async () => {
		const { cells, record } = plan(2);
		const { bodies } = studioMock([ok, gateway502, ok]);
		const result = await launch(record, cells);

		expect(bodies).toHaveLength(2);
		expect(result).toMatchObject({
			launchedRuns: 2,
			notLaunched: 7 * 2,
			stoppedReason: "platform_down",
		});
		expect(result.lastError).toMatchObject({ status: 502, gateway: true });
		expect(expectRecordMatches(record, result).journeys).toHaveLength(1);
	});

	it("stops with quota on a 402 at the third create and counts the runs not launched", async () => {
		const { cells, record } = plan(2);
		const { bodies } = studioMock([ok, ok, quota, ok]);
		const result = await launch(record, cells);

		expect(bodies).toHaveLength(3);
		expect(result).toMatchObject({ launchedRuns: 4, notLaunched: 6 * 2, stoppedReason: "quota" });
		expect(result.lastError).toMatchObject({ status: 402 });
		expect(expectRecordMatches(record, result).journeys).toHaveLength(2);
	});

	it("stops with api_error on any other Studio error", async () => {
		const { cells, record } = plan(1);
		studioMock([ok, serverError]);
		const result = await launch(record, cells);

		expect(result).toMatchObject({
			launchedRuns: 2,
			notLaunched: 3 * 2,
			stoppedReason: "api_error",
		});
		expect(result.lastError).toMatchObject({ status: 500 });
		expectRecordMatches(record, result);
	});

	it("stops with api_error when the key exchange fails mid launch", async () => {
		const { cells, record } = plan(1);
		studioMock([ok], () => asJson({ error: "revoked" }, 401));
		const result = await launch(record, cells);

		expect(result).toMatchObject({
			launchedRuns: 0,
			notLaunched: 4 * 2,
			stoppedReason: "api_error",
		});
		expect(result.lastError).toBeInstanceOf(PlatformApiError);
		expect(expectRecordMatches(record, result).journeys).toEqual([]);
	});

	it("stops with platform_down on a network failure and keeps the error", async () => {
		const { cells, record } = plan(1);
		studioMock([ok, networkError]);
		const result = await launch(record, cells);

		expect(result).toMatchObject({
			launchedRuns: 2,
			notLaunched: 3 * 2,
			stoppedReason: "platform_down",
		});
		expect(result.lastError).toBeInstanceOf(StudioConnectionError);
		expectRecordMatches(record, result);
	});

	it("stops with interrupted before the next create when the signal is set, never aborting one in flight", async () => {
		const { cells, record } = plan(2);
		const controller = new AbortController();
		const second: Reply = () => {
			controller.abort();
			return ok();
		};
		const { bodies } = studioMock([ok, second, ok]);
		const result = await launch(record, cells, { signal: controller.signal });

		// The create that was in flight when the signal fired is recorded in full.
		expect(bodies).toHaveLength(2);
		expect(result).toEqual({
			launchedRuns: 4,
			notLaunched: 6 * 2,
			stoppedReason: "interrupted",
		});
		expect(expectRecordMatches(record, result).journeys).toHaveLength(2);
	});

	it("stops before the first create when the signal is already set", async () => {
		const { cells, record } = plan(1);
		const { bodies } = studioMock([ok]);
		const result = await launch(record, cells, { signal: AbortSignal.abort() });

		expect(bodies).toHaveLength(0);
		expect(result).toEqual({ launchedRuns: 0, notLaunched: 4 * 2, stoppedReason: "interrupted" });
		expectRecordMatches(record, result);
	});

	it("propagates an error that is not the platform's instead of reading it as a stop", async () => {
		const { cells, record } = plan(1);
		const bug = new RangeError("a bug in ax, not a platform failure");
		await expect(
			launchTrial({
				client: {
					createJourney: async () => {
						throw bug;
					},
				},
				recordId: record.id,
				site: SITE,
				cells,
				agents: AGENTS,
				repeat: 1,
				dir,
			}),
		).rejects.toBe(bug);
		expect(readRecord(record.id, dir)?.stoppedReason).toBeUndefined();
	});

	it("propagates a failure to write the record instead of reading it as a stop", async () => {
		const { cells, record } = plan(1);
		studioMock([ok]);
		await expect(
			launchTrial({
				client: client(),
				recordId: "t-0000000000",
				site: SITE,
				cells,
				agents: AGENTS,
				repeat: 1,
				dir,
			}),
		).rejects.toThrow(/no trial record/);
		expect(readRecord(record.id, dir)?.journeys).toEqual([]);
	});
});
