import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInEndedError } from "../auth/errors";
import { fakeSignInServer, ISSUER, PLATFORM } from "../auth/fake-sign-in-server.test-support";
import { platformCredentials } from "../auth/resolve-credential";
import { SessionStore, type StoredSignIn } from "../auth/session-store";
import { SignInCredential } from "../auth/sign-in-credential";
import { type LoginDeps, loginCommand } from "./login";
import { logoutCommand } from "./logout";

// Two ax commands on one machine changing the same sign-in at once. ora rotates the refresh token
// on every use and reads a second use of a spent one as theft, so what matters is which sign-in
// ends up stored and which token is ended on the server. In each case one command's renewal is
// held at the sign-in server, and answered only when the test says, while the other one runs.

let printed: string[];

beforeEach(() => {
	vi.stubEnv("ORA_PLATFORM_URL", PLATFORM);
	vi.stubEnv("ORA_API_KEY", "");
	printed = [];
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation((line: unknown) => void printed.push(String(line)));
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const SIGN_IN: StoredSignIn = {
	version: 1,
	issuer: ISSUER,
	clientId: "ax-cli",
	resource: PLATFORM,
	tokenEndpoint: `${ISSUER}/oauth2/token`,
	revocationEndpoint: `${ISSUER}/oauth2/revoke`,
	accessToken: "access-0",
	refreshToken: "refresh-0",
	expiresAt: Date.now() + 15 * 60_000,
	scope: "runs:read",
};

/** A store that says when it is first asked for the lock: the moment its command starts to wait. */
class WatchedStore extends SessionStore {
	private readonly asked = deferred();
	readonly lockAsked = this.asked.promise;

	override withLock<T>(fn: () => Promise<T>): Promise<T> {
		this.asked.resolve();
		return super.withLock(fn);
	}
}

/**
 * One machine with the sign-in stored, the stand-in server, and another ax command's credential
 * for it, whose refresh waits at the server from `sent` until the test calls `answer`.
 */
function machineRenewing(overrides: Parameters<typeof fakeSignInServer>[0] = {}) {
	const server = fakeSignInServer(overrides);
	const dir = mkdtempSync(join(tmpdir(), "ax-races-"));
	const store = new SessionStore(dir);
	store.write(SIGN_IN);
	const sent = deferred();
	const answered = deferred();
	const held: typeof fetch = async (input, init) => {
		const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
		if (form.get("grant_type") === "refresh_token") {
			sent.resolve();
			await answered.promise;
		}
		return server.fetchFn(input, init);
	};
	const credential = new SignInCredential(PLATFORM, new SessionStore(dir), SIGN_IN, held);
	return { server, dir, store, credential, sent: sent.promise, answer: answered.resolve };
}

/** `ax login` on the same machine: the server approves its code at the first poll. */
function loginOn(store: SessionStore, server: ReturnType<typeof fakeSignInServer>): LoginDeps {
	let clock = 1_000_000;
	return {
		fetchFn: server.fetchFn,
		credentials: platformCredentials({ store, fetchFn: server.fetchFn }),
		openBrowser: () => false,
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
		interactive: false,
	};
}

describe("a renewal in flight, and another command", () => {
	it("ax logout waits for the renewal, then ends the renewed token, never the spent one", async () => {
		const { server, dir, store, credential, sent, answer } = machineRenewing();
		const renewing = credential.renew();
		await sent;
		const logoutStore = new WatchedStore(dir);
		const loggingOut = logoutCommand(
			{ json: false },
			{
				fetchFn: server.fetchFn,
				credentials: platformCredentials({ store: logoutStore, fetchFn: server.fetchFn }),
			},
		);
		await Promise.race([logoutStore.lockAsked, loggingOut]);
		answer();
		const renewed = await renewing.catch((e: unknown) => e);
		expect(await loggingOut).toBe(0);
		// The renewal spent refresh-0 for refresh-1: refresh-1 is the token that still works.
		expect(server.state.revoked).toEqual(["refresh-1"]);
		expect(store.present()).toBe(false);
		expect(printed.join("\n")).toContain(`Signed out of ${PLATFORM}.`);
		expect(renewed).toBe("access-1");
	});

	it("ax login stores its sign-in after the renewal, and ends the old sign-in's renewed token", async () => {
		const { server, dir, store, credential, sent, answer } = machineRenewing();
		const renewing = credential.renew();
		await sent;
		const loginStore = new WatchedStore(dir);
		const loggingIn = loginCommand({ json: false, noBrowser: true }, loginOn(loginStore, server));
		await Promise.race([loginStore.lockAsked, loggingIn]);
		answer();
		const renewed = await renewing.catch((e: unknown) => e);
		expect(await loggingIn).toBe(0);
		// The server's first tokens went to ax login (approved while the refresh was held), its
		// second to the renewal: refresh-2 is the old sign-in's latest, the one that still works.
		expect(store.read()).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
		expect(server.state.revoked).toEqual(["refresh-2"]);
		expect(renewed).toBe("access-2");
	});
});

describe("a renewal whose lock was broken as stale", () => {
	it("a refusal that arrives after a newer sign-in was written leaves the newer one stored", async () => {
		const { store, credential, sent, answer } = machineRenewing({ refresh: "invalid_grant" });
		const renewing = credential.renew();
		await sent;
		// The renewal outlived the lock's stale window, and another ax that broke the lock wrote
		// straight into the file while the refresh was out.
		const newer: StoredSignIn = {
			...SIGN_IN,
			accessToken: "access-new",
			refreshToken: "refresh-new",
		};
		store.write(newer);
		answer();
		await expect(renewing).rejects.toBeInstanceOf(SignInEndedError);
		expect(store.read()).toEqual(newer);
	});
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
