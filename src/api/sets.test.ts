import { describe, expect, it, vi } from "vitest";
import type { PlatformCredential } from "../auth/credential";
import { PlatformApiError } from "./platform-error";
import { createSetsClient } from "./sets";

// The sets client over a mocked fetch and a stand-in credential: which requests it makes, that it
// returns the served JSON untouched, how it signs and renews, and how it reads a failure. Whether
// the credential is a platform key or a sign-in is not this client's business: it asks for a
// bearer, for a new one after a 401, and for the credential's own words when ora refuses it.
const BASE = "https://api.agentfront.sh";

function mockFetch(answers: { status: number; body: unknown }[]) {
	const requests: {
		url: string;
		method: string;
		authorization: string;
		body: string | undefined;
	}[] = [];
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		requests.push({
			url: String(url),
			method: init?.method ?? "GET",
			authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
			body: init?.body as string | undefined,
		});
		const answer = answers.shift() ?? { status: 500, body: null };
		return new Response(answer.body === null ? "" : JSON.stringify(answer.body), {
			status: answer.status,
		});
	});
	return { fetchMock, requests };
}

/** A credential that counts what it is asked: `bearer-1` first, a new number on each renewal. */
function fakeCredential() {
	let issued = 1;
	const asked = { bearer: 0, renew: 0 };
	const credential: PlatformCredential = {
		kind: "api_key",
		label: "a test credential",
		refusal: {
			unauthorized: "ora no longer accepts this credential.",
			forbidden: (scopes) => `This credential lacks ${scopes}. Give it that, then try again.`,
		},
		bearer: async () => {
			asked.bearer += 1;
			return `bearer-${issued}`;
		},
		renew: async () => {
			asked.renew += 1;
			issued += 1;
			return `bearer-${issued}`;
		},
		readIdentity: async () => {
			throw new Error("not asked in these tests");
		},
		rejected: (context, cause) => new Error(`${context}: rejected`, { cause }),
	};
	return { credential, asked };
}

function clientOver(answers: { status: number; body: unknown }[]) {
	const { fetchMock, requests } = mockFetch(answers);
	const { credential, asked } = fakeCredential();
	const client = createSetsClient({
		base: BASE,
		credential,
		fetch: fetchMock as unknown as typeof fetch,
	});
	return { client, requests, asked };
}

describe("createSetsClient", () => {
	it("opens the AX standalone stream with the run ID, and reads only live trajectory events", async () => {
		const steps = [{ id: 1, turn: 1, type: "text" }];
		const event = (name: string) => `event: ${name}\ndata: ${JSON.stringify({ steps })}\n\n`;
		const fetched = vi.fn().mockResolvedValue(new Response(event("step") + event("trajectory")));
		const { credential } = fakeCredential();
		const client = createSetsClient({ base: BASE, credential, fetch: fetched });
		const onSnapshot = vi.fn();
		await client.followRun("run id", onSnapshot, new AbortController().signal);
		expect(fetched.mock.calls[0][0]).toBe(`${BASE}/ax/v1/runs/run%20id/stream`);
		expect(onSnapshot.mock.calls).toEqual([[steps]]);
	});

	it("calls each operation at its path under /ax/v1 with the credential's bearer, and returns the body as served", async () => {
		const served = { setId: "s1", anything: { the: "platform sends" } };
		const { client, requests, asked } = clientOver([
			{ status: 200, body: served },
			{ status: 201, body: served },
			{ status: 200, body: served },
			{ status: 200, body: { sets: [] } },
			{ status: 200, body: { setId: "s1", cancelled: true } },
		]);
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
		expect(asked.renew).toBe(0);
	});

	it("asks the credential for a new bearer, once, when the platform answers 401 (a bearer that ran out while watching)", async () => {
		const { client, requests, asked } = clientOver([
			{ status: 401, body: { error: "Unauthorized" } },
			{ status: 200, body: { sets: [] } },
		]);
		expect(await client.list()).toEqual({ sets: [] });
		expect(requests.map((r) => r.authorization)).toEqual(["Bearer bearer-1", "Bearer bearer-2"]);
		expect(asked.renew).toBe(1);
	});

	it("a 401 that survives the renewal is the credential's own failure, with ora's answer as its cause", async () => {
		const body = { error: "Unauthorized", code: "UNAUTHORIZED" };
		const { client, asked } = clientOver([
			{ status: 401, body },
			{ status: 401, body },
		]);
		const error = (await client.list().catch((e: unknown) => e)) as Error;
		expect(error.message).toContain("rejected");
		expect(error.cause).toBeInstanceOf(PlatformApiError);
		expect(error.cause).toMatchObject({ status: 401, payload: body });
		expect(asked.renew).toBe(1);
	});

	it("a refusal is thrown with its status, its own sentence and its body untouched", async () => {
		const body = {
			error: "Unprocessable",
			code: "SET_INVALID",
			message: "The site must be a domain such as example.com, or an http(s) URL.",
		};
		const { client } = clientOver([{ status: 422, body }]);
		const error = await client.preview({ site: "nope", goals: ["x"] }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PlatformApiError);
		expect(error).toMatchObject({ status: 422, message: body.message, payload: body });
	});

	it("a validation refusal says what is wrong: the platform's own lines follow its message", async () => {
		// The body ora's set API gave for six goals on staging, 2026-11-22: its message alone says nothing.
		const body = {
			error: "Validation failed",
			code: "VALIDATION_ERROR",
			details: {
				errors: {
					body: [
						"goals: A set takes 1 to 5 goals.",
						"repeat: A set repeats each run 1 to 10 times.",
					],
				},
			},
		};
		const { client } = clientOver([{ status: 400, body }]);
		const error = await client
			.preview({ site: "linear.app", goals: ["x"] })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({
			status: 400,
			message:
				"Validation failed: goals: A set takes 1 to 5 goals.; repeat: A set repeats each run 1 to 10 times.",
			payload: body,
		});
	});

	it("a refusal for a missing scope is worded by the credential, naming the scope the platform listed", async () => {
		// The body a read-only key got for a preview on a local ora, 2026-11-22: it has no sentence.
		const body = {
			error: "Forbidden",
			code: "INSUFFICIENT_SCOPE",
			details: { missing: ["ax.sets:write"] },
		};
		const { client } = clientOver([{ status: 403, body }]);
		const error = await client
			.preview({ site: "linear.app", goals: ["x"] })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({
			status: 403,
			message: "This credential lacks ax.sets:write. Give it that, then try again.",
			payload: body,
		});
	});

	it("follows a set's live stream: each set event's document in order, keepalives ignored, however the bytes are chunked", async () => {
		const { credential } = fakeCredential();
		const text =
			'event: set\ndata: {"setId":"s1","state":"running"}\n\n: keepalive\n\nevent: set\ndata: {"setId":"s1","state":"complete"}\n\n';
		const bytes = new TextEncoder().encode(text);
		const seen: { url: string; accept: string }[] = [];
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			seen.push({
				url: String(url),
				accept: String((init?.headers as Record<string, string> | undefined)?.accept),
			});
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes.slice(0, 17));
						controller.enqueue(bytes.slice(17));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		const client = createSetsClient({
			base: BASE,
			credential,
			fetch: fetchMock as unknown as typeof fetch,
		});
		const states: string[] = [];
		await client.follow("s 1", (set) => states.push(set.state), new AbortController().signal);
		expect(states).toEqual(["running", "complete"]);
		expect(seen).toEqual([{ url: `${BASE}/ax/v1/sets/s%201/stream`, accept: "text/event-stream" }]);
	});

	it("a stream that cannot be opened rejects with the platform's status, so the caller can read instead", async () => {
		const { client } = clientOver([{ status: 404, body: { error: "Not Found" } }]);
		await expect(client.follow("s1", () => {}, new AbortController().signal)).rejects.toMatchObject(
			{ status: 404 },
		);
	});

	it("an answer that is not JSON is a failure, never an empty set", async () => {
		const { client } = clientOver([{ status: 200, body: null }]);
		await expect(client.list()).rejects.toThrow("non-JSON");
	});
});
