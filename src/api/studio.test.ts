import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import agents from "./__fixtures__/studio/agents.json";
import cancel from "./__fixtures__/studio/cancel.json";
import quota402 from "./__fixtures__/studio/error-402-quota.json";
import missingScope403 from "./__fixtures__/studio/error-403-missing-scope.json";
import created from "./__fixtures__/studio/journey-create.json";
import createdPartial from "./__fixtures__/studio/journey-create-partial.json";
import detailFinal from "./__fixtures__/studio/journey-detail-final.json";
import detailRunning from "./__fixtures__/studio/journey-detail-running.json";
import trajectory from "./__fixtures__/studio/trajectory.json";
import usage from "./__fixtures__/studio/usage.json";
import usageUnlimited from "./__fixtures__/studio/usage-unlimited.json";
import { exchangeKeyGrant, PlatformApiError } from "./platform";
import {
	createStudioClient,
	isStudioFailure,
	notStartedJourney,
	STUDIO_USER_AGENT,
	StudioApiError,
	StudioConnectionError,
	StudioShapeError,
	TRAJECTORY_PROFILE,
} from "./studio";

// Fixture provenance: shapes from oramono develop (deb82e2, 2026-11-13). Values are placeholders
// in those shapes; M9.1 replaces them with responses recorded from a live set.
// - agents.json: openapi/ora-public.openapi.json line 38025 (GET /studio/v1/agents). Ids and names
//   from packages/node/harness-catalog/src/catalog.ts; the reason wording from
//   apps/studio-service/src/plan/agent-availability.ts:20.
// - usage.json, usage-unlimited.json: spec line 52683 (GET /studio/v1/usage); the nulls of an
//   uncapped plan from apps/studio-service/src/plan/studio-usage.ts (meterOf).
// - journey-create.json: spec line 49966 (the create's 200 body). The service answers 201 and
//   leaves `failed` out of a clean create (apps/studio-service/src/journeys/journeys-router.ts:340).
// - journey-create-partial.json: the same body with `failed[]`, whose entries also carry `model`
//   (FailedJourneyRun, apps/studio-service/src/journeys/journeys-service.ts:115). The reason is an
//   example refusal message (packages/node/run-spine/src/harness-guard.ts, TIER_UNRESOLVED).
// - journey-detail-running.json, journey-detail-final.json: spec line 50081 (GET
//   /studio/v1/journeys/{id}); journey status and outcome per
//   apps/studio-service/src/journeys/journey-result.ts, a null verdict in flight per
//   packages/node/journey-stages/src/run-verdict.ts:41.
// - cancel.json: spec line 51997. No envelope: runs-service answers the report bare
//   (apps/runs-service/src/runs/routes/cancel-runs-route.ts) and Studio relays it
//   (packages/node/runs-api/src/routes/cancel-runs-proxy-route.ts).
// - error-403-missing-scope.json: the scope guard's body
//   (packages/node/auth/src/middleware/require-scope.ts:62 and :86), the spec's Error at line 575.
// - error-402-quota.json: the quota guard the create route mounts
//   (packages/node/entitlements/src/middleware.ts:378, wired at
//   apps/studio-service/src/wiring/journeys.ts:134); the public spec does not list a 402.
// - trajectory.json: oramono apps/studio-ui/src/lib/trajectory/__fixtures__/run-49ab0c88.trajectory.json
//   trimmed to steps[].{id, turn, type, tool, url_host, status}. Studio serves the trajectory bare
//   (packages/node/run-spine/src/trajectory-serve.ts).
// Bodies with no fixture file are named deltas below, each citing its source.

const BASE = "https://platform.test";
const KEY = "ora_sk_local";

/** A token shaped like the key exchange mints for an ora_sk_ key (auth-service api-key-grant.ts:105). */
function jwt(claims: Record<string, unknown>): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return [part({ alg: "RS256", typ: "JWT" }), part(claims), "signature"].join(".");
}

const ALL_SCOPES = ["journeys:write", "journeys:read", "runs:read", "runs:write", "intents:read"];
const TOKEN = jwt({ type: "api_key", sub: "key:k1", scopes: ALL_SCOPES, products: ["studio"] });
const GRANT = { token: TOKEN, expiresIn: 900 };

const asJson = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

/**
 * Answers the key exchange with each grant in turn (the last one repeats) and every Studio call
 * from `routes`, keyed by method and path. An unrouted call fails the test loudly.
 */
function studioMock(
	routes: Record<string, () => Response>,
	grants: Array<{ token: string; expiresIn?: number }> = [GRANT],
) {
	const calls: Call[] = [];
	let exchanges = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init: RequestInit = {}) => {
			const at = String(url);
			const call: Call = {
				url: at,
				method: init.method ?? "GET",
				headers: (init.headers ?? {}) as Record<string, string>,
				body: init.body as string | undefined,
			};
			calls.push(call);
			if (at.endsWith("/auth/token")) {
				const grant = grants[Math.min(exchanges, grants.length - 1)];
				exchanges++;
				return asJson({ ...grant, tokenType: "Bearer" });
			}
			const route = routes[`${call.method} ${at.slice(BASE.length)}`];
			if (!route) throw new Error(`unrouted ${call.method} ${at}`);
			return route();
		}),
	);
	return {
		calls,
		studioCalls: () => calls.filter((c) => !c.url.endsWith("/auth/token")),
		exchanges: () => exchanges,
	};
}

const client = (now?: () => number) => createStudioClient({ apiKey: KEY, baseUrl: BASE, now });

const CREATE_INPUT = {
	goal: "Find how to create an issue from the API. Use Linear.",
	agents: [
		{ harness: "claude-code", model: "claude-haiku-4-5-20251001" },
		{ harness: "claude-code", model: "claude-sonnet-5-5" },
	],
	targetDomain: "linear.app",
};

// Studio's own 502 on create (journeys-router.ts:340): nothing started, success false, the journey
// id kept and every agent in failed[]. Delta on journey-create-partial.json.
const NONE_STARTED_502 = {
	...createdPartial,
	success: false,
	data: {
		...createdPartial.data,
		runIds: [],
		streamUrls: [],
		failed: [
			{ ...createdPartial.data.failed[0], model: "claude-haiku-4-5-20251001" },
			createdPartial.data.failed[0],
		],
	},
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("exchangeKeyGrant", () => {
	it("returns the token and its lifetime from the key exchange", async () => {
		studioMock({});
		expect(await exchangeKeyGrant(BASE, KEY)).toEqual({ token: TOKEN, expiresIn: 900 });
	});

	it("leaves expiresIn out when the answer carries none", async () => {
		studioMock({}, [{ token: TOKEN }]);
		expect(await exchangeKeyGrant(BASE, KEY)).toEqual({ token: TOKEN });
	});
});

describe("createStudioClient", () => {
	it("demands ORA_API_KEY up front", () => {
		vi.stubEnv("ORA_API_KEY", "");
		expect(() => createStudioClient({ baseUrl: BASE })).toThrow(/ORA_API_KEY/);
	});

	it("exchanges the key once, then sends the bearer and the set's user agent to Studio", async () => {
		const mock = studioMock({
			"GET /studio/v1/agents": () => asJson(agents),
			"GET /studio/v1/usage": () => asJson(usage),
		});
		const studio = client();
		await studio.agents();
		await studio.usage();

		expect(mock.calls[0]).toMatchObject({
			url: `${BASE}/auth/token`,
			method: "POST",
			headers: { authorization: `Bearer ${KEY}` },
		});
		expect(mock.exchanges()).toBe(1);
		expect(STUDIO_USER_AGENT).toBe(`ax/${pkg.version} (journey set)`);
		for (const call of mock.studioCalls()) {
			expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
			expect(call.headers["user-agent"]).toBe(STUDIO_USER_AGENT);
		}
	});

	it("takes the base from ORA_PLATFORM_URL when none is passed", async () => {
		vi.stubEnv("ORA_PLATFORM_URL", `${BASE}/`);
		const mock = studioMock({ "GET /studio/v1/agents": () => asJson(agents) });
		await createStudioClient({ apiKey: KEY }).agents();
		expect(mock.studioCalls()[0].url).toBe(`${BASE}/studio/v1/agents`);
	});
});

describe("reads", () => {
	it("agents() unwraps the envelope", async () => {
		studioMock({ "GET /studio/v1/agents": () => asJson(agents) });
		expect(await client().agents()).toEqual(agents.data.agents);
	});

	it("usage() unwraps the envelope, limited and uncapped", async () => {
		studioMock({ "GET /studio/v1/usage": () => asJson(usage) });
		expect(await client().usage()).toEqual(usage.data);

		studioMock({ "GET /studio/v1/usage": () => asJson(usageUnlimited) });
		const uncapped = await client().usage();
		expect(uncapped.runs).toEqual({ used: 212, limit: null, remaining: null });
		expect(uncapped.resetsAt).toBeNull();
	});

	it("journey() reads one journey with its per-agent runs", async () => {
		const id = detailRunning.data.id;
		studioMock({
			[`GET /studio/v1/journeys/${id}`]: () => asJson(detailRunning),
		});
		const journey = await client().journey(id);
		expect(journey).toEqual(detailRunning.data);
		expect(journey.agents.map((a) => [a.status, a.startedAt === null, a.verdict])).toEqual([
			["running", false, null],
			["queued", true, null],
		]);
	});

	it("journey() keeps the final verdicts raw", async () => {
		const id = detailFinal.data.id;
		studioMock({ [`GET /studio/v1/journeys/${id}`]: () => asJson(detailFinal) });
		const journey = await client().journey(id);
		expect(journey.agents.map((a) => a.verdict)).toEqual(["succeeded", "failed"]);
	});

	it("journey() encodes the id into the path", async () => {
		const mock = studioMock({ "GET /studio/v1/journeys/a%2Fb": () => asJson(detailRunning) });
		await client().journey("a/b");
		expect(mock.studioCalls()[0].url).toBe(`${BASE}/studio/v1/journeys/a%2Fb`);
	});

	it("refuses an enveloped endpoint that answers without its envelope", async () => {
		studioMock({ "GET /studio/v1/agents": () => asJson(agents.data) });
		await expect(client().agents()).rejects.toThrow(/envelope/);
	});

	it("trajectory() reads the bare body and keeps url_host per step", async () => {
		const runId = detailFinal.data.agents[0].runId;
		const mock = studioMock({
			[`GET /studio/v1/runs/${runId}/trajectory`]: () => asJson(trajectory),
		});
		const read = await client().trajectory(runId);
		expect(read.steps).toHaveLength(trajectory.steps.length);
		expect(read.steps[3]).toEqual({
			id: 3,
			turn: 4,
			type: "tool_call",
			tool: "WebFetch",
			url_host: "ora.ai",
		});
		expect(read.steps[13]).toMatchObject({ url_host: "ora.run", status: 308 });
		// No ?profile: the stored artifact already carries url_host on every profile.
		expect(TRAJECTORY_PROFILE).toBeUndefined();
		expect(mock.studioCalls()[0].url).toBe(`${BASE}/studio/v1/runs/${runId}/trajectory`);
	});

	it("trajectory() refuses a body with no steps", async () => {
		studioMock({ "GET /studio/v1/runs/r1/trajectory": () => asJson({ seq: 1 }) });
		await expect(client().trajectory("r1")).rejects.toThrow(/steps/);
	});
});

describe("createJourney", () => {
	it("sends exactly goal, agents and targetDomain, and never domains", async () => {
		const mock = studioMock({ "POST /studio/v1/journeys": () => asJson(created, 201) });
		await client().createJourney({
			...CREATE_INPUT,
			agents: CREATE_INPUT.agents.map((a) => ({ ...a, extra: "dropped" })),
		});
		const call = mock.studioCalls()[0];
		expect(call.headers["content-type"]).toBe("application/json");
		const body = JSON.parse(call.body ?? "{}");
		expect(Object.keys(body).sort()).toEqual(["agents", "goal", "targetDomain"]);
		expect(body).toEqual(CREATE_INPUT);
		expect(body).not.toHaveProperty("domains");
	});

	it("returns the created journey with an empty failed list on a clean 201", async () => {
		studioMock({ "POST /studio/v1/journeys": () => asJson(created, 201) });
		expect(await client().createJourney(CREATE_INPUT)).toEqual({ ...created.data, failed: [] });
	});

	it("accepts the 200 the spec lists", async () => {
		studioMock({ "POST /studio/v1/journeys": () => asJson(created, 200) });
		expect((await client().createJourney(CREATE_INPUT)).journeyId).toBe(created.data.journeyId);
	});

	it("keeps a partial create's failed agents", async () => {
		studioMock({ "POST /studio/v1/journeys": () => asJson(createdPartial, 201) });
		const journey = await client().createJourney(CREATE_INPUT);
		expect(journey.runIds).toEqual(createdPartial.data.runIds);
		expect(journey.failed).toEqual(createdPartial.data.failed);
	});

	it("refuses an empty targetDomain before any request", async () => {
		const mock = studioMock({});
		await expect(client().createJourney({ ...CREATE_INPUT, targetDomain: "  " })).rejects.toThrow(
			/targetDomain/,
		);
		expect(mock.calls).toHaveLength(0);
	});

	it("maps Studio's 502 to an error that still names the journey and its failed agents", async () => {
		studioMock({ "POST /studio/v1/journeys": () => asJson(NONE_STARTED_502, 502) });
		const failure = await client()
			.createJourney(CREATE_INPUT)
			.catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(StudioApiError);
		expect(failure).toMatchObject({ status: 502 });
		expect(notStartedJourney(failure)).toEqual({
			journeyId: NONE_STARTED_502.data.journeyId,
			failed: NONE_STARTED_502.data.failed,
		});
	});

	it("recognises a gateway 502 by its status, with nothing to say what started", async () => {
		studioMock({
			"POST /studio/v1/journeys": () => new Response("<html>bad gateway</html>", { status: 502 }),
		});
		const failure = await client()
			.createJourney(CREATE_INPUT)
			.catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(StudioApiError);
		expect(failure).toMatchObject({ status: 502, payload: null, code: null });
		expect(notStartedJourney(failure)).toBeNull();
		expect((failure as StudioApiError).gateway).toBe(true);
	});

	it("marks only a 502 without Studio's body as a gateway failure", async () => {
		studioMock({ "POST /studio/v1/journeys": () => asJson(NONE_STARTED_502, 502) });
		const studio502 = await client()
			.createJourney(CREATE_INPUT)
			.catch((err: unknown) => err);
		expect((studio502 as StudioApiError).gateway).toBe(false);
		studioMock({ "POST /studio/v1/journeys": () => asJson({ error: "quota" }, 402) });
		const quota = await client()
			.createJourney(CREATE_INPUT)
			.catch((err: unknown) => err);
		expect((quota as StudioApiError).gateway).toBe(false);
	});

	it("maps the quota guard's 402, and recognises a 402 by status alone", async () => {
		studioMock({ "POST /studio/v1/journeys": () => asJson(quota402, 402) });
		const quota = await client()
			.createJourney(CREATE_INPUT)
			.catch((err: unknown) => err);
		expect(quota).toBeInstanceOf(StudioApiError);
		expect(quota).toMatchObject({ status: 402, code: "LIMIT_EXCEEDED", payload: quota402 });

		studioMock({ "POST /studio/v1/journeys": () => new Response("", { status: 402 }) });
		await expect(client().createJourney(CREATE_INPUT)).rejects.toMatchObject({
			status: 402,
			code: null,
		});
	});
});

describe("errors", () => {
	it("a 403 names the scopes the key lacks", async () => {
		studioMock({ "POST /studio/v1/journeys": () => asJson(missingScope403, 403) });
		const failure = await client()
			.createJourney(CREATE_INPUT)
			.catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(StudioApiError);
		expect(failure).toBeInstanceOf(PlatformApiError);
		expect(failure).toMatchObject({
			status: 403,
			code: "INSUFFICIENT_SCOPE",
			missingScopes: ["journeys:write"],
			payload: missingScope403,
		});
		expect((failure as Error).message).toContain("journeys:write");
	});

	it("a 403 with no details lists no missing scopes", async () => {
		const { details: _dropped, ...noDetails } = missingScope403;
		studioMock({ "GET /studio/v1/agents": () => asJson(noDetails, 403) });
		await expect(client().agents()).rejects.toMatchObject({ status: 403, missingScopes: [] });
	});

	it("a 401 on a Studio call points at the key", async () => {
		studioMock({
			"GET /studio/v1/usage": () => asJson({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401),
		});
		const failure = await client()
			.usage()
			.catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(StudioApiError);
		expect(failure).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
		expect((failure as Error).message).toMatch(/ORA_API_KEY/);
	});

	it("strips terminal control characters from server text in the message", async () => {
		studioMock({
			"GET /studio/v1/agents": () =>
				asJson({ error: "agents read failed\u001b[2J", code: "agents_read_failed" }, 502),
		});
		const failure = await client()
			.agents()
			.catch((err: unknown) => err);
		expect((failure as Error).message).not.toContain("\u001b");
		expect(failure).toMatchObject({ status: 502, code: "agents_read_failed" });
	});

	it("a key the exchange rejects surfaces as the platform's 401", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 401 })),
		);
		await expect(client().agents()).rejects.toMatchObject({ status: 401 });
		await expect(client().agents()).rejects.toThrow(/API key/i);
	});
});

describe("transport failures", () => {
	it("gives a Studio request a timeout", async () => {
		studioMock({ "GET /studio/v1/agents": () => asJson(agents) });
		await client().agents();
		const [, init] = vi.mocked(fetch).mock.calls[1];
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("a request that cannot reach the platform is a connection error naming it", async () => {
		studioMock({
			"GET /studio/v1/journeys/j-1": () => {
				throw new TypeError("fetch failed");
			},
		});
		const failure = await client()
			.journey("j-1")
			.catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(StudioConnectionError);
		expect((failure as Error).message).toContain(BASE);
		expect((failure as Error).message).toContain("fetch failed");
		expect(isStudioFailure(failure)).toBe(true);
	});

	it("a timed out request is a connection error", async () => {
		studioMock({
			"GET /studio/v1/usage": () => {
				throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
			},
		});
		await expect(client().usage()).rejects.toBeInstanceOf(StudioConnectionError);
	});

	it("a key exchange that cannot reach the platform is a connection error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);
		const failure = await client()
			.agents()
			.catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(StudioConnectionError);
		expect(isStudioFailure(failure)).toBe(true);
	});

	it("a key exchange that answers 200 without a token is a shape error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => asJson({ tokenType: "Bearer" })),
		);
		await expect(client().agents()).rejects.toBeInstanceOf(StudioShapeError);
	});

	it("an answer without the expected shape is a shape error", async () => {
		studioMock({ "GET /studio/v1/journeys/j-1": () => asJson({ success: true, data: {} }) });
		const failure = await client()
			.journey("j-1")
			.catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(StudioShapeError);
		expect((failure as Error).message).toMatch(/agents list/);
		expect(isStudioFailure(failure)).toBe(true);
	});

	it("a gateway page answered with 200 is a shape error", async () => {
		studioMock({
			"GET /studio/v1/journeys/j-1": () =>
				new Response("<html>maintenance</html>", { status: 200 }),
		});
		await expect(client().journey("j-1")).rejects.toBeInstanceOf(StudioShapeError);
	});

	it("isStudioFailure names the platform's failures and nothing else", () => {
		const http = new StudioApiError("x", {
			status: 500,
			payload: null,
			code: null,
			missingScopes: [],
		});
		expect(isStudioFailure(http)).toBe(true);
		expect(isStudioFailure(new PlatformApiError("x", { status: 401, payload: null }))).toBe(true);
		expect(isStudioFailure(new TypeError("cannot read properties of undefined"))).toBe(false);
		expect(isStudioFailure(new RangeError("x"))).toBe(false);
		expect(isStudioFailure(new Error("x"))).toBe(false);
		expect(isStudioFailure("x")).toBe(false);
	});
});

describe("insightLanded", () => {
	const runId = detailFinal.data.agents[0].runId;
	const path = `GET /studio/v1/runs/${runId}/insight`;

	it("is true once the insight reads 200", async () => {
		// The insight body's schema is `{}` in the spec; only the status matters here.
		studioMock({ [path]: () => asJson({}) });
		expect(await client().insightLanded(runId)).toBe(true);
	});

	it("is false on a 404 whose body says insight_not_ready", async () => {
		// packages/node/run-spine/src/artifact-serve.ts:50, enriched with terminal and hint by
		// packages/node/runs-api/src/routes/run-detail-proxy-routes.ts (the hint's dash written as a
		// hyphen, per this repo's rule on dashes).
		const notReady = {
			error: "insight_not_ready",
			terminal: true,
			hint: "the run is terminal - this artifact was never produced and will not appear; see the run's outcome_reason",
		};
		studioMock({ [path]: () => asJson(notReady, 404) });
		expect(await client().insightLanded(runId)).toBe(false);
	});

	it("throws on a 404 for a run Studio does not know", async () => {
		// packages/node/run-spine/src/run-access.ts:75.
		studioMock({ [path]: () => asJson({ error: "run_not_found" }, 404) });
		await expect(client().insightLanded(runId)).rejects.toMatchObject({
			status: 404,
			code: "run_not_found",
		});
	});

	it("throws on any other status", async () => {
		studioMock({
			[path]: () => asJson({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500),
		});
		await expect(client().insightLanded(runId)).rejects.toBeInstanceOf(StudioApiError);
	});
});

describe("cancelRuns", () => {
	it("posts the run ids in one call and returns the bare report", async () => {
		const mock = studioMock({ "POST /studio/v1/runs/cancel": () => asJson(cancel) });
		const runIds = [...cancel.canceled, ...cancel.alreadyTerminal, ...cancel.skipped];
		expect(await client().cancelRuns(runIds)).toEqual(cancel);
		expect(JSON.parse(mock.studioCalls()[0].body ?? "{}")).toEqual({ runIds });
	});

	it("refuses an empty list and more than 500 ids before any request", async () => {
		const mock = studioMock({});
		await expect(client().cancelRuns([])).rejects.toThrow(/1 to 500/);
		const tooMany = Array.from({ length: 501 }, (_, i) => `run-${i}`);
		await expect(client().cancelRuns(tooMany)).rejects.toThrow(/1 to 500/);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("scopes and token refresh", () => {
	it("scopes() reads the token's scopes claim", async () => {
		studioMock({}, [{ token: jwt({ type: "api_key", scopes: ["runs:read"] }), expiresIn: 900 }]);
		expect(await client().scopes()).toEqual(["runs:read"]);
	});

	it("scopes() reads an absent claim as no scopes, as the server does", async () => {
		studioMock({}, [{ token: jwt({ type: "api_key" }), expiresIn: 900 }]);
		expect(await client().scopes()).toEqual([]);
	});

	it("exchanges again once under 60 seconds of expiresIn remain", async () => {
		const second = jwt({ type: "api_key", scopes: ALL_SCOPES, n: 2 });
		const mock = studioMock({ "GET /studio/v1/agents": () => asJson(agents) }, [
			GRANT,
			{ token: second, expiresIn: 900 },
		]);
		let clock = 1_000_000;
		const studio = client(() => clock);

		await studio.agents();
		clock += (900 - 61) * 1000;
		await studio.agents();
		expect(mock.exchanges()).toBe(1);

		clock += 2000;
		await studio.agents();
		expect(mock.exchanges()).toBe(2);
		expect(mock.studioCalls()[2].headers.authorization).toBe(`Bearer ${second}`);
	});

	it("exchanges again every 10 minutes when expiresIn is absent", async () => {
		const mock = studioMock({ "GET /studio/v1/agents": () => asJson(agents) }, [{ token: TOKEN }]);
		let clock = 0;
		const studio = client(() => clock);

		await studio.agents();
		clock += 10 * 60_000 - 1;
		await studio.agents();
		expect(mock.exchanges()).toBe(1);

		clock += 1;
		await studio.agents();
		expect(mock.exchanges()).toBe(2);
	});

	it("shares one exchange between calls that start together", async () => {
		const mock = studioMock({
			"GET /studio/v1/agents": () => asJson(agents),
			"GET /studio/v1/usage": () => asJson(usage),
		});
		const studio = client();
		await Promise.all([studio.agents(), studio.usage(), studio.scopes()]);
		expect(mock.exchanges()).toBe(1);
	});
});
