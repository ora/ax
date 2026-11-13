import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import detailFinal from "../api/__fixtures__/studio/journey-detail-final.json";
import trajectory from "../api/__fixtures__/studio/trajectory.json";
import { PlatformApiError } from "../api/platform";
import { StudioApiError, StudioConnectionError, StudioShapeError } from "../api/studio";
import type { JourneyAgentRun, JourneyDetail } from "../api/studio-types";
import { collectTrial, UNKNOWN_AGENT } from "./collect";
import { countTrial } from "./count";
import { EXCLUDED_STATUSES } from "./outcome";
import { appendJourney, createRecord, type JourneyEntry, type TrialRecord } from "./record";
import { type AgentChoice, parseTrialSpec, planCells } from "./spec";
import blockedFirst403 from "./vendor/__fixtures__/run-flags/blocked-first-403.json";

// Journey details are api/__fixtures__/studio/journey-detail-final.json (the `{ success, data }`
// envelope unwrapped, as api/studio.test.ts reads it) with only the fields a case needs changed,
// named below as deltas. Trajectories are api/__fixtures__/studio/trajectory.json, except the
// blocked case, whose body carries the steps of vendor/__fixtures__/run-flags/blocked-first-403.json.
// Records are written with createRecord and appendJourney in a temp directory, from a spec and
// cells parsed and planned by spec.ts.

const FINAL = detailFinal.data as JourneyDetail;
const [HAIKU_ROW, SONNET_ROW] = FINAL.agents;
const HAIKU: AgentChoice = { harness: "claude-code", model: HAIKU_ROW.model as string };
const SONNET: AgentChoice = { harness: "claude-code", model: SONNET_ROW.model as string };
const HAIKU_LABEL = "claude-code/claude-haiku-4-5-20251001";
const SONNET_LABEL = "claude-code/claude-sonnet-5-5";
const CODEX: AgentChoice = { harness: "codex", model: "gpt-5" };
const EXACT = "https://linear.app/developers";

/** Studio's start failure, in the words the create's failed[] carries (see launch.test.ts). */
const FAILED_TO_START = "run gate unavailable";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ax-collect-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface TrialInput {
	agents: AgentChoice[];
	journeys: Omit<JourneyEntry, "createdAt">[];
	site?: string;
	tasks?: string[];
	exact?: string;
	repeat?: string;
}

function makeRecord(input: TrialInput): TrialRecord {
	const parsed = parseTrialSpec({
		site: input.site ?? "linear.app",
		tasks: input.tasks ?? ["Find how to create an issue from the API"],
		exact: input.exact ?? EXACT,
		repeat: input.repeat,
	});
	if (!parsed.ok) throw new Error(parsed.error);
	const { cells } = planCells(parsed.spec);
	const created = createRecord({ spec: parsed.spec, agents: input.agents, cells }, dir);
	let record = created;
	for (const journey of input.journeys) {
		record = appendJourney(created.id, { ...journey, createdAt: "2026-11-13T14:02:11.482Z" }, dir);
	}
	return record;
}

const entry = (fields: Partial<JourneyEntry> = {}): Omit<JourneyEntry, "createdAt"> => ({
	journeyId: FINAL.id,
	task: 0,
	level: "need",
	repeat: 1,
	runIds: [HAIKU_ROW.runId, SONNET_ROW.runId],
	failed: [],
	...fields,
});

/** Delta: the fixture's journey with its rows replaced. */
const detailWith = (rows: JourneyAgentRun[]): JourneyDetail => ({ ...FINAL, agents: rows });

/** Delta: one fixture row with fields changed. */
const row = (base: JourneyAgentRun, fields: Partial<JourneyAgentRun>): JourneyAgentRun => ({
	...base,
	...fields,
});

function clientWith(read: (runId: string) => Promise<unknown> = async () => trajectory) {
	const trajectoryRead = vi.fn(read);
	return {
		client: { trajectory: trajectoryRead } as unknown as Parameters<
			typeof collectTrial
		>[0]["client"],
		trajectoryRead,
	};
}

async function collect(record: TrialRecord, journeys: JourneyDetail[], client = clientWith()) {
	return collectTrial({ record, journeys, client: client.client });
}

describe("started runs", () => {
	it("labels each row harness/model, takes bucket from the verdict and reads flags for graded runs", async () => {
		const record = makeRecord({ agents: [HAIKU, SONNET], journeys: [entry()] });
		const client = clientWith();
		const out = await collect(record, [FINAL], client);
		expect(out.runs).toEqual([
			{
				task: 0,
				level: "need",
				repeat: 1,
				agent: HAIKU_LABEL,
				bucket: "satisfied",
				flags: expect.objectContaining({
					never_visited: { flagged: true, reason: expect.any(String) },
				}),
			},
			{
				task: 0,
				level: "need",
				repeat: 1,
				agent: SONNET_LABEL,
				bucket: "unsatisfied",
				flags: expect.any(Object),
			},
		]);
		expect(out.trajectoryFailures).toBe(0);
		expect(client.trajectoryRead.mock.calls.map(([id]) => id)).toEqual([
			HAIKU_ROW.runId,
			SONNET_ROW.runId,
		]);
	});

	it("reads trajectories one at a time", async () => {
		const record = makeRecord({ agents: [HAIKU, SONNET], journeys: [entry()] });
		let open = 0;
		let peak = 0;
		const client = clientWith(async () => {
			open += 1;
			peak = Math.max(peak, open);
			await Promise.resolve();
			open -= 1;
			return trajectory;
		});
		await collect(record, [FINAL], client);
		expect(peak).toBe(1);
	});

	it.each([
		["succeeded", "satisfied", undefined],
		["partial", "partial", undefined],
		["failed", "unsatisfied", undefined],
		["not_measured", "not_graded_yet", undefined],
		[null, "not_graded_yet", undefined],
		["mostly_ok", "not_gradable", "mostly_ok"],
	])("maps verdict %s to %s", async (verdict, bucket, rawVerdict) => {
		const record = makeRecord({
			agents: [HAIKU],
			journeys: [entry({ runIds: [HAIKU_ROW.runId] })],
		});
		const detail = detailWith([row(HAIKU_ROW, { verdict })]);
		const { runs } = await collect(record, [detail]);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ bucket });
		expect(runs[0].rawVerdict).toBe(rawVerdict);
	});

	it.each(EXCLUDED_STATUSES)(
		"excludes status %s with the raw status and reads no trajectory",
		async (status) => {
			const record = makeRecord({
				agents: [HAIKU],
				journeys: [entry({ runIds: [HAIKU_ROW.runId] })],
			});
			const detail = detailWith([row(HAIKU_ROW, { status, verdict: null })]);
			const client = clientWith();
			const { runs } = await collect(record, [detail], client);
			expect(runs[0]).toMatchObject({ bucket: "excluded", rawStatus: status, flags: null });
			expect(client.trajectoryRead).not.toHaveBeenCalled();
		},
	);

	it("keeps a run in flight with null flags and no trajectory read", async () => {
		const record = makeRecord({
			agents: [HAIKU],
			journeys: [entry({ runIds: [HAIKU_ROW.runId] })],
		});
		const detail = detailWith([row(HAIKU_ROW, { status: "running", verdict: null })]);
		const client = clientWith();
		const { runs } = await collect(record, [detail], client);
		expect(runs[0]).toMatchObject({ bucket: "in_flight", agent: HAIKU_LABEL, flags: null });
		expect(client.trajectoryRead).not.toHaveBeenCalled();
	});
});

describe("run ids with no row", () => {
	it("counts a run id the read did not list as in flight, in the column no other item claimed", async () => {
		const record = makeRecord({ agents: [HAIKU, SONNET], journeys: [entry()] });
		const detail = detailWith([HAIKU_ROW]);
		const { runs } = await collect(record, [detail]);
		expect(runs.map((run) => [run.agent, run.bucket, run.flags])).toEqual([
			[HAIKU_LABEL, "satisfied", expect.any(Object)],
			[SONNET_LABEL, "in_flight", null],
		]);
	});

	it("counts every run of a journey that was never read as in flight", async () => {
		const record = makeRecord({ agents: [HAIKU, SONNET], journeys: [entry()] });
		const client = clientWith();
		const { runs, shape } = await collect(record, [], client);
		expect(runs.map((run) => [run.agent, run.bucket, run.flags])).toEqual([
			[HAIKU_LABEL, "in_flight", null],
			[SONNET_LABEL, "in_flight", null],
		]);
		expect(shape.agents).toEqual([HAIKU_LABEL, SONNET_LABEL]);
		expect(client.trajectoryRead).not.toHaveBeenCalled();
	});

	it("falls back to the unknown column when no resolved agent is left to take the run", async () => {
		const record = makeRecord({ agents: [HAIKU], journeys: [entry()] });
		const { runs, shape } = await collect(record, [detailWith([HAIKU_ROW])]);
		expect(runs.map((run) => run.agent)).toEqual([HAIKU_LABEL, UNKNOWN_AGENT]);
		expect(shape.agents).toEqual([HAIKU_LABEL, UNKNOWN_AGENT]);
	});
});

describe("runs that never started", () => {
	it("counts a partial create's failed item as excluded with its reason, beside the run that started", async () => {
		const record = makeRecord({
			agents: [HAIKU, CODEX],
			journeys: [
				entry({
					runIds: [HAIKU_ROW.runId],
					failed: [{ harness: "codex", model: "gpt-5", reason: FAILED_TO_START }],
				}),
			],
		});
		const { runs } = await collect(record, [detailWith([HAIKU_ROW])]);
		expect(runs).toEqual([
			{
				task: 0,
				level: "need",
				repeat: 1,
				agent: "codex/gpt-5",
				bucket: "excluded",
				reason: FAILED_TO_START,
				flags: null,
			},
			expect.objectContaining({ agent: HAIKU_LABEL, bucket: "satisfied" }),
		]);
	});

	it("counts a Studio 502 entry with no journey and no run ids as one excluded run per failed agent", async () => {
		const record = makeRecord({
			agents: [HAIKU, SONNET],
			journeys: [
				entry({
					journeyId: null,
					runIds: [],
					failed: [
						{ harness: "claude-code", model: HAIKU.model, reason: "agent runtime unavailable" },
						{ harness: "claude-code", model: SONNET.model, reason: "agent runtime unavailable" },
					],
				}),
			],
		});
		const client = clientWith();
		const { runs, trajectoryFailures } = await collect(record, [], client);
		expect(runs.map((run) => [run.agent, run.bucket, run.reason])).toEqual([
			[HAIKU_LABEL, "excluded", "agent runtime unavailable"],
			[SONNET_LABEL, "excluded", "agent runtime unavailable"],
		]);
		expect(trajectoryFailures).toBe(0);
		expect(client.trajectoryRead).not.toHaveBeenCalled();
	});

	it("ignores a row whose run id is not in runIds, so the failed item is not counted twice", async () => {
		const orphan = row(SONNET_ROW, { status: "failed", verdict: null });
		const record = makeRecord({
			agents: [HAIKU, SONNET],
			journeys: [
				entry({
					runIds: [HAIKU_ROW.runId],
					failed: [{ harness: "claude-code", model: SONNET.model, reason: FAILED_TO_START }],
				}),
			],
		});
		const { runs } = await collect(record, [detailWith([HAIKU_ROW, orphan])]);
		expect(runs).toHaveLength(2);
		expect(runs.filter((run) => run.agent === SONNET_LABEL)).toEqual([
			expect.objectContaining({ bucket: "excluded", reason: FAILED_TO_START }),
		]);
	});

	it("labels a failed item with no model by its bare harness when that harness is one resolved agent", async () => {
		const record = makeRecord({
			agents: [HAIKU, CODEX],
			journeys: [
				entry({
					runIds: [HAIKU_ROW.runId],
					failed: [{ harness: "codex", reason: FAILED_TO_START }],
				}),
			],
		});
		const { runs, shape } = await collect(record, [detailWith([HAIKU_ROW])]);
		expect(runs[0].agent).toBe("codex/gpt-5");
		expect(shape.agents).toEqual([HAIKU_LABEL, "codex/gpt-5"]);
	});
});

describe("trajectory reads", () => {
	it("leaves flags null and counts the failure on a 404, and keeps collecting", async () => {
		const record = makeRecord({ agents: [HAIKU, SONNET], journeys: [entry()] });
		const missing = new StudioApiError("run not found", {
			status: 404,
			payload: null,
			code: "run_not_found",
			missingScopes: [],
		});
		const client = clientWith(async (runId) => {
			if (runId === HAIKU_ROW.runId) throw missing;
			return trajectory;
		});
		const out = await collect(record, [FINAL], client);
		expect(out.runs.map((run) => [run.agent, run.bucket, run.flags === null])).toEqual([
			[HAIKU_LABEL, "satisfied", true],
			[SONNET_LABEL, "unsatisfied", false],
		]);
		expect(out.trajectoryFailures).toBe(1);
		expect(client.trajectoryRead).toHaveBeenCalledTimes(2);
	});

	it.each([
		["a platform error", new PlatformApiError("bad gateway", { status: 502 })],
		[
			"no connection",
			new StudioConnectionError("https://platform.test", new TypeError("fetch failed")),
		],
		["an answer of the wrong shape", new StudioShapeError("GET /trajectory", "a steps list")],
	])("counts %s as a failed read", async (_name, error) => {
		const record = makeRecord({
			agents: [HAIKU],
			journeys: [entry({ runIds: [HAIKU_ROW.runId] })],
		});
		const client = clientWith(async () => {
			throw error;
		});
		const out = await collect(record, [detailWith([HAIKU_ROW])], client);
		expect(out.runs[0].flags).toBeNull();
		expect(out.trajectoryFailures).toBe(1);
	});

	it("rethrows an error it did not expect", async () => {
		const record = makeRecord({
			agents: [HAIKU],
			journeys: [entry({ runIds: [HAIKU_ROW.runId] })],
		});
		const client = clientWith(async () => {
			throw new RangeError("not a read failure");
		});
		await expect(collect(record, [detailWith([HAIKU_ROW])], client)).rejects.toThrow(RangeError);
	});

	it("flags blocked on a trajectory whose first step is a refusal (blocked-first-403.json)", async () => {
		const site = blockedFirst403.domain;
		const record = makeRecord({
			agents: [HAIKU],
			site,
			tasks: ["Hire a freelancer for a logo"],
			exact: `https://${site}/start`,
			journeys: [entry({ runIds: [HAIKU_ROW.runId] })],
		});
		const client = clientWith(async () => ({ steps: blockedFirst403.trajectory.steps }));
		const { runs } = await collect(record, [detailWith([HAIKU_ROW])], client);
		expect(runs[0].flags?.blocked.flagged).toBe(true);
		expect(runs[0].flags?.blocked.reason).toEqual(expect.any(String));
	});
});

describe("agent columns", () => {
	const mismatched = row(HAIKU_ROW, { model: "claude-haiku-4-5" });

	it("counts a row with a mismatched model id under its own column, and countTrial does not throw", async () => {
		const record = makeRecord({
			agents: [HAIKU, SONNET],
			journeys: [entry({ runIds: [HAIKU_ROW.runId] })],
		});
		const { runs, shape } = await collect(record, [detailWith([mismatched])]);
		expect(runs[0].agent).toBe("claude-code/claude-haiku-4-5");
		expect(shape.agents).toEqual([HAIKU_LABEL, SONNET_LABEL, "claude-code/claude-haiku-4-5"]);
		const count = countTrial(runs, shape);
		const cell = count.cells.find(
			(c) => c.agent === "claude-code/claude-haiku-4-5" && c.level === "need",
		);
		expect(cell?.satisfied).toBe(1);
	});

	it("matches by harness alone when exactly one resolved agent has that harness", async () => {
		const record = makeRecord({
			agents: [HAIKU],
			journeys: [entry({ runIds: [HAIKU_ROW.runId] })],
		});
		const { runs, shape } = await collect(record, [detailWith([mismatched])]);
		expect(runs[0].agent).toBe(HAIKU_LABEL);
		expect(shape.agents).toEqual([HAIKU_LABEL]);
	});

	it("keeps a row with a null model under the bare harness when two resolved agents share it", async () => {
		const record = makeRecord({
			agents: [HAIKU, SONNET],
			journeys: [entry({ runIds: [HAIKU_ROW.runId] })],
		});
		const { runs, shape } = await collect(record, [detailWith([row(HAIKU_ROW, { model: null })])]);
		expect(runs[0].agent).toBe("claude-code");
		expect(shape.agents.at(-1)).toBe("claude-code");
	});
});

describe("shape", () => {
	it("carries tasks, each task's levels in cell order, the repeat count and the resolved labels in order", async () => {
		const record = makeRecord({
			agents: [SONNET, HAIKU],
			tasks: ["Find how to create an issue from the API", "Export your data"],
			repeat: "3",
			journeys: [],
		});
		const { shape, runs } = await collect(record, []);
		expect(runs).toEqual([]);
		expect(shape).toEqual({
			tasks: record.spec.tasks,
			levelsByTask: [
				["need", "brand", "exact"],
				["need", "brand", "exact"],
			],
			agents: [SONNET_LABEL, HAIKU_LABEL],
			plannedPerCell: 3,
		});
	});

	it("does not invent runs for cells that were never launched", async () => {
		const record = makeRecord({
			agents: [HAIKU],
			journeys: [entry({ runIds: [HAIKU_ROW.runId] })],
		});
		const { runs, shape } = await collect(record, [detailWith([HAIKU_ROW])]);
		expect(runs).toHaveLength(1);
		const count = countTrial(runs, shape);
		expect(count.shortLevels.map((short) => short.level)).toEqual(["brand", "exact"]);
	});

	it("takes task, level and repeat from the journey entry, not the row", async () => {
		const record = makeRecord({
			agents: [HAIKU],
			repeat: "2",
			journeys: [entry({ level: "exact", repeat: 2, runIds: [HAIKU_ROW.runId] })],
		});
		const { runs } = await collect(record, [detailWith([HAIKU_ROW])]);
		expect(runs[0]).toMatchObject({ task: 0, level: "exact", repeat: 2 });
	});
});
