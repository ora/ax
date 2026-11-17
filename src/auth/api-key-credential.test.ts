import { describe, expect, it, vi } from "vitest";
import { KeyDestinationError } from "../api/key-destination";
import { servedBody } from "../report/error-chain";
import { ApiKeyCredential, exchangeKey } from "./api-key-credential";
import { KeyRejectedError } from "./errors";

// A platform key as a credential: traded for a bearer at /auth/token, asked who it is at
// /auth/identity with the key itself, and never sent anywhere the destination rule refuses.

const BASE = "https://api.ora.test";

const asJson = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A platform that answers the trade and the identity read, and records what it was sent. */
function platform(answers: { token?: Response; identity?: Response } = {}) {
	const calls: Array<{ url: string; authorization: string | null; signal?: AbortSignal | null }> =
		[];
	const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
		const url = String(input);
		calls.push({
			url,
			authorization: new Headers(init?.headers).get("authorization"),
			signal: init?.signal,
		});
		if (url === `${BASE}/auth/token`) return answers.token ?? asJson({ token: "traded-1" });
		if (url === `${BASE}/auth/identity`) {
			return answers.identity ?? asJson({ sub: "key-1", type: "api_key", organizationId: "org-1" });
		}
		return asJson({ error: "unexpected" }, 599);
	});
	return { calls, fetchFn };
}

describe("exchangeKey", () => {
	it("never sends the key over plain http to a host other than this machine", async () => {
		const { calls, fetchFn } = platform();
		await expect(exchangeKey("http://collector.example", "ora_sk_local", fetchFn)).rejects.toThrow(
			KeyDestinationError,
		);
		expect(calls).toHaveLength(0);
	});

	it("bounds the exchange, so a platform that never answers does not hang the command", async () => {
		const { calls, fetchFn } = platform();
		expect(await exchangeKey(BASE, "ora_sk_local", fetchFn)).toBe("traded-1");
		expect(calls[0].signal).toBeInstanceOf(AbortSignal);
	});

	it("a key ora refuses is the key's own refusal, with ora's body on the error it wraps", async () => {
		const refused = { code: "INVALID_CREDENTIAL" };
		const { fetchFn } = platform({ token: asJson(refused, 401) });
		const error = await exchangeKey(BASE, "ora_sk_local", fetchFn).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(KeyRejectedError);
		expect(String(error)).toContain("Check ORA_API_KEY");
		expect(servedBody(error)).toEqual(refused);
	});
});

describe("a platform key's identity", () => {
	it("is asked of /auth/identity with the key itself, and no token is traded for it", async () => {
		const { calls, fetchFn } = platform();
		const credential = new ApiKeyCredential(BASE, "ora_sk_local", fetchFn);
		expect(await credential.readIdentity()).toMatchObject({ organizationId: "org-1" });
		expect(calls.map((call) => [call.url, call.authorization])).toEqual([
			[`${BASE}/auth/identity`, "Bearer ora_sk_local"],
		]);
	});

	it("is held to the destination rule like the trade: nothing is sent", async () => {
		const { calls, fetchFn } = platform();
		const credential = new ApiKeyCredential("http://collector.example", "ora_sk_local", fetchFn);
		await expect(credential.readIdentity()).rejects.toThrow(KeyDestinationError);
		expect(calls).toHaveLength(0);
	});

	it("a key ora refuses says to check ORA_API_KEY", async () => {
		const { fetchFn } = platform({ identity: asJson({ code: "INVALID_CREDENTIAL" }, 401) });
		const credential = new ApiKeyCredential(BASE, "ora_sk_local", fetchFn);
		const error = await credential.readIdentity().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(KeyRejectedError);
		expect(String(error)).toContain("Check ORA_API_KEY");
	});
});

describe("a platform key, as a person reads it", () => {
	const credential = new ApiKeyCredential(BASE, "ora_sk_local");

	it("is named for where it was set, and its refusals say what to do with a key", () => {
		expect(credential.label).toBe("ORA_API_KEY (a platform key)");
		expect(credential.refusal.forbidden("runs:read + runs:write")).toContain(
			"lacks the runs:read + runs:write scopes",
		);
		expect(credential.rejected("ora closed the tunnel (4401)")).toBeInstanceOf(KeyRejectedError);
	});
});
