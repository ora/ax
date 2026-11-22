import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSignInServer, ISSUER, PLATFORM } from "../auth/fake-sign-in-server.test-support";
import { DEVICE_CODE_GRANT } from "../auth/oauth";
import { platformCredentials } from "../auth/resolve-credential";
import { SessionStore } from "../auth/session-store";
import { type LoginDeps, loginCommand } from "./login";
import { nextWait } from "./login-wait";
import { logoutCommand } from "./logout";
import { whoamiCommand } from "./whoami";

// ax login, whoami and logout against a stand-in for ora's sign-in server, with the clock and the
// wait between polls handed in (no test waits). Each case changes one answer of the server.

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

function harness(overrides: Parameters<typeof fakeSignInServer>[0] = {}) {
	const server = fakeSignInServer(overrides);
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "ax-login-")));
	let clock = 1_000_000;
	const opened: string[] = [];
	const deps: LoginDeps = {
		fetchFn: server.fetchFn,
		credentials: platformCredentials({ store, fetchFn: server.fetchFn }),
		openBrowser: (url) => {
			opened.push(url);
			return true;
		},
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
		interactive: true,
	};
	return { server, store, deps, opened };
}

const all = () => [...errors, ...printed, ...stdout].join("\n");

/** The waits between polls, in ms, as `ax login` asks for them. */
function recordWaits(deps: LoginDeps): number[] {
	const waits: number[] = [];
	const sleep = deps.sleep;
	deps.sleep = (ms) => {
		waits.push(ms);
		return sleep(ms);
	};
	return waits;
}

/** How many device polls the server received. */
const pollsReceived = (server: ReturnType<typeof fakeSignInServer>): number =>
	server.forms.filter(({ form }) => form.get("grant_type") === DEVICE_CODE_GRANT).length;

/** A store whose folder is a file: neither its lock nor a sign-in can be written there. */
function unwritableStore(): SessionStore {
	const notAFolder = join(mkdtempSync(join(tmpdir(), "ax-login-")), "ax");
	writeFileSync(notAFolder, "");
	return new SessionStore(notAFolder);
}

describe("ax login", () => {
	it("shows the link and the code, opens the browser, waits for the approval and stores the sign-in", async () => {
		const { deps, store, opened, server } = harness({ polls: ["pending", "pending", "approve"] });
		expect(await loginCommand({ json: false, noBrowser: false }, deps)).toBe(0);
		expect(errors.join("\n")).toContain(`${ISSUER}/device?user_code=ABCD-EFGH`);
		expect(errors.join("\n")).toContain("ABCD-EFGH");
		expect(errors.join("\n")).toContain("Approve only a sign-in you started yourself.");
		expect(opened).toEqual([`${ISSUER}/device?user_code=ABCD-EFGH`]);
		expect(store.read()).toMatchObject({
			clientId: "ax-cli",
			resource: PLATFORM,
			accessToken: "access-1",
			refreshToken: "refresh-1",
		});
		// Then it says who signed in, asked of the platform with the new token.
		expect(server.state.identityCalls).toEqual(["Bearer access-1"]);
		expect(printed.join("\n")).toContain("member@acme.test (developer)");
		expect(printed.join("\n")).toContain("Acme (org-1)");
	});

	it("with --no-browser, opens nothing", async () => {
		const { deps, opened } = harness();
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(0);
		expect(opened).toEqual([]);
	});

	it("waits longer when the server asks it to slow down", async () => {
		const { deps } = harness({ polls: ["slow_down", "approve"] });
		const waits: number[] = [];
		const sleep = deps.sleep;
		deps.sleep = (ms) => {
			waits.push(ms);
			return sleep(ms);
		};
		await loginCommand({ json: false, noBrowser: true }, deps);
		expect(waits).toEqual([5000, 10000]);
	});

	it.each([
		["denied", "SIGN_IN_CANCELLED", "cancelled in the browser"],
		["expired", "SIGN_IN_EXPIRED", "expired"],
	] as const)(
		"a %s code fails the sign-in (exit 3) and stores nothing",
		async (answer, code, words) => {
			const { deps, store } = harness({ polls: [answer] });
			expect(await loginCommand({ json: true, noBrowser: true }, deps)).toBe(3);
			expect(errors.join("\n")).toContain(words);
			expect(JSON.parse(stdout.join("")).error.code).toBe(code);
			expect(store.read()).toBeNull();
		},
	);

	it("a code nobody approves in time expires (exit 3)", async () => {
		const { deps } = harness({ polls: ["pending"] });
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(3);
		expect(errors.join("\n")).toContain("The code expired before it was approved.");
	});

	it("an ora without browser sign-in points at ORA_API_KEY (exit 3)", async () => {
		const { deps } = harness({ discovery: "missing" });
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(3);
		expect(errors.join("\n")).toContain("does not offer browser sign-in");
		expect(errors.join("\n")).toContain("ORA_API_KEY");
	});

	it("an ora that does not know ax yet says so (exit 3)", async () => {
		const { deps } = harness({ start: "invalid_client" });
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(3);
		expect(errors.join("\n")).toContain("does not know ax as a sign-in client yet");
	});

	it("a platform address that is not api.<domain> is refused before any request (exit 2)", async () => {
		vi.stubEnv("ORA_PLATFORM_URL", "https://platform.example.test");
		const { deps, server } = harness();
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(2);
		expect(server.calls).not.toHaveBeenCalled();
	});

	it("the older api.agentfront.sh is pointed at api.ora.ai before any request (exit 2)", async () => {
		vi.stubEnv("ORA_PLATFORM_URL", "https://api.agentfront.sh/");
		const { deps, server } = harness();
		expect(await loginCommand({ json: true, noBrowser: true }, deps)).toBe(2);
		const { error } = JSON.parse(stdout.join(""));
		expect(error.code).toBe("SIGN_IN_UNAVAILABLE");
		expect(error.message).toContain("set it to https://api.ora.ai");
		expect(server.calls).not.toHaveBeenCalled();
	});

	it("a plain-http platform address off this machine is refused before any request (exit 2)", async () => {
		vi.stubEnv("ORA_PLATFORM_URL", "http://api.ora.test");
		const { deps, server } = harness();
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(2);
		expect(errors.join("\n")).toContain("a sign-in only over https");
		expect(server.calls).not.toHaveBeenCalled();
	});

	it("replacing a sign-in on this machine ends the old one on the server", async () => {
		const { deps, store, server } = harness();
		await loginCommand({ json: false, noBrowser: true }, deps);
		await loginCommand({ json: false, noBrowser: true }, deps);
		expect(server.state.revoked).toEqual(["refresh-1"]);
		expect(store.read()?.refreshToken).toBe("refresh-2");
	});

	it("warns that ORA_API_KEY is used before the sign-in when it is set", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_env");
		const { deps } = harness();
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(0);
		expect(errors.join("\n")).toContain(
			"ORA_API_KEY (a platform key) is set here, and ax uses it before your sign-in",
		);
	});

	it("says nothing of a key when none is set: the sign-in is what ax uses", async () => {
		const { deps } = harness();
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(0);
		expect(errors.join("\n")).not.toContain("before your sign-in");
	});

	it("--json puts one document on stdout and the code on stderr", async () => {
		const { deps } = harness();
		expect(await loginCommand({ json: true, noBrowser: true }, deps)).toBe(0);
		const document = JSON.parse(stdout.join(""));
		expect(document).toMatchObject({
			signedIn: true,
			platform: PLATFORM,
			identity: { organizationId: "org-1" },
		});
		expect(stdout.join("")).not.toContain("ABCD-EFGH");
	});

	it("a slow_down raises the interval for good: every later poll waits the longer one", async () => {
		const { deps } = harness({ polls: ["slow_down", "pending", "approve"] });
		const waits = recordWaits(deps);
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(0);
		expect(waits).toEqual([5000, 10000, 10000]);
	});

	it.each(["drop", "unavailable", "rate_limited"] as const)(
		"a poll the server answers %s once is waited out, and the sign-in is stored (exit 0)",
		async (answer) => {
			const { deps, store } = harness({ polls: [answer, "approve"] });
			expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(0);
			expect(store.read()).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
		},
	);

	it("backs off while the server keeps failing: twice the wait each time, at most a minute", async () => {
		const { deps } = harness({
			polls: ["unavailable", "unavailable", "unavailable", "unavailable", "approve"],
		});
		const waits = recordWaits(deps);
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(0);
		expect(waits).toEqual([5000, 10000, 20000, 40000, 60000]);
	});

	it("an answer between failures starts the back-off and the count over: only failures in a row add up", async () => {
		const four = ["unavailable", "unavailable", "unavailable", "unavailable"] as const;
		const { deps, store } = harness({ polls: [...four, "pending", ...four, "approve"] });
		const waits = recordWaits(deps);
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(0);
		const backOff = [5000, 10000, 20000, 40000, 60000];
		expect(waits).toEqual([...backOff, ...backOff]);
		expect(store.read()?.refreshToken).toBe("refresh-1");
	});

	it("backs off to at most a minute, but never below the server's own interval when that is longer", () => {
		expect([0, 1, 2, 3, 4, 5].map((failures) => nextWait(5, failures))).toEqual([
			5, 10, 20, 40, 60, 60,
		]);
		expect([0, 1, 2].map((failures) => nextWait(90, failures))).toEqual([90, 90, 90]);
	});

	it("five transient failures in a row give up (exit 3), store nothing, and say why once", async () => {
		const { deps, store, server } = harness({ polls: ["unavailable"] });
		const waits = recordWaits(deps);
		expect(await loginCommand({ json: true, noBrowser: true }, deps)).toBe(3);
		const { error } = JSON.parse(stdout.join(""));
		expect(error.code).toBe("SIGN_IN_FAILED");
		expect(error.message).toBe(
			"The sign-in did not complete: account.ora.test answered HTTP 502, 5 times in a row.",
		);
		expect(all()).not.toContain("did not complete: the sign-in did not complete");
		expect(store.read()).toBeNull();
		expect(pollsReceived(server)).toBe(5);
		expect(waits).toEqual([5000, 10000, 20000, 40000, 60000]);
	});

	it.each([
		["discovery", { discovery: "down" }],
		["the device start", { start: "down" }],
	] as const)(
		"%s answering 503 is a sign-in that could not start, to try again in a moment (exit 3)",
		async (_step, overrides) => {
			const { deps, store } = harness(overrides);
			expect(await loginCommand({ json: true, noBrowser: true }, deps)).toBe(3);
			const { error } = JSON.parse(stdout.join(""));
			expect(error.code).toBe("SIGN_IN_FAILED");
			expect(error.message).toBe(
				"The sign-in could not start: account.ora.test answered HTTP 503. Try again in a moment.",
			);
			expect(all()).not.toContain("does not offer");
			expect(store.read()).toBeNull();
		},
	);

	it("a sign-in it cannot store is ended on the server, and fails (exit 3)", async () => {
		const { deps, server } = harness();
		const store = unwritableStore();
		deps.credentials = platformCredentials({ store, fetchFn: server.fetchFn });
		expect(await loginCommand({ json: true, noBrowser: true }, deps)).toBe(3);
		const { error } = JSON.parse(stdout.join(""));
		expect(error.code).toBe("SIGN_IN_NOT_SAVED");
		expect(error.message).toMatch(/^ax could not save the sign-in: /);
		expect(server.state.revoked).toEqual(["refresh-1"]);
		expect(store.read()).toBeNull();
		expect(server.state.identityCalls).toEqual([]);
	});
});

describe("ax whoami and ax logout", () => {
	async function signedIn() {
		const h = harness();
		await loginCommand({ json: false, noBrowser: true }, h.deps);
		errors.length = 0;
		printed.length = 0;
		stdout.length = 0;
		return h;
	}

	it("whoami names the sign-in, the organization and the person", async () => {
		const { deps } = await signedIn();
		expect(await whoamiCommand({ json: false }, deps)).toBe(0);
		expect(printed.join("\n")).toContain("ax login (browser sign-in)");
		expect(printed.join("\n")).toContain("Acme (org-1)");
	});

	it("whoami with neither a sign-in nor a key says both ways in (exit 2)", async () => {
		const { deps } = harness();
		expect(await whoamiCommand({ json: false }, deps)).toBe(2);
		expect(all()).toMatch(/ax login.*ORA_API_KEY/s);
	});

	it("whoami after the sign-in ended elsewhere: renewed once, refused, removed, and says ax login (exit 3)", async () => {
		const { deps, store, server } = await signedIn();
		const session = store.read();
		if (!session) throw new Error("ax login stored no sign-in");
		store.write({ ...session, accessToken: "access-expired" });
		server.state.refresh = "invalid_grant";
		expect(await whoamiCommand({ json: false }, deps)).toBe(3);
		expect(errors.join("\n")).toContain("ax login");
		expect(store.read()).toBeNull();
	});

	it("logout ends the sign-in on the server and removes it here", async () => {
		const { deps, store, server } = await signedIn();
		expect(await logoutCommand({ json: false }, deps)).toBe(0);
		expect(server.state.revoked).toEqual(["refresh-1"]);
		expect(store.read()).toBeNull();
		expect(printed.join("\n")).toContain(`Signed out of ${PLATFORM}.`);
	});

	it("whoami with a platform key asks /auth/identity with the key itself, never trading it", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_env");
		const { deps, server } = harness();
		expect(await whoamiCommand({ json: true }, deps)).toBe(0);
		expect(server.state.identityCalls).toEqual(["Bearer ora_sk_env"]);
		expect(JSON.parse(stdout.join(""))).toMatchObject({
			credential: "api_key",
			identity: { organizationId: "org-1" },
		});
	});

	it("whoami names the platform key it read", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_env");
		const { deps } = harness();
		expect(await whoamiCommand({ json: false }, deps)).toBe(0);
		expect(printed.join("\n")).toContain("ORA_API_KEY (a platform key)");
	});

	it("logout says the key ax keeps using, when one is set", async () => {
		const { deps } = await signedIn();
		vi.stubEnv("ORA_API_KEY", "ora_sk_env");
		expect(await logoutCommand({ json: false }, deps)).toBe(0);
		expect(errors.join("\n")).toContain("ORA_API_KEY (a platform key) is still set here");
	});

	it("logout with nothing stored is a no-op that says so", async () => {
		const { deps, server } = harness();
		expect(await logoutCommand({ json: false }, deps)).toBe(0);
		expect(printed.join("\n")).toContain("Not signed in");
		expect(server.calls).not.toHaveBeenCalled();
	});
});

describe("no token in any output", () => {
	let out: string[];

	beforeEach(() => {
		out = [];
		const keep = (...args: unknown[]) => void out.push(args.map(String).join(" "));
		for (const method of ["log", "error", "warn", "info", "debug"] as const) {
			vi.spyOn(console, method).mockImplementation(keep);
		}
		const write = (chunk: unknown) => {
			out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
			return true;
		};
		vi.spyOn(process.stdout, "write").mockImplementation(write);
		vi.spyOn(process.stderr, "write").mockImplementation(write);
	});

	/** Moves the stored sign-in's expiry to `ms` from now (a sign-in renews within a minute of it). */
	function expireIn(store: SessionStore, ms: number): void {
		const session = store.read();
		if (!session) throw new Error("ax login stored no sign-in");
		store.write({ ...session, expiresAt: Date.now() + ms });
	}

	/** The device code and every token the servers issued, those that appear in any output. */
	function leaked(...servers: Array<ReturnType<typeof fakeSignInServer>>): string[] {
		const issued = servers.flatMap(({ state }) =>
			Array.from({ length: state.issued }, (_, i) => [`access-${i + 1}`, `refresh-${i + 1}`]),
		);
		const text = out.join("\n");
		return ["device-1", ...issued.flat()].filter((secret) => text.includes(secret));
	}

	it("ax login, ax whoami (renewing a sign-in about to expire) and ax logout print none", async () => {
		const { deps, store, server } = harness();
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(0);
		expect(await loginCommand({ json: true, noBrowser: true }, deps)).toBe(0);
		expireIn(store, 10 * 60_000);
		expect(await whoamiCommand({ json: false }, deps)).toBe(0);
		expect(await whoamiCommand({ json: true }, deps)).toBe(0);
		expireIn(store, 30_000);
		expect(await whoamiCommand({ json: false }, deps)).toBe(0);
		expireIn(store, 30_000);
		expect(await whoamiCommand({ json: true }, deps)).toBe(0);
		expect(await logoutCommand({ json: false }, deps)).toBe(0);
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(0);
		expect(await logoutCommand({ json: true }, deps)).toBe(0);

		// Each command ran and was heard, and the sign-in about to expire was renewed both times.
		expect(server.state.issued).toBe(5);
		expect(server.state.refreshes).toBe(2);
		expect(server.state.identityCalls).toEqual(
			expect.arrayContaining(["Bearer access-3", "Bearer access-4"]),
		);
		const text = out.join("\n");
		for (const shown of [
			"ABCD-EFGH",
			"Signed in to ora.",
			'"signedIn": true',
			"member@acme.test",
			'"credential": "sign_in"',
			`Signed out of ${PLATFORM}.`,
			'"signedOut":true',
		]) {
			expect(text).toContain(shown);
		}
		expect(leaked(server)).toEqual([]);
	});

	it("nor does a renewal that fails, a refused code, or a sign-in ax could not store", async () => {
		const { deps, store, server } = harness();
		expect(await loginCommand({ json: false, noBrowser: true }, deps)).toBe(0);
		expireIn(store, 30_000);
		server.state.refresh = "unavailable";
		expect(await whoamiCommand({ json: false }, deps)).toBe(3);
		server.state.refresh = "unreachable";
		expect(await whoamiCommand({ json: true }, deps)).toBe(3);
		server.state.refresh = "invalid_grant";
		expect(await whoamiCommand({ json: false }, deps)).toBe(3);
		const denied = harness({ polls: ["denied"] });
		expect(await loginCommand({ json: true, noBrowser: true }, denied.deps)).toBe(3);
		const unsaved = harness();
		unsaved.deps.credentials = platformCredentials({
			store: unwritableStore(),
			fetchFn: unsaved.server.fetchFn,
		});
		expect(await loginCommand({ json: false, noBrowser: true }, unsaved.deps)).toBe(3);

		expect(server.state.refreshes).toBe(3);
		expect(unsaved.server.state.revoked).toEqual(["refresh-1"]);
		const text = out.join("\n");
		for (const shown of [
			"the sign-in could not be renewed: account.ora.test answered HTTP 503",
			"the sign-in could not be renewed: could not reach account.ora.test (ECONNREFUSED)",
			"Your ax sign-in no longer works",
			"cancelled in the browser",
			"ax could not save the sign-in",
		]) {
			expect(text).toContain(shown);
		}
		expect(leaked(server, denied.server, unsaved.server)).toEqual([]);
	});
});
