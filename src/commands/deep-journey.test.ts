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

import { DeepJourneyApiError, fetchJourneyIntents, performDeepJourney } from "../api/deep-journey";

const BASE = { url: "zapier.com", json: true, noStream: false };

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

	it("--json keeps stdout the run detail and puts the Next line on stderr", async () => {
		expect(await deepJourneyCommand(BASE)).toBe(EXIT.OK);
		expect(envelope()).toMatchObject({ id: "run_1", status: "succeeded" });
		expect(stderrLines()).toContain(
			"Next: ax audit zapier.com --json  # the readiness audit: which checks explain what the agent hit",
		);
	});

	it("ends the human result with the Next line on stdout", async () => {
		expect(await deepJourneyCommand({ ...BASE, json: false, noStream: true })).toBe(EXIT.OK);
		expect(writes.at(-1)).toBe(
			"Next: ax audit zapier.com  # the readiness audit: which checks explain what the agent hit",
		);
	});
});
