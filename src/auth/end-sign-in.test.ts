import { describe, expect, it } from "vitest";
import { endSignIn } from "./end-sign-in";
import { fakeSignInServer, ISSUER, PLATFORM } from "./fake-sign-in-server.test-support";
import type { StoredSignIn } from "./session-store";

const SESSION: StoredSignIn = {
	version: 1,
	issuer: ISSUER,
	clientId: "ax-cli",
	resource: PLATFORM,
	tokenEndpoint: `${ISSUER}/oauth2/token`,
	revocationEndpoint: `${ISSUER}/oauth2/revoke`,
	accessToken: "access-1",
	refreshToken: "refresh-1",
	expiresAt: 1_000_000,
	scope: "runs:read",
};

describe("endSignIn", () => {
	it("hands ora the sign-in's refresh token to end it there", async () => {
		const server = fakeSignInServer();
		expect(await endSignIn(SESSION, server.fetchFn)).toBe(true);
		expect(server.state.revoked).toEqual(["refresh-1"]);
	});

	it("without a revocation address, sends nothing and says it did not end it there", async () => {
		const server = fakeSignInServer();
		const { revocationEndpoint: _none, ...withoutOne } = SESSION;
		expect(await endSignIn(withoutOne, server.fetchFn)).toBe(false);
		expect(server.calls).not.toHaveBeenCalled();
	});
});
