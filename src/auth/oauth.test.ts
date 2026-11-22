import { describe, expect, it } from "vitest";
import { fakeSignInServer, ISSUER, PLATFORM } from "./fake-sign-in-server.test-support";
import {
	DEVICE_CODE_GRANT,
	discover,
	OAuthError,
	pollDeviceToken,
	refreshTokens,
	revokeToken,
	startDeviceAuthorization,
} from "./oauth";
import { PLATFORM_FEATURES, scopeList, TUNNEL_FEATURE } from "./platform-features";
import {
	AX_CLIENT_ID,
	AX_SCOPES,
	platformResource,
	SIGN_IN_SCOPE,
	signInTarget,
} from "./sign-in-target";

// ax's OAuth client against a stand-in for ora's sign-in server. Each case changes one answer.

const TARGET = { issuer: ISSUER, resource: PLATFORM, clientId: AX_CLIENT_ID };

/** The stand-in server, with one change to its discovery answer (a field set to undefined is left out). */
function withMetadata(change: Record<string, unknown>): typeof fetch {
	const server = fakeSignInServer();
	return async (input, init) => {
		const res = await server.fetchFn(input, init);
		if (!String(input).endsWith("/.well-known/oauth-authorization-server")) return res;
		const body = (await res.json()) as Record<string, unknown>;
		return new Response(JSON.stringify({ ...body, ...change }), {
			status: res.status,
			headers: { "content-type": "application/json" },
		});
	};
}

describe("where ax signs in", () => {
	it("is account.<domain> for a platform at api.<domain>, scheme and port kept", () => {
		expect(signInTarget("https://api.ora.ai")).toEqual({
			issuer: "https://account.ora.ai",
			resource: "https://api.ora.ai",
			clientId: "ax-cli",
		});
		expect(signInTarget("http://api.ora.localhost:8081")?.issuer).toBe(
			"http://account.ora.localhost:8081",
		);
	});

	it("is nowhere for a platform address that is not api.<domain>", () => {
		expect(signInTarget("https://platform.example.test")).toBeNull();
	});

	it("names the platform's origin as the audience, whatever its spelling", () => {
		expect(platformResource("https://API.ora.ai/")).toBe("https://api.ora.ai");
	});

	it("asks for what ax's commands use and nothing else, plus a refresh token", () => {
		// No tunnels:read: ax creates, connects and deletes a tunnel, and never lists or reads one.
		expect(SIGN_IN_SCOPE.split(" ")).toEqual([
			"openid",
			"offline_access",
			"runs:read",
			"runs:write",
			"tunnels:write",
			"tunnels:connect",
		]);
	});

	it("asks for every feature's scopes, so a feature's hint never names one ax does not request", () => {
		for (const feature of PLATFORM_FEATURES) {
			for (const scope of feature.scopes) expect(AX_SCOPES).toContain(scope);
		}
		expect(scopeList(TUNNEL_FEATURE)).toBe("tunnels:write + tunnels:connect");
	});
});

describe("discovery", () => {
	it("reads the server's addresses", async () => {
		const meta = await discover(ISSUER, fakeSignInServer().fetchFn);
		expect(meta).toEqual({
			issuer: ISSUER,
			deviceAuthorizationEndpoint: `${ISSUER}/oauth2/device/auth`,
			tokenEndpoint: `${ISSUER}/oauth2/token`,
			revocationEndpoint: `${ISSUER}/oauth2/revoke`,
		});
	});

	it("an ora that does not offer browser sign-in yet says so", async () => {
		const error = await discover(ISSUER, fakeSignInServer({ discovery: "missing" }).fetchFn).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(OAuthError);
		expect(error.code).toBe("not_offered");
	});

	it("refuses a server that answers for another issuer (RFC 8414 §3.3)", async () => {
		const error = await discover(
			ISSUER,
			fakeSignInServer({ discovery: "other-issuer" }).fetchFn,
		).catch((e) => e);
		expect(error.code).toBe("issuer_mismatch");
	});

	it("refuses an address on another host: a code or a token is never sent off the issuer", async () => {
		const error = await discover(ISSUER, fakeSignInServer({ discovery: "off-host" }).fetchFn).catch(
			(e) => e,
		);
		expect(error.code).toBe("invalid_metadata");
		expect(error.message).toContain("elsewhere.test");
	});

	it("a server that is down (503) is transient, and says nothing of whether ora offers a sign-in", async () => {
		const error = await discover(ISSUER, fakeSignInServer({ discovery: "down" }).fetchFn).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(OAuthError);
		expect(error.code).not.toBe("not_offered");
		expect(error).toMatchObject({
			status: 503,
			transient: true,
			message: "account.ora.test answered HTTP 503",
		});
	});

	it.each([null, undefined])(
		"a revocation address of %s is none (RFC 8414 §2: it is optional)",
		async (named) => {
			const meta = await discover(ISSUER, withMetadata({ revocation_endpoint: named }));
			expect(meta.revocationEndpoint).toBeUndefined();
			expect(meta.tokenEndpoint).toBe(`${ISSUER}/oauth2/token`);
		},
	);
});

describe("the device flow", () => {
	it("starts a sign-in as ax, for the platform, asking ax's scopes", async () => {
		const server = fakeSignInServer();
		const meta = await discover(ISSUER, server.fetchFn);
		const device = await startDeviceAuthorization(meta, TARGET, SIGN_IN_SCOPE, server.fetchFn);
		expect(device).toMatchObject({
			deviceCode: "device-1",
			userCode: "ABCD-EFGH",
			verificationUri: `${ISSUER}/device?user_code=ABCD-EFGH`,
			interval: 5,
		});
		const sent = server.lastForm();
		expect([sent.get("client_id"), sent.get("resource"), sent.get("scope")]).toEqual([
			"ax-cli",
			PLATFORM,
			SIGN_IN_SCOPE,
		]);
	});

	it("an ora that does not know ax yet refuses it by name", async () => {
		const server = fakeSignInServer({ start: "invalid_client" });
		const meta = await discover(ISSUER, server.fetchFn);
		const error = await startDeviceAuthorization(meta, TARGET, SIGN_IN_SCOPE, server.fetchFn).catch(
			(e) => e,
		);
		expect(error.code).toBe("invalid_client");
	});

	it.each([
		["pending", { kind: "pending" }],
		["slow_down", { kind: "slow_down" }],
	] as const)(
		"a poll the server answers %s is an answer, not a failure",
		async (answer, expected) => {
			const server = fakeSignInServer({ polls: [answer] });
			const meta = await discover(ISSUER, server.fetchFn);
			expect(await pollDeviceToken(meta, TARGET, "device-1", server.fetchFn)).toEqual(expected);
			expect(server.lastForm().get("grant_type")).toBe(DEVICE_CODE_GRANT);
		},
	);

	it("an approved poll brings the tokens", async () => {
		const server = fakeSignInServer({ polls: ["approve"] });
		const meta = await discover(ISSUER, server.fetchFn);
		const poll = await pollDeviceToken(meta, TARGET, "device-1", server.fetchFn);
		expect(poll).toEqual({
			kind: "tokens",
			tokens: {
				accessToken: "access-1",
				refreshToken: "refresh-1",
				expiresIn: 900,
				scope: expect.any(String),
			},
		});
	});

	it.each(["denied", "expired"] as const)(
		"a %s code is a refusal with OAuth's own code",
		async (answer) => {
			const server = fakeSignInServer({ polls: [answer] });
			const meta = await discover(ISSUER, server.fetchFn);
			const error = await pollDeviceToken(meta, TARGET, "device-1", server.fetchFn).catch((e) => e);
			expect(error.code).toBe(answer === "denied" ? "access_denied" : "expired_token");
		},
	);

	it.each([
		["unavailable", "account.ora.test answered HTTP 502"],
		["rate_limited", "account.ora.test answered HTTP 429"],
		["drop", "could not reach account.ora.test (ECONNRESET)"],
	] as const)(
		"a poll the server answers %s is a transient OAuthError, for the caller to wait out",
		async (answer, message) => {
			const server = fakeSignInServer({ polls: [answer] });
			const meta = await discover(ISSUER, server.fetchFn);
			const error = await pollDeviceToken(meta, TARGET, "device-1", server.fetchFn).catch((e) => e);
			expect(error).toBeInstanceOf(OAuthError);
			expect(error).toMatchObject({ transient: true, message });
		},
	);

	it("a code refused in the browser is the server's word: not transient", async () => {
		const server = fakeSignInServer({ polls: ["denied"] });
		const meta = await discover(ISSUER, server.fetchFn);
		const error = await pollDeviceToken(meta, TARGET, "device-1", server.fetchFn).catch((e) => e);
		expect(error).toMatchObject({ code: "access_denied", status: 400, transient: false });
	});
});

describe("refresh and revoke", () => {
	it("a refresh sends the refresh token as ax, for the platform", async () => {
		const server = fakeSignInServer();
		const tokens = await refreshTokens(
			`${ISSUER}/oauth2/token`,
			TARGET,
			"refresh-0",
			server.fetchFn,
		);
		expect(tokens.accessToken).toBe("access-1");
		const sent = server.lastForm();
		expect([sent.get("grant_type"), sent.get("refresh_token"), sent.get("client_id")]).toEqual([
			"refresh_token",
			"refresh-0",
			"ax-cli",
		]);
	});

	it("a refused refresh is invalid_grant", async () => {
		const server = fakeSignInServer({ refresh: "invalid_grant" });
		const error = await refreshTokens(
			`${ISSUER}/oauth2/token`,
			TARGET,
			"refresh-0",
			server.fetchFn,
		).catch((e) => e);
		expect(error.code).toBe("invalid_grant");
	});

	it("a refresh the server cannot answer (503) is transient, and says the sign-in could not be renewed", async () => {
		const server = fakeSignInServer({ refresh: "unavailable" });
		const error = await refreshTokens(
			`${ISSUER}/oauth2/token`,
			TARGET,
			"refresh-0",
			server.fetchFn,
		).catch((e) => e);
		expect(error).toBeInstanceOf(OAuthError);
		expect(error).toMatchObject({
			status: 503,
			transient: true,
			message: "the sign-in could not be renewed: account.ora.test answered HTTP 503",
		});
	});

	it("a refresh that gets no answer is transient, and names the host and Node's code", async () => {
		const server = fakeSignInServer({ refresh: "unreachable" });
		const error = await refreshTokens(
			`${ISSUER}/oauth2/token`,
			TARGET,
			"refresh-0",
			server.fetchFn,
		).catch((e) => e);
		expect(error).toBeInstanceOf(OAuthError);
		expect(error).toMatchObject({
			code: "unreachable",
			status: 0,
			transient: true,
			message: "the sign-in could not be renewed: could not reach account.ora.test (ECONNREFUSED)",
		});
	});

	it("a refused refresh token stays terminal: the sign-in is over, nothing to wait out", async () => {
		const server = fakeSignInServer({ refresh: "invalid_grant" });
		const error = await refreshTokens(
			`${ISSUER}/oauth2/token`,
			TARGET,
			"refresh-0",
			server.fetchFn,
		).catch((e) => e);
		expect(error).toBeInstanceOf(OAuthError);
		expect(error).toMatchObject({ code: "invalid_grant", status: 400, transient: false });
		expect(error.message).toMatch(/^the sign-in could not be renewed: /);
	});

	it("revoking hands the server the refresh token, and never throws", async () => {
		const server = fakeSignInServer();
		expect(
			await revokeToken(`${ISSUER}/oauth2/revoke`, "ax-cli", "refresh-9", server.fetchFn),
		).toBe(true);
		expect(server.state.revoked).toEqual(["refresh-9"]);
		const down = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		expect(await revokeToken(`${ISSUER}/oauth2/revoke`, "ax-cli", "refresh-9", down)).toBe(false);
	});
});
