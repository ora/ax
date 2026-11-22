import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformApiError } from "./platform";
import { createSetsClient } from "./sets";

// The sets client over a mocked fetch: which requests it makes, that it returns the served JSON
// untouched, and how it reads a failure. The key exchange is the platform client's own (one
// POST /auth/token), counted here so a second exchange is visible.
const BASE = "https://api.agentfront.sh";

function mockFetch(answers: { status: number; body: unknown }[]) {
	const requests: {
		url: string;
		method: string;
		authorization: string;
		body: string | undefined;
	}[] = [];
	let exchanges = 0;
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url);
		if (href.endsWith("/auth/token")) {
			exchanges += 1;
			return new Response(JSON.stringify({ token: `bearer-${exchanges}` }), { status: 200 });
		}
		requests.push({
			url: href,
			method: init?.method ?? "GET",
			authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
			body: init?.body as string | undefined,
		});
		const answer = answers.shift() ?? { status: 500, body: null };
		return new Response(answer.body === null ? "" : JSON.stringify(answer.body), {
			status: answer.status,
		});
	});
	return { fetchMock, requests, exchanges: () => exchanges };
}

afterEach(() => vi.unstubAllGlobals());

describe("createSetsClient", () => {
	it("calls each operation at its path under /ax/v1 with the exchanged bearer, and returns the body as served", async () => {
		const served = { setId: "s1", anything: { the: "platform sends" } };
		const { fetchMock, requests, exchanges } = mockFetch([
			{ status: 200, body: served },
			{ status: 201, body: served },
			{ status: 200, body: served },
			{ status: 200, body: { sets: [] } },
			{ status: 200, body: { setId: "s1", cancelled: true } },
		]);
		vi.stubGlobal("fetch", fetchMock);
		const client = createSetsClient({
			base: BASE,
			secret: "ora_sk_test",
			fetch: fetchMock as unknown as typeof fetch,
		});
		const request = { site: "linear.app", goals: ["Find pricing"] };
		expect(await client.preview(request)).toEqual(served);
		await client.create(request);
		await client.get("s 1");
		await client.list();
		await client.cancel("s1");
		expect(requests.map((r) => `${r.method} ${r.url.slice(BASE.length)}`)).toEqual([
			"POST /ax/v1/sets/preview",
			"POST /ax/v1/sets",
			"GET /ax/v1/sets/s%201",
			"GET /ax/v1/sets",
			"POST /ax/v1/sets/s1/cancel",
		]);
		expect(JSON.parse(requests[0].body ?? "")).toEqual(request);
		expect(new Set(requests.map((r) => r.authorization))).toEqual(new Set(["Bearer bearer-1"]));
		expect(exchanges()).toBe(1);
	});

	it("exchanges the key again, once, when the platform answers 401 (a bearer that ran out while watching)", async () => {
		const { fetchMock, requests, exchanges } = mockFetch([
			{ status: 401, body: { error: "Unauthorized" } },
			{ status: 200, body: { sets: [] } },
		]);
		vi.stubGlobal("fetch", fetchMock);
		const client = createSetsClient({
			base: BASE,
			secret: "ora_sk_test",
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(await client.list()).toEqual({ sets: [] });
		expect(requests.map((r) => r.authorization)).toEqual(["Bearer bearer-1", "Bearer bearer-2"]);
		expect(exchanges()).toBe(2);
	});

	it("a refusal is thrown with its status, its own sentence and its body untouched", async () => {
		const body = {
			error: "Unprocessable",
			code: "SET_INVALID",
			message: "The site must be a domain such as example.com, or an http(s) URL.",
		};
		const { fetchMock } = mockFetch([{ status: 422, body }]);
		vi.stubGlobal("fetch", fetchMock);
		const client = createSetsClient({
			base: BASE,
			secret: "ora_sk_test",
			fetch: fetchMock as unknown as typeof fetch,
		});
		const error = await client.preview({ site: "nope", goals: ["x"] }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PlatformApiError);
		expect(error).toMatchObject({ status: 422, message: body.message, payload: body });
	});

	it("a refusal for a missing scope names the scope the platform listed, since its body has no sentence", async () => {
		// The body a read-only key got for a preview on a local ora, 2026-11-22.
		const body = {
			error: "Forbidden",
			code: "INSUFFICIENT_SCOPE",
			details: { missing: ["ax.sets:write"] },
		};
		const { fetchMock } = mockFetch([{ status: 403, body }]);
		vi.stubGlobal("fetch", fetchMock);
		const client = createSetsClient({
			base: BASE,
			secret: "ora_sk_test",
			fetch: fetchMock as unknown as typeof fetch,
		});
		const error = await client
			.preview({ site: "linear.app", goals: ["x"] })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({
			status: 403,
			message: "This key does not have the ax.sets:write scope.",
			payload: body,
		});
	});

	it("an answer that is not JSON is a failure, never an empty set", async () => {
		const { fetchMock } = mockFetch([{ status: 200, body: null }]);
		vi.stubGlobal("fetch", fetchMock);
		const client = createSetsClient({
			base: BASE,
			secret: "ora_sk_test",
			fetch: fetchMock as unknown as typeof fetch,
		});
		await expect(client.list()).rejects.toThrow("non-JSON");
	});
});
