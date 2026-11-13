import { afterEach, describe, expect, it, vi } from "vitest";
import runningDetail from "../api/__fixtures__/deep-journey-detail-running.json";
import refusals from "../api/__fixtures__/deep-journey-refusals.json";
import type { JourneyNextAction } from "../contract";
import { axCall, nextLine, placeholder, printNext, servedNextStep, shellWord } from "./next-line";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("shellWord", () => {
	it("leaves a word bare when a shell would read it unchanged", () => {
		expect(shellWord("stripe.com")).toBe("stripe.com");
		expect(shellWord("https://docs.example.com/v2")).toBe("https://docs.example.com/v2");
		expect(shellWord("--min-score")).toBe("--min-score");
	});

	it("single quotes anything a shell would split or expand", () => {
		expect(shellWord("Find pricing")).toBe("'Find pricing'");
		expect(shellWord("$HOME")).toBe("'$HOME'");
		expect(shellWord("ngrok http 3000 --log stdout")).toBe("'ngrok http 3000 --log stdout'");
	});

	it("escapes a single quote inside the word", () => {
		expect(shellWord("what's new")).toBe("'what'\\''s new'");
	});
});

describe("axCall", () => {
	it("renders placeholders unquoted and real arguments quoted", () => {
		expect(axCall(["deep-journey", "stripe.com", "--task", "Find the pricing page"])).toBe(
			"ax deep-journey stripe.com --task 'Find the pricing page'",
		);
		expect(axCall(["audit", placeholder("domain")])).toBe("ax audit <domain>");
		expect(axCall(["audit", "stripe.com", "--api-key", placeholder("key")])).toBe(
			"ax audit stripe.com --api-key <key>",
		);
	});
});

describe("nextLine", () => {
	it("puts the reason after the call as a shell comment", () => {
		expect(nextLine({ call: "ax audit stripe.com", why: "score the site" })).toBe(
			"Next: ax audit stripe.com  # score the site",
		);
		expect(nextLine({ call: "ax learn" })).toBe("Next: ax learn");
	});

	it("blanks control characters a server value could carry", () => {
		expect(nextLine({ call: "ax audit evil.com\u001b[2J", why: "a\nb" })).toBe(
			"Next: ax audit evil.com [2J  # a b",
		);
	});
});

describe("servedNextStep", () => {
	// Next actions as ora served them (real responses, see src/api/deep-journey.test.ts).
	const STREAM = runningDetail.next_action as JourneyNextAction;
	const INVALID_DOMAIN = refusals.INVALID_DOMAIN.next_action as JourneyNextAction;
	const AGENTS = refusals.UNSUPPORTED_AGENT.next_action as JourneyNextAction;
	const SAME = {
		method: "POST",
		url: "/api/journey/runs",
		call: "ax deep-journey linear.app --intent pricing",
	};

	it("writes a GET as curl against the base, with ora's reason as the why", () => {
		expect(servedNextStep(STREAM, { base: "https://ora.ai" })).toEqual({
			call: `curl -s https://ora.ai${runningDetail.stream_url}`,
			why: "Hold the stream open to the end; only a followed stream saves the result.",
		});
		expect(servedNextStep(AGENTS, { base: "http://localhost:4214", axEquivalent: SAME })).toEqual({
			call: "curl -s http://localhost:4214/api/journey/agents",
			why: AGENTS.reason,
		});
	});

	it("keeps an absolute URL, such as a docs page, as served", () => {
		const docs = { ...AGENTS, url: "https://ora.ai/docs/journeys" };
		expect(servedNextStep(docs, { base: "http://localhost:4214" }).call).toBe(
			"curl -s https://ora.ai/docs/journeys",
		);
	});

	it("writes the request ax itself sends as that ax call", () => {
		expect(servedNextStep(INVALID_DOMAIN, { base: "https://ora.ai", axEquivalent: SAME })).toEqual({
			call: SAME.call,
			why: INVALID_DOMAIN.reason,
		});
	});

	it("puts the served wait in front as a sleep", () => {
		const retry = { ...INVALID_DOMAIN, wait_seconds: 30 };
		expect(servedNextStep(retry, { base: "https://ora.ai", axEquivalent: SAME }).call).toBe(
			`sleep 30 && ${SAME.call}`,
		);
		const odd = { ...INVALID_DOMAIN, wait_seconds: 1.5 };
		expect(servedNextStep(odd, { base: "https://ora.ai", axEquivalent: SAME }).call).toBe(
			SAME.call,
		);
	});

	it("writes a POST with no ax equivalent as curl, its body quoted", () => {
		const replay = { ...INVALID_DOMAIN, body: { intent: { custom: "what's new" } } };
		expect(servedNextStep(replay, { base: "https://ora.ai" }).call).toBe(
			`curl -s -X POST https://ora.ai/api/journey/runs -H 'content-type: application/json' -d '{"intent":{"custom":"what'\\''s new"}}'`,
		);
	});
});

describe("printNext", () => {
	it("goes to stdout after a report and to stderr when stdout carries a payload", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		printNext({ call: "ax learn" }, { stderr: false });
		expect(log).toHaveBeenCalledWith("Next: ax learn");
		expect(error).not.toHaveBeenCalled();
		printNext({ call: "ax learn" }, { stderr: true });
		expect(error).toHaveBeenCalledWith("Next: ax learn");
		expect(log).toHaveBeenCalledTimes(1);
	});
});
