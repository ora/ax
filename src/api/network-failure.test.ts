import { describe, expect, it, vi } from "vitest";
import { fetchText, hostOf, NetworkFailureError, networkFailure } from "./network-failure";

// The words for a request that got no answer: the host, and what happened (Node's errno code from
// the cause chain, or a passed deadline). fetch is handed in, so nothing leaves this machine.

const TOKEN_URL = "https://account.ora.test/oauth2/token";
const IDENTITY_URL = "https://api.ora.test/auth/identity";

/** An errno-style error, as Node attaches one under fetch's "fetch failed". */
const errno = (code: string): Error => Object.assign(new Error(`connect ${code}`), { code });

/** What AbortSignal.timeout makes fetch reject with once the deadline passes. */
const timeout = (): DOMException =>
	new DOMException("The operation was aborted due to timeout", "TimeoutError");

/** A body that sends a little, then breaks off with `error` (a connection reset mid-read). */
function cutOff(error: Error): Response {
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new TextEncoder().encode('{"sub":'));
			controller.error(error);
		},
	});
	return new Response(stream, { status: 200 });
}

describe("networkFailure", () => {
	it("names the host and the code Node nested two causes deep", () => {
		const cause = new TypeError("fetch failed", {
			cause: new Error("request failed", { cause: errno("ENOTFOUND") }),
		});
		expect(networkFailure(TOKEN_URL, cause, 15_000)).toBe(
			"could not reach account.ora.test (ENOTFOUND)",
		);
	});

	it("reads a passed deadline as the deadline it was given", () => {
		expect(networkFailure(TOKEN_URL, timeout(), 30_000)).toBe(
			"account.ora.test did not answer within 30 s",
		);
		expect(networkFailure(IDENTITY_URL, timeout(), 15_000)).toBe(
			"api.ora.test did not answer within 15 s",
		);
	});

	it("falls back to the message when no error in the chain carries a code", () => {
		expect(networkFailure(TOKEN_URL, new TypeError("fetch failed"), 15_000)).toBe(
			"could not reach account.ora.test (fetch failed)",
		);
		const blank = Object.assign(new Error("socket hang up"), { code: "" });
		expect(networkFailure(TOKEN_URL, blank, 15_000)).toBe(
			"could not reach account.ora.test (socket hang up)",
		);
		expect(networkFailure(TOKEN_URL, "connection closed", 15_000)).toBe(
			"could not reach account.ora.test (connection closed)",
		);
	});
});

describe("hostOf", () => {
	it("is a URL's host, its port kept", () => {
		expect(hostOf("http://127.0.0.1:8081/oauth2/token")).toBe("127.0.0.1:8081");
		expect(hostOf(TOKEN_URL)).toBe("account.ora.test");
	});

	it("is the text itself when it is not a URL", () => {
		expect(hostOf("account.ora.test")).toBe("account.ora.test");
		expect(hostOf("not a url")).toBe("not a url");
	});
});

describe("fetchText", () => {
	it("returns the answer and its body, the deadline handed to fetch as a signal", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response('{"sub":"user-1"}'));
		const { res, text } = await fetchText(
			IDENTITY_URL,
			{ headers: { accept: "application/json" } },
			15_000,
			fetchFn,
		);
		expect([res.status, text]).toEqual([200, '{"sub":"user-1"}']);
		const [url, init] = fetchFn.mock.calls[0] ?? [];
		expect(url).toBe(IDENTITY_URL);
		expect(init?.headers).toEqual({ accept: "application/json" });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("a request that gets no answer is a NetworkFailureError naming the host, the original its cause", async () => {
		const refused = new TypeError("fetch failed", { cause: errno("ECONNREFUSED") });
		const error = await fetchText(IDENTITY_URL, {}, 15_000, async () => {
			throw refused;
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NetworkFailureError);
		expect(error).toMatchObject({
			name: "NetworkFailureError",
			message: "could not reach api.ora.test (ECONNREFUSED)",
		});
		expect((error as Error).cause).toBe(refused);
	});

	it("a request whose deadline passes says how long it waited", async () => {
		const error = await fetchText(IDENTITY_URL, {}, 20_000, async () => {
			throw timeout();
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NetworkFailureError);
		expect((error as Error).message).toBe("api.ora.test did not answer within 20 s");
	});

	it("a body that breaks off while it is read is a NetworkFailureError too", async () => {
		const reset = new TypeError("terminated", { cause: errno("ECONNRESET") });
		const error = await fetchText(IDENTITY_URL, {}, 15_000, async () => cutOff(reset)).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(NetworkFailureError);
		expect(error).toMatchObject({ message: "could not reach api.ora.test (ECONNRESET)" });
		expect((error as Error).cause).toBe(reset);
	});
});
