import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSignInServer, ISSUER, PLATFORM } from "../auth/fake-sign-in-server.test-support";
import { platformCredentials } from "../auth/resolve-credential";
import { SessionStore } from "../auth/session-store";
import { type LoginDeps, loginCommand } from "./login";
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
