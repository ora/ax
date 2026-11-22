import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeyDestinationError } from "../api/key-destination";
import { NotSignedInError } from "./errors";
import { ISSUER, PLATFORM } from "./fake-sign-in-server.test-support";
import { TUNNEL_FEATURE } from "./platform-features";
import { platformCredentials } from "./resolve-credential";
import { SessionStore, type StoredSignIn } from "./session-store";

// Which credential a platform call signs with: ONE chain, asked by routing, by every command
// and by every "which one wins" hint. The environment and the store are handed in, so nothing
// here reads this machine's own sign-in or key.

const freshStore = () => new SessionStore(mkdtempSync(join(tmpdir(), "ax-chain-")));
const signIn = (resource = PLATFORM): StoredSignIn => ({
	version: 1,
	issuer: ISSUER,
	clientId: "ax-cli",
	resource,
	tokenEndpoint: `${ISSUER}/oauth2/token`,
	accessToken: "access-0",
	refreshToken: "refresh-0",
	expiresAt: Date.now() + 15 * 60_000,
	scope: "runs:read",
});

function chainWith(input: { key?: string; signedInFor?: string }) {
	const store = freshStore();
	if (input.signedInFor) store.write(signIn(input.signedInFor));
	const env: NodeJS.ProcessEnv = input.key ? { ORA_API_KEY: input.key } : {};
	return platformCredentials({ store, env });
}

describe("which credential a platform call signs with", () => {
	it("ORA_API_KEY beats a stored sign-in, so CI and scripts behave as before", () => {
		const { chain } = chainWith({ key: "ora_sk_env", signedInFor: PLATFORM });
		expect(chain.find(PLATFORM)?.label).toBe("ORA_API_KEY (a platform key)");
	});

	it("without a key, the sign-in stored for this platform", () => {
		const { chain } = chainWith({ signedInFor: PLATFORM });
		expect(chain.find(PLATFORM)?.label).toBe("ax login (browser sign-in)");
	});

	it("a sign-in is used for the platform it was issued for, whatever the address's spelling", () => {
		const { chain } = chainWith({ signedInFor: PLATFORM });
		expect(chain.find("https://API.ora.test/")).not.toBeNull();
		expect(chain.find("https://api.other.test")).toBeNull();
	});

	it("finding is never a failure: with neither there is simply none", () => {
		expect(chainWith({}).chain.find(PLATFORM)).toBeNull();
	});
});

describe("a call that cannot go without a credential", () => {
	it("with neither, says both ways in and the scopes the call needs", () => {
		const error = (() => {
			try {
				chainWith({}).chain.resolve(PLATFORM, TUNNEL_FEATURE);
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(NotSignedInError);
		expect(String(error)).toMatch(/ax login.*ORA_API_KEY/s);
		expect(String(error)).toContain("tunnels:write + tunnels:connect");
	});

	it("a sign-in for another platform is named, never used", () => {
		const { chain } = chainWith({ signedInFor: "https://api.other.test" });
		expect(() => chain.resolve(PLATFORM)).toThrow(
			`Your ax sign-in is for https://api.other.test, not ${PLATFORM}.`,
		);
	});
});

describe("a platform address that is not a URL (no scheme)", () => {
	// The sign-in stored here is for https://api.ora.test; ORA_PLATFORM_URL lost its scheme.
	const NO_SCHEME = "api.ora.test";

	it("has no sign-in for it, and finding one still never throws", () => {
		const { chain, signIns } = chainWith({ signedInFor: PLATFORM });
		expect(signIns.find(NO_SCHEME)).toBeNull();
		expect(chain.find(NO_SCHEME)).toBeNull();
	});

	it("names the platform the stored sign-in is for instead", () => {
		const { signIns } = chainWith({ signedInFor: PLATFORM });
		expect(signIns.heldFor(NO_SCHEME)).toBe(PLATFORM);
	});

	it("a call that cannot go without a credential is told to fix the address", () => {
		const { chain } = chainWith({ signedInFor: PLATFORM });
		expect(() => chain.resolve(NO_SCHEME)).toThrow(KeyDestinationError);
		expect(() => chain.resolve(NO_SCHEME)).toThrow("ORA_PLATFORM_URL is not a URL");
	});

	it("ORA_API_KEY is still found for it", () => {
		const { chain } = chainWith({ key: "ora_sk_env", signedInFor: PLATFORM });
		expect(chain.find(NO_SCHEME)?.label).toBe("ORA_API_KEY (a platform key)");
	});
});

describe("what wins over the stored sign-in", () => {
	it("is ORA_API_KEY when it is set, and nothing otherwise", () => {
		const withKey = chainWith({ key: "ora_sk_env", signedInFor: PLATFORM });
		expect(withKey.chain.ahead(PLATFORM, withKey.signIns)?.label).toBe(
			"ORA_API_KEY (a platform key)",
		);
		const without = chainWith({ signedInFor: PLATFORM });
		expect(without.chain.ahead(PLATFORM, without.signIns)).toBeNull();
	});
});
