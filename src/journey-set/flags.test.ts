import { describe, expect, it } from "vitest";
import openclawOraAi from "./__fixtures__/studio-trajectories/openclaw-f6f23ac8.json";
import studioOraAi from "./__fixtures__/studio-trajectories/run-49ab0c88.json";
import { deriveSetFlags } from "./flags";
import blockedFirst403 from "./vendor/__fixtures__/run-flags/blocked-first-403.json";
import cleanOnsite from "./vendor/__fixtures__/run-flags/clean-onsite.json";
import memoryAnswer from "./vendor/__fixtures__/run-flags/memory-answer.json";
import offsiteOnly from "./vendor/__fixtures__/run-flags/offsite-only.json";

// ora's own cases for the blocked rule run in ./vendor/run-flags.test.ts. This
// file covers what ax adds: the set's two flags from Studio's step list.
//
// Fixture provenance.
// vendor/__fixtures__/run-flags/*.json are ora's (see the vendored spec's header).
// studio-trajectories/*.json are recorded Studio trajectories from oramono at
// deb82e279, trimmed by script to each step's id, type, url_host and status:
// - run-49ab0c88: apps/studio-ui/src/lib/trajectory/__fixtures__/run-49ab0c88.trajectory.json
//   (ora.ai, every on-site step without a status).
// - openclaw-f6f23ac8: apps/e2e/src/trace-validation/__fixtures__/openclaw-f6f23ac8.trajectory.json
//   (ora.ai with 200s, a 404 on api.ora.ai, and a third party docs host).
// Variants below pass a different site, never edited steps.

const NOT_FLAGGED = { flagged: false };
const stepsOf = (fixture: { trajectory: { steps: unknown[] } }) =>
	fixture.trajectory.steps as Array<{ url_host?: string; status?: number }>;

describe("blocked", () => {
	it("passes ora's flag through from the steps alone", () => {
		expect(deriveSetFlags(stepsOf(blockedFirst403), blockedFirst403.domain).blocked).toEqual({
			flagged: true,
			reason: "The site refused the agent's first request with HTTP 403",
		});
		expect(deriveSetFlags(stepsOf(memoryAnswer), memoryAnswer.domain).blocked).toEqual(NOT_FLAGGED);
	});

	it("treats a Studio step with a null status as no evidence", () => {
		expect(deriveSetFlags(studioOraAi.steps, "ora.ai").blocked).toEqual(NOT_FLAGGED);
	});

	it("does not flag a Studio run whose only refusal-like status is a 404 on a subdomain", () => {
		expect(deriveSetFlags(openclawOraAi.steps, "ora.ai").blocked).toEqual(NOT_FLAGGED);
	});
});

describe("never visited the site", () => {
	it("is raised when no step reached the site, naming the site", () => {
		expect(deriveSetFlags(stepsOf(offsiteOnly), offsiteOnly.domain).never_visited).toEqual({
			flagged: true,
			reason: "The agent never opened a page on linear.com.",
		});
	});

	it("is not raised when any step reached the site or a subdomain", () => {
		expect(deriveSetFlags(stepsOf(cleanOnsite), cleanOnsite.domain).never_visited).toEqual(
			NOT_FLAGGED,
		);
		expect(deriveSetFlags(stepsOf(blockedFirst403), "fiverr.com").never_visited).toEqual(
			NOT_FLAGGED,
		);
		expect(deriveSetFlags(studioOraAi.steps, "ora.ai").never_visited).toEqual(NOT_FLAGGED);
		expect(deriveSetFlags(openclawOraAi.steps, "ora.ai").never_visited).toEqual(NOT_FLAGGED);
	});

	it("is raised on a real Studio run judged against a site it did not visit", () => {
		// The ora.ai run, asked about stripe.com instead.
		expect(deriveSetFlags(studioOraAi.steps, "stripe.com").never_visited).toEqual({
			flagged: true,
			reason: "The agent never opened a page on stripe.com.",
		});
	});

	it("is raised for a run with no steps, which is never blocked", () => {
		expect(deriveSetFlags([], "linear.app")).toEqual({
			blocked: NOT_FLAGGED,
			never_visited: { flagged: true, reason: "The agent never opened a page on linear.app." },
		});
	});
});
