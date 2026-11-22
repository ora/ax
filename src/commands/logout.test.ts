import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSignInServer, ISSUER, PLATFORM } from "../auth/fake-sign-in-server.test-support";
import { platformCredentials } from "../auth/resolve-credential";
import { SessionStore, type StoredSignIn } from "../auth/session-store";
import { type LogoutDeps, logoutCommand } from "./logout";

// `ax logout` against a stand-in for ora's sign-in server: what it removes from this machine, in
// which order, under which lock, and what it says. Each case changes one thing.

let errors: string[];
let printed: string[];
let stdout: string[];

beforeEach(() => {
	vi.stubEnv("ORA_PLATFORM_URL", PLATFORM);
	vi.stubEnv("ORA_API_KEY", "");
	errors = [];
	printed = [];
	stdout = [];
	vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
	vi.spyOn(console, "log").mockImplementation((line: unknown) => void printed.push(String(line)));
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		stdout.push(String(chunk));
		return true;
	});
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

const REVOKE = `${ISSUER}/oauth2/revoke`;

/** A machine with nothing stored (ax's folder not created yet), and the stand-in server. */
function machine(store = new SessionStore(join(mkdtempSync(join(tmpdir(), "ax-logout-")), "ax"))) {
	const server = fakeSignInServer();
	const deps: LogoutDeps = {
		fetchFn: server.fetchFn,
		credentials: platformCredentials({ store, fetchFn: server.fetchFn }),
	};
	return { server, store, deps };
}

function signedIn() {
	const signed = machine();
	signed.store.write(SIGN_IN);
	return signed;
}

/** Files this ax cannot read, by what happened to them. */
const UNREADABLE = [
	["written by a newer ax (version 2)", JSON.stringify({ ...SIGN_IN, version: 2 })],
	["cut short", JSON.stringify(SIGN_IN).slice(0, 60)],
] as const;

function holdingUnreadable(content: string) {
	const held = signedIn();
	writeFileSync(held.store.file, content);
	return held;
}

/** A store whose lock another ax kept past the wait: taking it fails as the lock's own does. */
class KeptLockStore extends SessionStore {
	override withLock<T>(): Promise<T> {
		return Promise.reject(
			new Error(`another ax command is holding the lock at ${join(this.dir, "session.lock")}`),
		);
	}
}

describe("ax logout, signed in", () => {
	it("removes the file before it asks ora to end the sign-in", async () => {
		const { deps, store, server } = signedIn();
		const storedAtRevocation: boolean[] = [];
		deps.fetchFn = async (input, init) => {
			if (String(input) === REVOKE) storedAtRevocation.push(store.present());
			return server.fetchFn(input, init);
		};
		expect(await logoutCommand({ json: false }, deps)).toBe(0);
		expect(storedAtRevocation).toEqual([false]);
		expect(server.state.revoked).toEqual(["refresh-0"]);
	});

	it("a revocation that gets no answer still signs out here, and says to disconnect it in ora", async () => {
		const { deps, store, server } = signedIn();
		deps.fetchFn = async (input, init) => {
			if (String(input) === REVOKE) {
				throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
			}
			return server.fetchFn(input, init);
		};
		expect(await logoutCommand({ json: false }, deps)).toBe(0);
		expect(store.present()).toBe(false);
		expect(printed.join("\n")).toContain(`Signed out of ${PLATFORM}.`);
		expect(errors.join("\n")).toContain(
			"ora could not be reached to end the sign-in there: disconnect it in ora, Settings, Connected apps.",
		);
	});

	it("waits while another ax holds the sign-in's lock, then removes the file", async () => {
		const { deps, store, server } = signedIn();
		const release = deferred();
		const holding = new SessionStore(store.dir).withLock(() => release.promise);
		let finished = false;
		const loggingOut = logoutCommand({ json: false }, deps).finally(() => {
			finished = true;
		});
		await turns();
		expect(finished).toBe(false);
		expect(store.read()).toEqual(SIGN_IN);
		release.resolve();
		await holding;
		expect(await loggingOut).toBe(0);
		expect(store.present()).toBe(false);
		expect(server.state.revoked).toEqual(["refresh-0"]);
	});
});

describe("ax logout, with a file this ax cannot read", () => {
	it.each(UNREADABLE)(
		"removes a file %s too, says so (exit 0), and asks ora nothing",
		async (_, content) => {
			const { deps, store, server } = holdingUnreadable(content);
			expect(await logoutCommand({ json: false }, deps)).toBe(0);
			expect(store.present()).toBe(false);
			expect(printed.join("\n")).toContain(
				"Removed the stored sign-in, which this version of ax could not read.",
			);
			expect(errors.join("\n")).toContain(
				"If it was still in use, disconnect it in ora, Settings, Connected apps.",
			);
			expect(server.calls).not.toHaveBeenCalled();
		},
	);

	it.each(UNREADABLE)(
		"--json, for a file %s: signed out, not ended on the server, unreadable",
		async (_, content) => {
			const { deps, store, server } = holdingUnreadable(content);
			expect(await logoutCommand({ json: true }, deps)).toBe(0);
			expect(JSON.parse(stdout.join(""))).toEqual({
				signedOut: true,
				endedOnServer: false,
				unreadable: true,
			});
			expect(store.present()).toBe(false);
			expect(server.calls).not.toHaveBeenCalled();
		},
	);
});

describe("ax logout, with nothing stored", () => {
	it("says so (exit 0), asks ora nothing, and creates no folder for ax", async () => {
		const { deps, store, server } = machine();
		expect(await logoutCommand({ json: false }, deps)).toBe(0);
		expect(printed.join("\n")).toContain("Not signed in to ax on this machine.");
		expect(existsSync(store.dir)).toBe(false);
		expect(server.calls).not.toHaveBeenCalled();
	});
});

describe("ax logout, when the sign-in cannot be removed", () => {
	it("another ax kept the lock past the wait: SIGN_OUT_FAILED (exit 3), nothing removed or ended", async () => {
		const store = new KeptLockStore(mkdtempSync(join(tmpdir(), "ax-logout-")));
		store.write(SIGN_IN);
		const { deps, server } = machine(store);
		expect(await logoutCommand({ json: true }, deps)).toBe(3);
		expect(JSON.parse(stdout.join("")).error.code).toBe("SIGN_OUT_FAILED");
		expect(errors.join("\n")).toContain("another ax command is holding the lock");
		expect(store.read()).toEqual(SIGN_IN);
		expect(server.calls).not.toHaveBeenCalled();
	});

	it("the file will not go (a folder in its place): SIGN_OUT_FAILED (exit 3), the lock given back", async () => {
		const { deps, store, server } = machine();
		mkdirSync(store.file, { recursive: true });
		expect(await logoutCommand({ json: true }, deps)).toBe(3);
		expect(JSON.parse(stdout.join("")).error.code).toBe("SIGN_OUT_FAILED");
		expect(existsSync(join(store.dir, "session.lock"))).toBe(false);
		expect(server.calls).not.toHaveBeenCalled();
	});
});

/** A few turns of the event loop: enough for a command that is not waiting to have finished. */
async function turns(count = 10): Promise<void> {
	for (let turn = 0; turn < count; turn += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
