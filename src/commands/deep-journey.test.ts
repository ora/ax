import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deepJourneyCommand, EXIT } from "./deep-journey";

// Command-layer contract for the keyed tier: flag exclusivity and the
// fail-fast key check happen HERE, before any network call - the API client
// stays a thin sender. The API layer itself is covered in
// src/api/deep-journey.test.ts; everything below mocks it out.

vi.mock("../api/deep-journey", async (importOriginal) => {
	const real = await importOriginal<typeof import("../api/deep-journey")>();
	return {
		...real,
		fetchJourneyIntents: vi.fn(async () => ({
			intents: [
				{
					id: "pricing",
					label: "Pricing",
					hint: "find pricing",
					template: "Find pricing for {domain}.",
				},
			],
			defaultId: "pricing",
		})),
		fetchJourneyAgents: vi.fn(async () => ({
			agents: [
				{
					id: "cas-haiku",
					label: "Claude Code",
					variant: "Haiku 4.5",
					harness: "claude-agent-sdk",
					model: "claude-haiku-4-5",
				},
			],
			defaultId: "cas-haiku",
		})),
		performDeepJourney: vi.fn(async () => ({
			record: { id: "run_1", status: "succeeded" },
			cached: false,
			allowance: {},
			detail: { id: "run_1", status: "succeeded", domain: "zapier.com", contractVersion: "1.15.0" },
		})),
	};
});

import realDetail from "../api/__fixtures__/deep-journey-detail.json";
import runningDetail from "../api/__fixtures__/deep-journey-detail-running.json";
import refusals from "../api/__fixtures__/deep-journey-refusals.json";
import {
	DeepJourneyApiError,
	type DeepJourneyOutcome,
	fetchJourneyIntents,
	performDeepJourney,
} from "../api/deep-journey";
import type { JourneyNextAction } from "../contract";

const BASE = { url: "zapier.com", json: true, noStream: false };

const KEYLESS_HINT =
	"Repeat this goal across agents and levels of help with `ax trial run`; needs a Front account.";

describe("deepJourneyCommand - keyed tier flags", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("ORA_PARTNER_API_KEY", "");
		vi.stubEnv("ORA_SCAN_API_KEY", "");
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("rejects --task combined with --intent as a usage error", async () => {
		const code = await deepJourneyCommand({
			...BASE,
			task: "Find the pricing page",
			intent: "pricing",
			apiKey: "pk_live_demo_0123456789",
		});
		expect(code).toBe(EXIT.USAGE);
		expect(performDeepJourney).not.toHaveBeenCalled();
	});

	it("fails fast on --task without any partner key", async () => {
		const code = await deepJourneyCommand({ ...BASE, task: "Find the pricing page" });
		expect(code).toBe(EXIT.USAGE);
		expect(performDeepJourney).not.toHaveBeenCalled();
	});

	it("runs a --task journey without resolving curated intents", async () => {
		const code = await deepJourneyCommand({
			...BASE,
			task: "Find how to build a Slack to Sheets zap",
			apiKey: "pk_live_demo_0123456789",
		});
		expect(code).toBe(EXIT.OK);
		expect(fetchJourneyIntents).not.toHaveBeenCalled();
		expect(performDeepJourney).toHaveBeenCalledWith(
			"zapier.com",
			expect.objectContaining({
				task: "Find how to build a Slack to Sheets zap",
				intentId: undefined,
				apiKey: "pk_live_demo_0123456789",
			}),
		);
	});

	it("accepts a key from ORA_PARTNER_API_KEY for --task runs", async () => {
		vi.stubEnv("ORA_PARTNER_API_KEY", "pk_live_from_env_0123456789");
		const code = await deepJourneyCommand({ ...BASE, task: "Find the pricing page" });
		expect(code).toBe(EXIT.OK);
		expect(performDeepJourney).toHaveBeenCalled();
	});

	it("draws the attribution graph from the terminal trajectory (non-json)", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			logs.push(String(line ?? ""));
		});
		vi.mocked(performDeepJourney).mockResolvedValueOnce({
			// biome-ignore lint/suspicious/noExplicitAny: partial record is enough for this render path
			record: { id: "run_1", status: "succeeded" } as any,
			cached: false,
			allowance: {},
			detail: {
				id: "run_1",
				status: "succeeded",
				domain: "zapier.com",
				contractVersion: "1.15.0",
				result: {
					outcome: "completed",
					verdict: "satisfied",
					trajectory: {
						steps: [
							{ id: 0, type: "text", text: "Let me start at the homepage." },
							{
								id: 1,
								type: "tool_call",
								action: "fetch",
								tool: "WebFetch",
								url_host: "zapier.com",
								url_path: "/pricing",
								status: 200,
								attribution: { kind: "prior_knowledge" },
							},
						],
					},
					// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough for this render path
				} as any,
				// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough for this render path
			} as any,
		});

		const code = await deepJourneyCommand({
			url: "zapier.com",
			json: false,
			noStream: true,
			intent: "pricing",
		});

		expect(code).toBe(EXIT.OK);
		const out = logs.join("\n");
		// The graph tally, a fetch box for the visited path, and the reasoning note.
		expect(out).toContain("steps");
		expect(out).toContain("zapier.com/pricing");
		expect(out).toContain("Let me start at the homepage");
		// The intent template's {domain} token is substituted with the target at the
		// graph root — never shown raw.
		expect(out).toContain("Find pricing for zapier.com.");
		expect(out).not.toContain("{domain}");
	});

	it("surfaces run_signals metrics and token/cost in the finale", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			logs.push(String(line ?? ""));
		});
		vi.mocked(performDeepJourney).mockResolvedValueOnce({
			// biome-ignore lint/suspicious/noExplicitAny: partial record is enough for this render path
			record: { id: "run_1", status: "succeeded" } as any,
			cached: false,
			allowance: {},
			detail: {
				id: "run_1",
				status: "succeeded",
				domain: "zapier.com",
				step_count: 12,
				verdict: "satisfied",
				contractVersion: "1.23.0",
				result: {
					outcome: "success",
					verdict: "satisfied",
					num_turns: 9,
					duration_ms: 48300,
					cost_usd: 0.0423,
					input_tokens: 11840,
					output_tokens: 2960,
					run_signals: {
						version: 3,
						intent_category: "signup",
						category_confidence: "high",
						outcome: "success",
						reached_anchor: true,
						steps_count: 12,
						search_count: 3,
						link_following_rate: 0.5,
						prior_knowledge_ratio: 0.3,
						signals_observed: [],
						journey_layers: ["discovery", "identity", "access"],
						// v4+ answer signals: 100% of the answer's substance from the site,
						// 29% of fetched pages fed the final answer.
						answer_basis: {
							sections_total: 4,
							from_site: 4,
							from_external: 0,
							from_search: 0,
							from_memory: 0,
							site_share: 1,
							memory_share: 0,
						},
						answer_efficiency: 0.29,
					},
					// Four fetches: 3 OK + 1 404 (reliability 75%); origins: 2 followed
					// links, 1 web search, 1 prior knowledge over 4 → on-site 75%.
					trajectory: {
						steps: [
							{
								id: 0,
								type: "tool_call",
								action: "fetch",
								status: 200,
								attribution: { kind: "prior_knowledge" },
							},
							{
								id: 1,
								type: "tool_call",
								action: "fetch",
								status: 200,
								attribution: { kind: "previous_artifact" },
							},
							{ id: 2, type: "tool_call", action: "search", search_query: "q" },
							{
								id: 3,
								type: "tool_call",
								action: "fetch",
								status: 404,
								attribution: { kind: "web_search" },
							},
							{
								id: 4,
								type: "tool_call",
								action: "fetch",
								status: 200,
								attribution: { kind: "previous_artifact" },
							},
						],
					},
					insight: { summary: "Reached checkout via the pricing page.", key_observations: [] },
					// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough for this render path
				} as any,
				// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough for this render path
			} as any,
		});

		const code = await deepJourneyCommand({
			url: "zapier.com",
			json: false,
			noStream: true,
			intent: "pricing", // the only intent the module mock's roster offers
		});

		expect(code).toBe(EXIT.OK);
		const out = logs.join("\n");
		// Chip row: token total (input+output) and cost.
		expect(out).toContain("14.8k tokens");
		expect(out).toContain("$0.042");
		expect(out).toContain("3 searches");
		// The three answer-quality metrics render as score cards (uppercase labels).
		expect(out).toContain("ANSWER FROM YOUR SITE");
		expect(out).toContain("ANSWER EFFICIENCY");
		expect(out).toContain("FOLLOWED SITE LINKS");
		expect(out).toContain("100%"); // answer from your site = answer_basis.site_share
		expect(out).toContain("29%"); // answer efficiency
		expect(out).toContain("50%"); // followed site links = run_signals.link_following_rate
		// The default agent is Claude Code on Haiku (not the roster's Sonnet).
		expect(performDeepJourney).toHaveBeenCalledWith(
			"zapier.com",
			expect.objectContaining({ harness: "claude-agent-sdk", model: "claude-haiku-4-5" }),
		);
		// The two attribution distributions.
		expect(out).toContain("answer sources");
		expect(out).toContain("from this site");
		expect(out).toContain("url discovery");
		expect(out).toContain("followed a link");
		// Reach context from run_signals.
		expect(out).toContain("reached the site");
		// The layers line is no longer rendered.
		expect(out).not.toContain("layers");
		// The intent-category line and the turns chip are intentionally not shown.
		expect(out).not.toContain("turns");
		expect(out).not.toContain("intent signup");
	});
});

describe("deepJourneyCommand - Next lines and the --json error envelope", () => {
	const writes: string[] = [];
	beforeEach(() => {
		vi.clearAllMocks();
		writes.length = 0;
		vi.stubEnv("ORA_PARTNER_API_KEY", "");
		vi.stubEnv("ORA_SCAN_API_KEY", "");
		vi.stubEnv("ORA_API_KEY", "");
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			writes.push(String(line ?? ""));
		});
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		});
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	const stderrLines = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
	const envelope = () => JSON.parse(writes.join(""));

	it("--json prints the envelope for --task without a key, naming the key in the next call", async () => {
		expect(await deepJourneyCommand({ ...BASE, task: "Find the pricing page" })).toBe(EXIT.USAGE);
		expect(envelope().error).toEqual({
			code: "NEEDS_KEY",
			message: expect.stringContaining("--task needs an ora partner API key"),
			next: "ORA_PARTNER_API_KEY=<partner key> ax deep-journey zapier.com --task 'Find the pricing page' --json",
		});
	});

	it("an unknown intent suggests the default one", async () => {
		expect(await deepJourneyCommand({ ...BASE, intent: "nope" })).toBe(EXIT.USAGE);
		expect(envelope().error.code).toBe("UNKNOWN_INTENT");
		expect(envelope().error.next).toBe("ax deep-journey zapier.com --intent pricing --json");
	});

	it("a run still executing is read, never started again", async () => {
		vi.mocked(performDeepJourney).mockRejectedValueOnce(
			new DeepJourneyApiError("run run_1 is still executing; the stream ended", {
				code: "RUN_STILL_RUNNING",
				runUrl: "https://ora.ai/api/journey/runs/run_1",
			}),
		);
		expect(await deepJourneyCommand(BASE)).toBe(EXIT.API);
		expect(envelope().error).toEqual({
			code: "RUN_STILL_RUNNING",
			message: expect.stringContaining("still executing"),
			next: "curl -s https://ora.ai/api/journey/runs/run_1",
		});
	});

	it("a retry after an API error repeats the run with the key as a placeholder", async () => {
		vi.mocked(performDeepJourney).mockRejectedValueOnce(
			new DeepJourneyApiError("ora's run engine is unavailable right now", {
				code: "ENGINE_UNAVAILABLE",
			}),
		);
		expect(
			await deepJourneyCommand({ ...BASE, intent: "pricing", apiKey: "pk_live_not_for_echo" }),
		).toBe(EXIT.API);
		expect(envelope().error.next).toBe(
			"ax deep-journey zapier.com --intent pricing --agent cas-haiku --json --api-key <key>",
		);
		expect(`${writes.join("")}${stderrLines().join("\n")}`).not.toContain("pk_live_not_for_echo");
	});

	it("--json prints ora's error body unchanged and puts the message and Next line on stderr", async () => {
		const served = {
			error: "usage_limit_reached",
			kind: "journey",
			period: "month",
			used: 1000,
			limit: 1000,
			resets_at: "2026-12-01T00:00:00Z",
			next_action: { call: "ax deep-journey zapier.com" },
		};
		vi.mocked(performDeepJourney).mockRejectedValueOnce(
			new DeepJourneyApiError("ora usage limit reached: this API key has used its journey limit", {
				code: "USAGE_LIMIT_REACHED",
				payload: served,
			}),
		);
		expect(await deepJourneyCommand(BASE)).toBe(EXIT.API);
		expect(writes).toEqual([`${JSON.stringify(served, null, 2)}\n`]);
		expect(stderrLines()).toEqual([
			expect.stringContaining("ora usage limit reached"),
			"Next: ax deep-journey zapier.com --intent pricing --agent cas-haiku --json  # after the wait the message names",
		]);
	});

	it("--json passes through ora's body when the roster fetch fails too", async () => {
		const served = { error: "rate_limited", retry_after_ms: 30_000 };
		vi.mocked(fetchJourneyIntents).mockRejectedValueOnce(
			new DeepJourneyApiError("ora request failed: rate_limited", { payload: served }),
		);
		expect(await deepJourneyCommand(BASE)).toBe(EXIT.API);
		expect(envelope()).toEqual(served);
	});

	it("--json keeps stdout the run detail and puts the Next line on stderr", async () => {
		expect(await deepJourneyCommand(BASE)).toBe(EXIT.OK);
		expect(envelope()).toMatchObject({ id: "run_1", status: "succeeded" });
		expect(stderrLines()).toContain(
			"Next: ax audit zapier.com --json  # the readiness audit: which checks explain what the agent hit",
		);
	});

	it("ends the human result with the Next line on stdout", async () => {
		expect(await deepJourneyCommand({ ...BASE, json: false, noStream: true })).toBe(EXIT.OK);
		// The keyless hint is the one dim line after Next (see the trial describe).
		expect(writes.at(-2)).toBe(
			"Next: ax audit zapier.com  # the readiness audit: which checks explain what the agent hit",
		);
		expect(writes.at(-1)).toContain(KEYLESS_HINT);
	});
});

// Real 1.42.0 responses (provenance in src/api/deep-journey.test.ts). No local
// run is flagged, so the raised flag is a delta carrying the reason ora writes
// for a first request refused with a 403.
describe("deepJourneyCommand - flags and the next action ora served", () => {
	const writes: string[] = [];
	const BLOCKED_REASON = "The site refused the agent's first request with HTTP 403";
	const blockedDetail = {
		...realDetail,
		flags: { ...realDetail.flags, blocked: { flagged: true, reason: BLOCKED_REASON } },
	};
	const STREAM_NEXT = runningDetail.next_action as JourneyNextAction;
	const STREAM_LINE = `Next: curl -s https://ora.ai${runningDetail.stream_url}  # ${STREAM_NEXT.reason}`;
	const AUDIT_LINE =
		"Next: ax audit linear.app --json  # the readiness audit: which checks explain what the agent hit";
	const outcomeWith = (detail: object) =>
		({
			record: { id: realDetail.id, status: "succeeded" },
			cached: false,
			allowance: {},
			detail,
		}) as unknown as DeepJourneyOutcome;
	const RUN = { url: "linear.app", intent: "pricing", json: true, noStream: false };

	beforeEach(() => {
		vi.clearAllMocks();
		writes.length = 0;
		vi.stubEnv("ORA_PARTNER_API_KEY", "");
		vi.stubEnv("ORA_SCAN_API_KEY", "");
		vi.stubEnv("ORA_API_KEY", "");
		vi.stubEnv("ORA_API_URL", "https://ora.ai");
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			writes.push(String(line ?? ""));
		});
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		});
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	const stderrLines = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
	const stdoutJson = () => JSON.parse(writes.join(""));

	it("prints a raised flag in ora's words, right under the verdict", async () => {
		vi.mocked(performDeepJourney).mockResolvedValueOnce(outcomeWith(blockedDetail));
		expect(await deepJourneyCommand({ ...RUN, json: false, noStream: true })).toBe(EXIT.OK);
		const flag = writes.findIndex((line) => line.includes(BLOCKED_REASON));
		expect(writes[flag]).toMatch(/!.* The site refused the agent's first request with HTTP 403$/);
		const verdict = writes.findIndex((line) => line.includes("task satisfied"));
		expect(flag).toBeGreaterThan(verdict);
		expect(flag - verdict).toBeLessThanOrEqual(2);
	});

	it("--json keeps ora's detail unchanged on stdout and puts a raised flag on stderr", async () => {
		vi.mocked(performDeepJourney).mockResolvedValueOnce(outcomeWith(blockedDetail));
		expect(await deepJourneyCommand(RUN)).toBe(EXIT.OK);
		expect(stdoutJson()).toEqual(blockedDetail);
		expect(stderrLines()).toEqual([
			expect.stringMatching(/!.* The site refused the agent's first request with HTTP 403$/),
			AUDIT_LINE,
			expect.stringContaining(KEYLESS_HINT),
		]);
	});

	it("prints no note when ora raised no flag", async () => {
		vi.mocked(performDeepJourney).mockResolvedValueOnce(outcomeWith(realDetail));
		expect(await deepJourneyCommand(RUN)).toBe(EXIT.OK);
		expect(stdoutJson()).toEqual(realDetail);
		expect(stderrLines()).toEqual([AUDIT_LINE, expect.stringContaining(KEYLESS_HINT)]);
	});

	it("a run left running ends on the stream ora named, --no-stream included", async () => {
		vi.mocked(performDeepJourney).mockRejectedValueOnce(
			new DeepJourneyApiError(`run ${realDetail.id} is still executing`, {
				code: "RUN_STILL_RUNNING",
				runUrl: `https://ora.ai/api/journey/runs/${realDetail.id}`,
				nextAction: STREAM_NEXT,
			}),
		);
		expect(await deepJourneyCommand({ ...RUN, json: false, noStream: true })).toBe(EXIT.API);
		expect(stderrLines().at(-1)).toBe(STREAM_LINE);
	});

	it("a failed run ends on the stream ora named for it", async () => {
		vi.mocked(performDeepJourney).mockResolvedValueOnce(
			outcomeWith({ ...runningDetail, status: "failed" }),
		);
		expect(await deepJourneyCommand(RUN)).toBe(EXIT.RUN_FAILED);
		expect(stderrLines().at(-1)).toBe(STREAM_LINE);
	});

	it("a refusal that asks for a new run ends on the same ax call, with ora's reason", async () => {
		vi.mocked(performDeepJourney).mockRejectedValueOnce(
			new DeepJourneyApiError("ora journey request failed: Invalid input", {
				payload: refusals.INVALID_DOMAIN,
			}),
		);
		expect(await deepJourneyCommand({ ...RUN, url: "localhost" })).toBe(EXIT.API);
		expect(stdoutJson()).toEqual(refusals.INVALID_DOMAIN);
		expect(stderrLines().at(-1)).toBe(
			`Next: ax deep-journey localhost --intent pricing --agent cas-haiku --json  # ${refusals.INVALID_DOMAIN.next_action.reason}`,
		);
	});

	it("a refusal that names another request writes it as curl", async () => {
		vi.mocked(performDeepJourney).mockRejectedValueOnce(
			new DeepJourneyApiError("ora journey request failed: Unsupported agent", {
				payload: refusals.UNSUPPORTED_AGENT,
			}),
		);
		expect(await deepJourneyCommand(RUN)).toBe(EXIT.API);
		expect(stderrLines().at(-1)).toBe(
			`Next: curl -s https://ora.ai/api/journey/agents  # ${refusals.UNSUPPORTED_AGENT.next_action.reason}`,
		);
	});
});

describe("deepJourneyCommand - the trial Next line after a free run", () => {
	const writes: string[] = [];
	const NAMING_LINE =
		"This goal names Zapier, so it runs at the brand level. Add `--exact <url>` for the exact level, or write the goal without Zapier for the need level.";
	const AUDIT_LINE =
		"Next: ax audit zapier.com  # the readiness audit: which checks explain what the agent hit";
	const trialNext = (goal: string) =>
		`Next: ax trial run zapier.com --task '${goal}'  # the same goal, repeated across agents and levels of help, with counts`;
	const PLAIN_GOAL = "Find the pricing page.";
	const withTemplate = (template: string, hint = "find pricing") =>
		vi.mocked(fetchJourneyIntents).mockResolvedValueOnce({
			intents: [{ id: "pricing", label: "Pricing", hint, template }],
			defaultId: "pricing",
		});

	beforeEach(() => {
		vi.clearAllMocks();
		writes.length = 0;
		vi.stubEnv("ORA_PARTNER_API_KEY", "");
		vi.stubEnv("ORA_SCAN_API_KEY", "");
		vi.stubEnv("ORA_API_KEY", "");
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			writes.push(String(line ?? ""));
		});
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		});
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	const stderrLines = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
	const human = { ...BASE, json: false, noStream: true };

	it("with a Front key and a curated goal that names the site, points at trial run and adds the levels line", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_front_key");
		expect(await deepJourneyCommand(human)).toBe(EXIT.OK);
		expect(writes.slice(-2)).toEqual([trialNext("Find pricing for zapier.com."), NAMING_LINE]);
		expect(writes.join("\n")).not.toContain("ax audit");
		expect(writes.join("\n")).not.toContain(KEYLESS_HINT);
	});

	it("with a Front key and a --task that does not name the site, prints Next and no second line", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_front_key");
		const task = "Find how to build a Slack to Sheets flow";
		expect(await deepJourneyCommand({ ...human, task, apiKey: "pk_live_demo_0123456789" })).toBe(
			EXIT.OK,
		);
		expect(writes.at(-1)).toBe(trialNext(task));
		expect(stderrLines().join("\n")).not.toContain("names Zapier");
	});

	it("reduces a URL target to the trial's site, so the brand and the call match what the trial runs", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_front_key");
		expect(await deepJourneyCommand({ ...human, url: "https://www.zapier.com/pricing" })).toBe(
			EXIT.OK,
		);
		expect(writes.at(-2)).toMatch(/^Next: ax trial run zapier\.com --task /);
		expect(writes.at(-1)).toBe(NAMING_LINE);
	});

	it("offers no trial for a target the trial would refuse, and keeps the audit Next", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_front_key");
		expect(await deepJourneyCommand({ ...human, url: "localhost" })).toBe(EXIT.OK);
		expect(writes.at(-1)).toMatch(/^Next: ax audit localhost /);
		expect(writes.join("\n")).not.toContain("trial");
	});

	it("never adds --agents to the trial call, and quotes the goal as one shell word", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_front_key");
		withTemplate(PLAIN_GOAL);
		expect(await deepJourneyCommand(human)).toBe(EXIT.OK);
		expect(writes.at(-1)).toBe(trialNext(PLAIN_GOAL));
		expect(writes.at(-1)).not.toContain("--agents");
	});

	it("without a Front key, keeps the audit Next and adds the dim hint after it", async () => {
		withTemplate(PLAIN_GOAL);
		expect(await deepJourneyCommand(human)).toBe(EXIT.OK);
		expect(writes.slice(-2)).toEqual([AUDIT_LINE, expect.stringContaining(KEYLESS_HINT)]);
		expect(writes.join("\n")).not.toContain("ax trial run zapier.com");
	});

	it("a --task run with a Front key never gets the hint", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_front_key");
		await deepJourneyCommand({ ...human, task: PLAIN_GOAL, apiKey: "pk_live_demo_0123456789" });
		expect(writes.join("\n")).not.toContain("needs a Front account");
	});

	it("a goal that fell back to the intent hint keeps the audit Next and prints no trial lines", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_front_key");
		withTemplate("", "find pricing");
		expect(await deepJourneyCommand(human)).toBe(EXIT.OK);
		expect(writes.at(-1)).toBe(AUDIT_LINE);
		expect(writes.join("\n")).not.toContain("trial");
	});

	it("a fallback goal prints no keyless hint either", async () => {
		withTemplate("", "find pricing");
		expect(await deepJourneyCommand(human)).toBe(EXIT.OK);
		expect(writes.at(-1)).toBe(AUDIT_LINE);
		expect(writes.join("\n")).not.toContain(KEYLESS_HINT);
	});

	it("--json puts the Next line and the levels line on stderr and keeps stdout the run detail", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_front_key");
		expect(await deepJourneyCommand(BASE)).toBe(EXIT.OK);
		expect(JSON.parse(writes.join(""))).toMatchObject({ id: "run_1" });
		expect(stderrLines()).toEqual([trialNext("Find pricing for zapier.com."), NAMING_LINE]);
	});

	it("--json puts the keyless hint on stderr", async () => {
		withTemplate(PLAIN_GOAL);
		expect(await deepJourneyCommand(BASE)).toBe(EXIT.OK);
		expect(JSON.parse(writes.join(""))).toMatchObject({ id: "run_1" });
		expect(stderrLines()).toEqual([
			"Next: ax audit zapier.com --json  # the readiness audit: which checks explain what the agent hit",
			expect.stringContaining(KEYLESS_HINT),
		]);
	});

	it("a failed run keeps its own Next line and gets no trial lines", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_front_key");
		vi.mocked(performDeepJourney).mockResolvedValueOnce({
			record: { id: "run_1", status: "failed" },
			cached: false,
			allowance: {},
			detail: { id: "run_1", status: "failed", domain: "zapier.com", contractVersion: "1.15.0" },
		} as unknown as DeepJourneyOutcome);
		expect(await deepJourneyCommand(BASE)).toBe(EXIT.RUN_FAILED);
		expect(stderrLines().at(-1)).toContain("Next: ax deep-journey zapier.com");
		expect(stderrLines().join("\n")).not.toContain("trial");
	});

	it("a served next action keeps its Next line and gets no trial lines", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_front_key");
		vi.mocked(performDeepJourney).mockResolvedValueOnce({
			record: { id: "run_1", status: "succeeded" },
			cached: false,
			allowance: {},
			detail: {
				id: "run_1",
				status: "succeeded",
				domain: "zapier.com",
				contractVersion: "1.15.0",
				next_action: {
					method: "GET",
					url: "/api/journey/runs/run_1",
					reason: "read the run again",
				},
			},
		} as unknown as DeepJourneyOutcome);
		expect(await deepJourneyCommand(BASE)).toBe(EXIT.OK);
		expect(stderrLines().at(-1)).toContain("curl -s");
		expect(stderrLines().join("\n")).not.toContain("trial");
	});
});
