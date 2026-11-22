import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUEST_TIMEOUT_MS } from "./oauth";
import { configDir, SessionStore, SIGN_IN_LOCK_TIMING, type StoredSignIn } from "./session-store";

// The one file ax writes: where it lives, who can read it, and the lock that keeps two ax
// commands from spending the same refresh token.

const SESSION: StoredSignIn = {
	version: 1,
	issuer: "https://account.ora.test",
	clientId: "ax-cli",
	resource: "https://api.ora.test",
	tokenEndpoint: "https://account.ora.test/oauth2/token",
	revocationEndpoint: "https://account.ora.test/oauth2/revoke",
	accessToken: "access-1",
	refreshToken: "refresh-1",
	expiresAt: 1_000_000,
	scope: "runs:read",
};

const freshStore = () => new SessionStore(join(mkdtempSync(join(tmpdir(), "ax-store-")), "ax"));
const posix = process.platform !== "win32";

describe("where the sign-in is kept", () => {
	it("is $XDG_CONFIG_HOME/ax when it is set", () => {
		expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/me")).toBe(join("/x", "ax"));
	});

	it("is %APPDATA%\\ax on Windows", () => {
		expect(configDir({ APPDATA: "C:\\Users\\me\\AppData" }, "win32", "C:\\Users\\me")).toBe(
			join("C:\\Users\\me\\AppData", "ax"),
		);
	});

	it("is ~/.config/ax otherwise", () => {
		expect(configDir({}, "darwin", "/Users/me")).toBe(join("/Users/me", ".config", "ax"));
	});
});

describe("the stored sign-in", () => {
	it("reads back what was written", () => {
		const store = freshStore();
		store.write(SESSION);
		expect(store.read()).toEqual(SESSION);
	});

	it.runIf(posix)("only your own account can read it: the file is 0600 in a 0700 directory", () => {
		const store = freshStore();
		store.write(SESSION);
		expect(statSync(store.file).mode & 0o777).toBe(0o600);
		expect(statSync(store.dir).mode & 0o777).toBe(0o700);
	});

	it("is nothing when the file is missing, is not JSON, or is not a sign-in", () => {
		const store = freshStore();
		expect(store.read()).toBeNull();
		store.write(SESSION);
		writeFileSync(store.file, "{ half a file");
		expect(store.read()).toBeNull();
		writeFileSync(store.file, JSON.stringify({ ...SESSION, refreshToken: "" }));
		expect(store.read()).toBeNull();
	});

	it("leaves no temporary file behind", () => {
		const store = freshStore();
		store.write(SESSION);
		store.write({ ...SESSION, accessToken: "access-2" });
		expect(JSON.parse(readFileSync(store.file, "utf8")).accessToken).toBe("access-2");
		expect(() => statSync(`${store.file}.${process.pid}.tmp`)).toThrow();
	});

	it("clear removes it, and clearing twice is fine", () => {
		const store = freshStore();
		store.write(SESSION);
		store.clear();
		store.clear();
		expect(store.read()).toBeNull();
	});
});

describe("whether a sign-in file is there", () => {
	it("is not, before anything was written", () => {
		expect(freshStore().present()).toBe(false);
	});

	it("is, for a file this ax cannot read: a newer ax's, or one cut short", () => {
		const store = freshStore();
		store.write(SESSION);
		writeFileSync(store.file, JSON.stringify({ ...SESSION, version: 2 }));
		expect(store.read()).toBeNull();
		expect(store.present()).toBe(true);
		writeFileSync(store.file, JSON.stringify(SESSION).slice(0, 40));
		expect(store.read()).toBeNull();
		expect(store.present()).toBe(true);
	});

	it("is not, once it was cleared", () => {
		const store = freshStore();
		store.write(SESSION);
		expect(store.present()).toBe(true);
		store.clear();
		expect(store.present()).toBe(false);
	});
});

describe("the sign-in's lock", () => {
	const lockOf = (store: SessionStore) => join(store.dir, "session.lock");

	it("runs one holder at a time", async () => {
		const store = freshStore();
		const order: string[] = [];
		const holder = (name: string) =>
			store.withLock(async () => {
				order.push(`${name} in`);
				await new Promise((resolve) => setTimeout(resolve, 30));
				order.push(`${name} out`);
			});
		await Promise.all([holder("a"), holder("b")]);
		expect(order).toEqual(["a in", "a out", "b in", "b out"]);
	});

	it("waits while another ax holds it, then takes it", async () => {
		const store = freshStore();
		store.write(SESSION);
		writeFileSync(lockOf(store), "");
		let ran = false;
		const waiting = store.withLock(async () => {
			ran = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(ran).toBe(false);
		rmSync(lockOf(store));
		await waiting;
		expect(ran).toBe(true);
	});

	it("breaks a lock left by an ax that died", async () => {
		const store = freshStore();
		store.write(SESSION);
		writeFileSync(lockOf(store), "");
		const minuteAgo = new Date(Date.now() - 60_000);
		utimesSync(lockOf(store), minuteAgo, minuteAgo);
		expect(await store.withLock(async () => "ran")).toBe("ran");
	});

	it("is released when the holder fails", async () => {
		const store = freshStore();
		await expect(
			store.withLock(async () => {
				throw new Error("refresh failed");
			}),
		).rejects.toThrow("refresh failed");
		expect(() => statSync(lockOf(store))).toThrow();
		expect(await store.withLock(async () => "next")).toBe("next");
	});

	it("a holder whose stale lock was broken leaves its successor's lock alone", async () => {
		// Three ax commands on one machine: the first stalls past the stale window (a laptop lid
		// closed mid-refresh), the second breaks its lock and takes one of its own, then the first
		// finishes. The third must still wait for the second.
		const first = freshStore();
		const second = new SessionStore(first.dir);
		const third = new SessionStore(first.dir);
		const firstGate = deferred();
		const secondGate = deferred();
		const secondIn = deferred();
		const firstDone = first.withLock(() => firstGate.promise);
		const minuteAgo = new Date(Date.now() - 60_000);
		utimesSync(lockOf(first), minuteAgo, minuteAgo);
		const secondDone = second.withLock(async () => {
			secondIn.resolve();
			await secondGate.promise;
		});
		await secondIn.promise;

		firstGate.resolve();
		await firstDone;
		expect(() => statSync(lockOf(first))).not.toThrow();

		let thirdRan = false;
		const thirdDone = third.withLock(async () => {
			thirdRan = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(thirdRan).toBe(false);
		secondGate.resolve();
		await Promise.all([secondDone, thirdDone]);
		expect(thirdRan).toBe(true);
	});

	it("breaks a dead holder's lock only after every request a live one makes could have ended", () => {
		// The window is derived from the request deadline; this fails if either moves on its own.
		expect(SIGN_IN_LOCK_TIMING.staleMs).toBeGreaterThan(REQUEST_TIMEOUT_MS);
		expect(SIGN_IN_LOCK_TIMING.waitMs).toBeGreaterThan(SIGN_IN_LOCK_TIMING.staleMs);
	});
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
