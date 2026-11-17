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
