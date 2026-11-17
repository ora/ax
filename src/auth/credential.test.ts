import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeyCredential, resolvePlatformCredential } from "../api/platform";
import { NotSignedInError, SignInCredential, SignInEndedError, signInFor } from "./credential";
import { fakeSignInServer, ISSUER, PLATFORM } from "./fake-sign-in-server.test-support";
import { configDir, SessionStore, type StoredSignIn } from "./session-store";

// The stored sign-in, and the credential a platform call signs with. Each case changes one thing.

const NOW = 1_000_000;
const freshStore = () => new SessionStore(mkdtempSync(join(tmpdir(), "ax-sign-in-")));
const session = (over: Partial<StoredSignIn> = {}): StoredSignIn => ({
	version: 1,
	issuer: ISSUER,
	clientId: "ax-cli",
	resource: PLATFORM,
	tokenEndpoint: `${ISSUER}/oauth2/token`,
	revocationEndpoint: `${ISSUER}/oauth2/revoke`,
	accessToken: "access-0",
	refreshToken: "refresh-0",
	expiresAt: NOW + 15 * 60_000,
	scope: "runs:read",
	...over,
});

afterEach(() => vi.unstubAllEnvs());

describe("the stored sign-in", () => {
	it("lives in $XDG_CONFIG_HOME/ax, else %APPDATA%\\ax on Windows, else ~/.config/ax", () => {
		expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/me")).toBe("/x/ax");
		expect(configDir({ APPDATA: "C:\\Users\\me\\AppData" }, "win32", "C:\\Users\\me")).toContain(
			"ax",
		);
		expect(configDir({}, "darwin", "/Users/me")).toBe("/Users/me/.config/ax");
	});

	it("is readable by you alone, and read back as written", () => {
		const store = freshStore();
		store.write(session());
		expect(statSync(store.file).mode & 0o777).toBe(0o600);
		expect(statSync(store.dir).mode & 0o777).toBe(0o700);
		expect(store.read()).toEqual(session());
	});

	it("a file of another shape is no sign-in", async () => {
		const store = freshStore();
		const { writeFileSync } = await import("node:fs");
		writeFileSync(store.file, JSON.stringify({ version: 1, accessToken: "x" }));
		expect(store.read()).toBeNull();
	});

	it("is used only for the platform it was issued for", () => {
		const store = freshStore();
		store.write(session());
		expect(signInFor(PLATFORM, store)).not.toBeNull();
		expect(signInFor("https://api.other.test", store)).toBeNull();
	});
});

describe("which credential a platform call uses", () => {
	it("ORA_API_KEY beats a stored sign-in", () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_env");
		const store = freshStore();
		store.write(session());
		expect(resolvePlatformCredential({ base: PLATFORM, store })).toBeInstanceOf(ApiKeyCredential);
	});

	it("without a key, the sign-in for this platform", () => {
		vi.stubEnv("ORA_API_KEY", "");
		const store = freshStore();
		store.write(session());
		expect(resolvePlatformCredential({ base: PLATFORM, store }).kind).toBe("sign_in");
	});
});

describe("which credential a platform call uses (refusals)", () => {
	it("with neither, says both ways in", () => {
		vi.stubEnv("ORA_API_KEY", "");
		const error = (() => {
			try {
				resolvePlatformCredential({ base: PLATFORM, store: freshStore() });
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(NotSignedInError);
		expect(String((error as Error).message)).toMatch(/ax login.*ORA_API_KEY/s);
	});

	it("a sign-in for another platform is named, never used", () => {
		vi.stubEnv("ORA_API_KEY", "");
		const store = freshStore();
		store.write(session({ resource: "https://api.other.test" }));
		const error = (() => {
			try {
				resolvePlatformCredential({ base: PLATFORM, store });
			} catch (e) {
				return e as Error;
			}
		})();
		expect(error?.message).toContain("is for https://api.other.test");
	});
});

describe("a sign-in's bearer", () => {
	it("is the stored access token while it has more than a minute left, with no request", async () => {
		const server = fakeSignInServer();
		const store = freshStore();
		store.write(session());
		const credential = new SignInCredential(store, session(), server.fetchFn, () => NOW);
		expect(await credential.bearer()).toBe("access-0");
		expect(server.calls).not.toHaveBeenCalled();
	});

	it("is renewed a minute before it expires, and the rotated sign-in is stored", async () => {
		const server = fakeSignInServer();
		const store = freshStore();
		const near = session({ expiresAt: NOW + 30_000 });
		store.write(near);
		const credential = new SignInCredential(store, near, server.fetchFn, () => NOW);
		expect(await credential.bearer()).toBe("access-1");
		expect(store.read()).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
		expect(server.state.refreshes).toBe(1);
	});

	it("two renewals at once make ONE refresh: the second finds the first's and uses it", async () => {
		const server = fakeSignInServer();
		const store = freshStore();
		const near = session({ expiresAt: NOW + 30_000 });
		store.write(near);
		const one = new SignInCredential(store, near, server.fetchFn, () => NOW);
		const two = new SignInCredential(store, near, server.fetchFn, () => NOW);
		const bearers = await Promise.all([one.bearer(), two.bearer()]);
		expect(server.state.refreshes).toBe(1);
		expect(bearers).toEqual(["access-1", "access-1"]);
	});

	it("a refresh token the server refuses ends the sign-in here: removed, and said so", async () => {
		const server = fakeSignInServer({ refresh: "invalid_grant" });
		const store = freshStore();
		store.write(session());
		const credential = new SignInCredential(store, session(), server.fetchFn, () => NOW);
		const error = await credential.renew().catch((e) => e);
		expect(error).toBeInstanceOf(SignInEndedError);
		expect(error.message).toContain("ax login");
		expect(store.read()).toBeNull();
	});

	it("a refresh that cannot reach the server keeps the sign-in: an outage is not an ending", async () => {
		const server = fakeSignInServer({ refresh: "down" });
		const store = freshStore();
		store.write(session());
		const credential = new SignInCredential(store, session(), server.fetchFn, () => NOW);
		await expect(credential.renew()).rejects.toThrow("fetch failed");
		expect(store.read()).toEqual(session());
	});

	it("signed out on this machine meanwhile: the renewal says so and stores nothing", async () => {
		const server = fakeSignInServer();
		const store = freshStore();
		const credential = new SignInCredential(store, session(), server.fetchFn, () => NOW);
		await expect(credential.renew()).rejects.toBeInstanceOf(SignInEndedError);
		expect(server.state.refreshes).toBe(0);
	});
});
