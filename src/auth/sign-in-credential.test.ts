import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SignInEndedError } from "./errors";
import { fakeSignInServer, ISSUER, PLATFORM } from "./fake-sign-in-server.test-support";
import { SessionStore, type StoredSignIn } from "./session-store";
import { SignInCredential } from "./sign-in-credential";

// The sign-in `ax login` stored, as the credential a platform call signs with. Each case changes
// one thing.

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

function signedIn(stored: StoredSignIn, server = fakeSignInServer()) {
	const store = freshStore();
	store.write(stored);
	const credential = new SignInCredential(PLATFORM, store, stored, server.fetchFn, () => NOW);
	return { store, server, credential };
}

describe("a sign-in's bearer", () => {
	it("is the stored access token while it has more than a minute left, with no request", async () => {
		const { credential, server } = signedIn(session());
		expect(await credential.bearer()).toBe("access-0");
		expect(server.calls).not.toHaveBeenCalled();
	});

	it("is renewed a minute before it expires, and the rotated sign-in is stored", async () => {
		const { credential, server, store } = signedIn(session({ expiresAt: NOW + 30_000 }));
		expect(await credential.bearer()).toBe("access-1");
		expect(store.read()).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
		expect(server.state.refreshes).toBe(1);
	});

	it("two renewals at once make ONE refresh: the second finds the first's and uses it", async () => {
		const near = session({ expiresAt: NOW + 30_000 });
		const { credential: one, server, store } = signedIn(near);
		const two = new SignInCredential(PLATFORM, store, near, server.fetchFn, () => NOW);
		const bearers = await Promise.all([one.bearer(), two.bearer()]);
		expect(server.state.refreshes).toBe(1);
		expect(bearers).toEqual(["access-1", "access-1"]);
	});

	it("a refresh token the server refuses ends the sign-in here: removed, and said so", async () => {
		const { credential, store } = signedIn(
			session(),
			fakeSignInServer({ refresh: "invalid_grant" }),
		);
		const error = await credential.renew().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SignInEndedError);
		expect(String(error)).toContain("ax login");
		expect(store.read()).toBeNull();
	});

	it("a refresh that cannot reach the server keeps the sign-in: an outage is not an ending", async () => {
		const { credential, store } = signedIn(session(), fakeSignInServer({ refresh: "down" }));
		await expect(credential.renew()).rejects.toThrow("fetch failed");
		expect(store.read()).toEqual(session());
	});

	it("a 503 whose body names invalid_grant keeps the sign-in: only an OAuth answer ends one", async () => {
		const server = fakeSignInServer();
		const busy: typeof fetch = async (input, init) => {
			const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
			if (form.get("grant_type") === "refresh_token") {
				return Response.json({ error: "invalid_grant" }, { status: 503 });
			}
			return server.fetchFn(input, init);
		};
		const store = freshStore();
		store.write(session());
		const credential = new SignInCredential(PLATFORM, store, session(), busy, () => NOW);
		const error = await credential.renew().catch((e: unknown) => e);
		expect(error).not.toBeInstanceOf(SignInEndedError);
		expect(String(error)).toContain("account.ora.test answered HTTP 503");
		expect(store.read()).toEqual(session());
	});

	it("signed out on this machine meanwhile: the renewal says so and stores nothing", async () => {
		const server = fakeSignInServer();
		const credential = new SignInCredential(PLATFORM, freshStore(), session(), server.fetchFn);
		await expect(credential.renew()).rejects.toBeInstanceOf(SignInEndedError);
		expect(server.state.refreshes).toBe(0);
	});
});

/** As signedIn, with the refresh held at the sign-in server until the test lets it answer. */
function signedInWithHeldRefresh(stored: StoredSignIn) {
	const server = fakeSignInServer();
	const sent = deferred();
	const answer = deferred();
	const held: typeof fetch = async (input, init) => {
		const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
		if (form.get("grant_type") === "refresh_token") {
			sent.resolve();
			await answer.promise;
		}
		return server.fetchFn(input, init);
	};
	const store = freshStore();
	store.write(stored);
	const credential = new SignInCredential(PLATFORM, store, stored, held, () => NOW);
	return { store, server, credential, sent: sent.promise, answer: answer.resolve };
}

describe("a renewal whose file changed while its refresh was out", () => {
	// Under the lock nothing else changes the file. These are what happens when a renewal outlived
	// the lock's stale window (a machine that slept mid-request) and another ax broke the lock: the
	// test changes the file directly, with no lock, while the refresh is out.

	it("removed meanwhile (ax logout): it stays removed, and the renewal says you signed out", async () => {
		const { store, server, credential, sent, answer } = signedInWithHeldRefresh(session());
		const renewing = credential.renew();
		await sent;
		store.clear();
		answer();
		const error = await renewing.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SignInEndedError);
		expect(String(error)).toContain("You signed out of ax on this machine");
		expect(store.present()).toBe(false);
		expect(server.state.refreshes).toBe(1);
		// The renewal no file holds is ended on the server, not left live.
		expect(server.state.revoked).toEqual(["refresh-1"]);
	});

	it("a newer sign-in stored meanwhile (ax login): the renewal uses it and leaves it stored", async () => {
		const { store, server, credential, sent, answer } = signedInWithHeldRefresh(session());
		const newer = session({ accessToken: "access-new", refreshToken: "refresh-new" });
		const renewing = credential.renew();
		await sent;
		store.write(newer);
		answer();
		expect(await renewing).toBe("access-new");
		expect(store.read()).toEqual(newer);
		// The renewal it set aside is ended on the server; the newer sign-in is untouched.
		expect(server.state.revoked).toEqual(["refresh-1"]);
	});
});

describe("a sign-in's identity", () => {
	it("is asked of the platform with the access token", async () => {
		const { credential, server } = signedIn(session());
		expect(await credential.readIdentity()).toMatchObject({ organizationId: "org-1" });
		expect(server.state.identityCalls).toEqual(["Bearer access-0"]);
	});

	it("an access token ora refuses is renewed once, then asked again", async () => {
		const { credential, server } = signedIn(session({ accessToken: "access-expired" }));
		expect(await credential.readIdentity()).toMatchObject({ organizationId: "org-1" });
		expect(server.state.identityCalls).toEqual(["Bearer access-expired", "Bearer access-1"]);
	});

	it("refused again after renewing, the sign-in has ended: ax login is the way on", async () => {
		const server = fakeSignInServer();
		const store = freshStore();
		store.write(session());
		// The sign-in server still renews it, but the platform refuses every token it hands out.
		const refusing: typeof fetch = async (input, init) =>
			String(input).endsWith("/auth/identity")
				? Response.json({ code: "INVALID_CREDENTIAL" }, { status: 401 })
				: server.fetchFn(input, init);
		const credential = new SignInCredential(PLATFORM, store, session(), refusing, () => NOW);
		const error = await credential.readIdentity().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SignInEndedError);
		expect(String(error)).toContain("ora refused it (401)");
		expect(String(error)).toContain("Run ax login");
		expect(server.state.refreshes).toBe(1);
	});
});

describe("a sign-in, as a person reads it", () => {
	it("is named for ax login, and a rejection of it is a SignInEndedError that says ax login", () => {
		const { credential } = signedIn(session());
		expect(credential.label).toBe("ax login (browser sign-in)");
		const ended = credential.rejected("ora closed the tunnel (4401)");
		expect(ended).toBeInstanceOf(SignInEndedError);
		expect(ended.message).toBe(
			"ora closed the tunnel (4401): your sign-in no longer works. Run ax login.",
		);
		expect(credential.refusal.forbidden("tunnels:write + tunnels:connect")).toContain(
			"a viewer cannot grant",
		);
	});
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
