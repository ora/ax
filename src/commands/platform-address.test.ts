import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSignInServer, ISSUER, PLATFORM } from "../auth/fake-sign-in-server.test-support";
import { platformCredentials } from "../auth/resolve-credential";
import { SessionStore } from "../auth/session-store";
import { auditCommand } from "./audit";
import { EXIT } from "./exit-codes";
import { journeyCommand } from "./journey";
import { whoamiCommand } from "./whoami";

// ORA_PLATFORM_URL without its scheme (`api.ora.test`), a sign-in stored for https://api.ora.test
// and no key: every command that needs a credential says the address is the thing to fix
// (KEY_DESTINATION_REFUSED), before any request, and never surfaces a raw "Invalid URL" TypeError.

let errors: string[];
let printed: string[];
let stdout: string[];

beforeEach(() => {
	vi.stubEnv("ORA_PLATFORM_URL", "api.ora.test");
	vi.stubEnv("ORA_API_KEY", "");
	// Nothing here may reach a network: the commands are handed the stand-in server's fetch.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("a test sent a request of its own");
		}),
	);
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
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function signedIn() {
	const server = fakeSignInServer();
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "ax-address-")));
	store.write({
		version: 1,
		issuer: ISSUER,
		clientId: "ax-cli",
		resource: PLATFORM,
		tokenEndpoint: `${ISSUER}/oauth2/token`,
		revocationEndpoint: `${ISSUER}/oauth2/revoke`,
		accessToken: "access-0",
		refreshToken: "refresh-0",
		expiresAt: Date.now() + 15 * 60_000,
		scope: "runs:read runs:write tunnels:write tunnels:connect",
	});
	return { server, credentials: platformCredentials({ store, fetchFn: server.fetchFn }) };
}

/** The error document `--json` put on stdout. */
const jsonError = (): { code: string; message: string } => JSON.parse(stdout.join("")).error;
const everything = () => [...errors, ...printed, ...stdout].join("\n");

describe("a platform address that is not a URL, signed in and with no key", () => {
	it("ax whoami says to fix the address (exit 2)", async () => {
		const { server, credentials } = signedIn();
		expect(await whoamiCommand({ json: true }, { credentials })).toBe(EXIT.USAGE);
		expect(jsonError().code).toBe("KEY_DESTINATION_REFUSED");
		expect(jsonError().message).toContain("ORA_PLATFORM_URL is not a URL");
		expect(server.calls).not.toHaveBeenCalled();
	});

	it("ax journey with a goal says to fix the address (exit 2), never a raw TypeError", async () => {
		const { server, credentials } = signedIn();
		const input = { intent: "find the pricing page", harness: "claude-code", json: true };
		expect(await journeyCommand(input, { credentials })).toBe(2);
		expect(jsonError().code).toBe("KEY_DESTINATION_REFUSED");
		expect(everything()).not.toMatch(/TypeError|Invalid URL/);
		expect(server.calls).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("ax audit --tunnel ora says to fix the address before any tunnel opens (exit 2)", async () => {
		const { server, credentials } = signedIn();
		const input = {
			url: "localhost:3000",
			tunnel: "ora",
			json: true,
			showSkipped: false,
			showPassing: false,
			force: false,
		};
		expect(await auditCommand(input, { credentials })).toBe(EXIT.USAGE);
		expect(jsonError().code).toBe("KEY_DESTINATION_REFUSED");
		expect(server.calls).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});
