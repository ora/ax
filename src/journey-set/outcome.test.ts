import { describe, expect, it } from "vitest";
import { awaitsGrade, EXCLUDED_STATUSES, GRADED_STATUSES, runBucket, runPhase } from "./outcome";

// Provenance, oramono develop deb82e279 (2026-11-13): the two status sets are Studio's own
// terminal sets, RUN_SUCCESS_STATUSES and RUN_FAILURE_STATUSES in
// packages/node/journey-stages/src/lifecycle-bucket.ts:7-8, and the verdicts are its RUN_VERDICTS
// (packages/node/journey-stages/src/run-verdict.ts:27). Studio's verdict on an excluded status is
// `failed`, or `not_measured` for a cancel (run-verdict.ts:45-49), so each excluded case below
// carries that verdict to show the status decides first. A create's failed[] reason is the start
// error's message (apps/studio-service/src/journeys/journey-fanout.ts:183); FAILED_TO_START is the
// one in apps/studio-service/src/journeys/journeys-service.test.ts:629.

const FAILED_TO_START = "run gate unavailable";

const STUDIO_VERDICT_ON_EXCLUDED: Array<[string, string]> = [
	["failed", "failed"],
	["timeout", "failed"],
	["timed_out", "failed"],
	["error", "failed"],
	["canceled", "not_measured"],
	["cancelled", "not_measured"],
	["lost", "failed"],
];

const IN_FLIGHT = ["queued", "pending", "running", "warming_up"];

describe("status sets", () => {
	it("pins Studio's graded and excluded statuses, with no status in both", () => {
		expect(GRADED_STATUSES).toEqual(["succeeded", "completed"]);
		expect(EXCLUDED_STATUSES).toEqual([
			"failed",
			"timeout",
			"timed_out",
			"error",
			"canceled",
			"cancelled",
			"lost",
		]);
		expect(GRADED_STATUSES.filter((s) => EXCLUDED_STATUSES.includes(s))).toEqual([]);
	});
});

describe("runPhase", () => {
	it.each(["succeeded", "completed"])("%s is graded", (status) => {
		expect(runPhase(status)).toBe("graded");
	});

	it.each(STUDIO_VERDICT_ON_EXCLUDED.map(([status]) => status))("%s is excluded", (status) => {
		expect(runPhase(status)).toBe("excluded");
	});

	it.each(IN_FLIGHT)("%s is in flight", (status) => {
		expect(runPhase(status)).toBe("in_flight");
	});
});

describe("awaitsGrade", () => {
	it.each([
		["not_measured", "not_measured"],
		["null", null],
		["absent", undefined],
	])("a graded status with a %s verdict is waiting for its grade", (_, verdict) => {
		expect(awaitsGrade("succeeded", verdict)).toBe(true);
		expect(awaitsGrade("completed", verdict)).toBe(true);
	});

	it.each(["succeeded", "partial", "failed", "abandoned"])(
		"a graded status with a %s verdict is not waiting",
		(verdict) => {
			expect(awaitsGrade("succeeded", verdict)).toBe(false);
		},
	);

	it("an excluded or in flight run is never waiting for a grade", () => {
		expect(awaitsGrade("canceled", "not_measured")).toBe(false);
		expect(awaitsGrade("lost", null)).toBe(false);
		expect(awaitsGrade("running", null)).toBe(false);
	});
});

describe("runBucket", () => {
	it("a run that never started is excluded with its reason", () => {
		expect(runBucket({ started: false, reason: FAILED_TO_START })).toEqual({
			bucket: "excluded",
			reason: FAILED_TO_START,
		});
	});

	it.each(STUDIO_VERDICT_ON_EXCLUDED)(
		"a %s run is excluded with its raw status, whatever its verdict (%s)",
		(status, verdict) => {
			expect(runBucket({ started: true, status, verdict })).toEqual({
				bucket: "excluded",
				rawStatus: status,
			});
		},
	);

	it.each([
		["succeeded", "satisfied"],
		["partial", "partial"],
		["failed", "unsatisfied"],
		["not_measured", "not_graded_yet"],
	])("on a graded status, a %s verdict is %s", (verdict, bucket) => {
		expect(runBucket({ started: true, status: "succeeded", verdict })).toEqual({ bucket });
		expect(runBucket({ started: true, status: "completed", verdict })).toEqual({ bucket });
	});

	it("a null or absent verdict on a graded status is not graded yet", () => {
		expect(runBucket({ started: true, status: "succeeded", verdict: null })).toEqual({
			bucket: "not_graded_yet",
		});
		expect(runBucket({ started: true, status: "completed" })).toEqual({
			bucket: "not_graded_yet",
		});
	});

	it.each(["abandoned", "", "constructor"])(
		"an unknown verdict %j on a graded status is not gradable with its raw value",
		(verdict) => {
			expect(runBucket({ started: true, status: "succeeded", verdict })).toEqual({
				bucket: "not_gradable",
				rawVerdict: verdict,
			});
		},
	);

	it.each(IN_FLIGHT)("a %s run is in flight", (status) => {
		expect(runBucket({ started: true, status, verdict: null })).toEqual({ bucket: "in_flight" });
	});
});
