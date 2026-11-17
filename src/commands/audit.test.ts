import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import realAuditScan from "../api/__fixtures__/audit-scan.json";
import * as api from "../api/audit";
import { SignInEndedError } from "../auth/errors";
import { platformCredentials } from "../auth/resolve-credential";
import { SessionStore } from "../auth/session-store";
import type { AuditScanResult } from "../contract";
import { MCP_AUTH_REQUIRED_NOTICE } from "../report/terminal";
import * as tunnel from "../tunnel";
import * as oraTunnel from "../tunnel/ora";
import { auditCommand } from "./audit";
import { EXIT } from "./exit-codes";

vi.mock("../api/audit", async (importOriginal) => {
	const original = await importOriginal<typeof api>();
	return { ...original, performAudit: vi.fn() };
});
vi.mock("../tunnel", async (importOriginal) => {
	const original = await importOriginal<typeof tunnel>();
	return { ...original, openTunnel: vi.fn() };
});
vi.mock("../tunnel/ora", async (importOriginal) => {
	const original = await importOriginal<typeof oraTunnel>();
	return { ...original, openOraTunnel: vi.fn() };
});

const FIXTURE = realAuditScan as unknown as AuditScanResult;

const resolveWith = (extra: Partial<AuditScanResult> = {}) =>
	vi.mocked(api.performAudit).mockResolvedValue({ result: { ...FIXTURE, ...extra } });

// Contract 1.25.0: the auth-gated MCP target arrives as a typed error frame,
// not as a scored result. The frame itself is what --json has to print.
const MCP_AUTH_FRAME = {
	type: "error",
	message: "The MCP server requires authentication, so it could not be inspected.",
	code: "MCP_AUTH_REQUIRED",
	mcpAuthRequired: true,
	mcpUrl: "https://example.com/mcp",
	urlKind: "mcp",
	timestamp: "2026-09-17T10:20:30.000Z",
};

const rejectWithMcpAuth = () =>
	vi.mocked(api.performAudit).mockRejectedValue(
		new api.AuditApiError(`ora audit failed: ${MCP_AUTH_FRAME.message}`, {
			code: api.MCP_AUTH_REQUIRED,
			payload: MCP_AUTH_FRAME,
		}),
	);

// Every run gets a sign-in store of its own, empty unless a test writes into it: whatever this
// machine has stored never reaches these tests.
let store: SessionStore;
beforeEach(() => {
	store = new SessionStore(mkdtempSync(join(tmpdir(), "ax-audit-")));
});

const run = (over: Partial<Parameters<typeof auditCommand>[0]> = {}) =>
	auditCommand(
		{
			url: "example.com",
			json: true, // no spinner / renderer noise in tests
			showSkipped: false,
			showPassing: false,
			force: false,
			...over,
		},
		{ credentials: platformCredentials({ store }) },
	);

describe("auditCommand exit codes", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("0 on success", async () => {
		resolveWith();
		expect(await run()).toBe(EXIT.OK);
	});

	it("0 when the score meets --min-score, 1 when it is below", async () => {
		resolveWith({ score: 42 });
		expect(await run({ minScore: "42" })).toBe(EXIT.OK);
		resolveWith({ score: 42 });
		expect(await run({ minScore: "43" })).toBe(EXIT.BELOW_MIN_SCORE);
	});

	it("2 on a malformed URL without calling the API", async () => {
		const perform = vi.mocked(api.performAudit);
		expect(await run({ url: "not a url" })).toBe(EXIT.USAGE);
		expect(await run({ url: "" })).toBe(EXIT.USAGE);
		expect(await run({ url: "http://" })).toBe(EXIT.USAGE);
		expect(perform).not.toHaveBeenCalled();
	});

	it("2 on an unparseable --min-score or --max-age", async () => {
		const perform = vi.mocked(api.performAudit);
		expect(await run({ minScore: "seventy" })).toBe(EXIT.USAGE);
		expect(await run({ minScore: "101" })).toBe(EXIT.USAGE);
		expect(await run({ minScore: "-1" })).toBe(EXIT.USAGE);
		expect(await run({ maxAge: "6h" })).toBe(EXIT.USAGE);
		expect(perform).not.toHaveBeenCalled();
	});

	it("2 on a local target without a tunnel command, without calling the API", async () => {
		const saved = process.env.ORA_TUNNEL_CMD;
		delete process.env.ORA_TUNNEL_CMD;
		try {
			const perform = vi.mocked(api.performAudit);
			expect(await run({ url: "localhost:3000" })).toBe(EXIT.USAGE);
			expect(perform).not.toHaveBeenCalled();
		} finally {
			if (saved !== undefined) process.env.ORA_TUNNEL_CMD = saved;
		}
	});

	it("3 when the API is unreachable or rate limited", async () => {
		vi.mocked(api.performAudit).mockRejectedValue(new api.AuditApiError("ora rate limit exceeded"));
		expect(await run()).toBe(EXIT.API);
	});

	it("accepts bare domains and full URLs", async () => {
		resolveWith();
		expect(await run({ url: "example.com" })).toBe(EXIT.OK);
		resolveWith();
		expect(await run({ url: "https://docs.example.com/path/" })).toBe(EXIT.OK);
	});

	it("threads --force and --max-age to the client", async () => {
		resolveWith();
		await run({ force: true, maxAge: "7200" });
		expect(vi.mocked(api.performAudit)).toHaveBeenCalledWith(
			"example.com",
			expect.objectContaining({ force: true, maxAgeSeconds: 7200 }),
		);
	});

	it("threads --api-key to the client", async () => {
		resolveWith();
		await run({ apiKey: "sk_live_abc" });
		expect(vi.mocked(api.performAudit)).toHaveBeenCalledWith(
			"example.com",
			expect.objectContaining({ apiKey: "sk_live_abc" }),
		);
	});

	it("skips the gate for an auth-gated MCP result (unscored, not failed)", async () => {
		resolveWith({ mcpAuthRequired: true, score: 0, grade: "F" });
		expect(await run({ minScore: "70" })).toBe(EXIT.OK);
	});

	it("0 when ora answers MCP_AUTH_REQUIRED — unscored, not a failed audit", async () => {
		rejectWithMcpAuth();
		expect(await run()).toBe(EXIT.OK);
		expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toMatch(/Audit failed/);
	});

	it("skips the gate on an MCP_AUTH_REQUIRED error and says so on stderr", async () => {
		rejectWithMcpAuth();
		expect(await run({ minScore: "70" })).toBe(EXIT.OK);
		const notes = vi
			.mocked(process.stderr.write)
			.mock.calls.map((c) => String(c[0]))
			.join("");
		expect(notes).toContain("--min-score skipped");
		expect(notes).toContain("unscored");
	});

	it("--json prints the MCP_AUTH_REQUIRED error object exactly as ora served it", async () => {
		rejectWithMcpAuth();
		await run({ json: true });
		const printed = vi
			.mocked(process.stdout.write)
			.mock.calls.map((c) => String(c[0]))
			.join("");
		expect(printed).toBe(`${JSON.stringify(MCP_AUTH_FRAME, null, 2)}\n`);
	});

	it("without --json, MCP_AUTH_REQUIRED prints the shared notice and the MCP URL", async () => {
		rejectWithMcpAuth();
		expect(await run({ json: false })).toBe(EXIT.OK);
		const out = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(out).toContain(MCP_AUTH_REQUIRED_NOTICE);
		expect(out).toContain(MCP_AUTH_FRAME.mcpUrl);
		// ora sends no score on this path, so the notice must not explain a 0/F
		// the user never sees - that clause belongs to the legacy banner alone.
		expect(out).not.toContain("0/F");
		expect(vi.mocked(process.stdout.write)).not.toHaveBeenCalled();
	});

	it("--json falls back to code and message when the error carries no payload", async () => {
		// AuditApiError is public: a library consumer can raise one with a code
		// and no payload, and stringifying undefined would print "undefined".
		vi.mocked(api.performAudit).mockRejectedValue(
			new api.AuditApiError("ora audit failed: no payload here", {
				code: api.MCP_AUTH_REQUIRED,
			}),
		);
		expect(await run({ json: true })).toBe(EXIT.OK);
		const printed = vi
			.mocked(process.stdout.write)
			.mock.calls.map((c) => String(c[0]))
			.join("");
		expect(JSON.parse(printed)).toEqual({
			code: api.MCP_AUTH_REQUIRED,
			message: "ora audit failed: no payload here",
		});
	});

	it("3 on an AuditApiError carrying any other code", async () => {
		vi.mocked(api.performAudit).mockRejectedValue(
			new api.AuditApiError("ora rate limit exceeded", { code: "RATE_LIMITED" }),
		);
		expect(await run()).toBe(EXIT.API);
	});

	it("--json prints the raw payload byte-for-byte", async () => {
		resolveWith();
		const write = vi.mocked(process.stdout.write);
		await run();
		const printed = write.mock.calls.map((c) => String(c[0])).join("");
		expect(JSON.parse(printed)).toEqual(FIXTURE);
	});
});

describe("auditCommand Next lines and the --json error envelope", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	const stdout = () =>
		vi
			.mocked(process.stdout.write)
			.mock.calls.map((c) => String(c[0]))
			.join("");
	const stderrLines = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));

	it("--json prints the envelope on a usage error and exits 2", async () => {
		expect(await run({ url: "not a domain" })).toBe(EXIT.USAGE);
		expect(JSON.parse(stdout())).toEqual({
			error: {
				code: "INVALID_TARGET",
				message: 'Not a scannable URL or domain: "not a domain"',
				next: "ax audit <domain> --json",
			},
		});
		expect(stderrLines()).toContain(
			"Next: ax audit <domain> --json  # a public URL or domain, e.g. docs.example.com",
		);
	});

	it("--json carries ora's code on an API error, with a retry that never echoes the key", async () => {
		vi.mocked(api.performAudit).mockRejectedValue(
			new api.AuditApiError("ora rate limit exceeded", { code: "RATE_LIMITED" }),
		);
		expect(await run({ apiKey: "sk_live_not_for_echo" })).toBe(EXIT.API);
		const envelope = JSON.parse(stdout());
		expect(envelope.error.code).toBe("RATE_LIMITED");
		expect(envelope.error.next).toBe("ax audit example.com --json --api-key <key>");
		expect(`${stdout()}${stderrLines().join("\n")}`).not.toContain("sk_live_not_for_echo");
	});

	it("--json prints ora's error body unchanged on an API error, the notes on stderr", async () => {
		const served = {
			error: "usage_limit_reached",
			kind: "scans",
			period: "month",
			used: 500,
			limit: 500,
		};
		vi.mocked(api.performAudit).mockRejectedValue(
			new api.AuditApiError("ora usage limit reached: this API key has used its scans limit", {
				payload: served,
			}),
		);
		expect(await run()).toBe(EXIT.API);
		expect(stdout()).toBe(`${JSON.stringify(served, null, 2)}\n`);
		expect(stderrLines()).toEqual([
			"Audit failed: ora usage limit reached: this API key has used its scans limit",
			"Next: ax audit example.com --json  # retry; if ora rate limited you, wait as long as the message says first",
		]);
	});

	it("--json keeps stdout the raw payload and puts the Next line on stderr", async () => {
		resolveWith();
		expect(await run()).toBe(EXIT.OK);
		expect(JSON.parse(stdout())).toEqual(FIXTURE);
		expect(stderrLines()).toContain(
			"Next: ax journey --domain example.com --json  # send a real agent at the site on a task, then read its result",
		);
	});

	it("below --min-score, the Next line is a forced rescan through the same gate", async () => {
		resolveWith();
		expect(await run({ minScore: "70" })).toBe(EXIT.BELOW_MIN_SCORE);
		expect(stderrLines()).toContain(
			"Next: ax audit example.com --json --force --min-score 70  # after you apply the Top fixes above, rescan",
		);
	});

	it("ends the human report with the Next line on stdout", async () => {
		resolveWith();
		expect(await run({ json: false })).toBe(EXIT.OK);
		expect(console.log).toHaveBeenLastCalledWith(
			"Next: ax journey --domain example.com  # send a real agent at the site on a task, then read its result",
		);
	});

	it("MCP_AUTH_REQUIRED keeps the raw frame on stdout and points at the site that serves it", async () => {
		rejectWithMcpAuth();
		expect(await run({ url: "https://example.com/mcp" })).toBe(EXIT.OK);
		expect(JSON.parse(stdout())).toEqual(MCP_AUTH_FRAME);
		expect(stderrLines()).toContain(
			"Next: ax audit example.com --json  # ora cannot inspect an MCP server that needs credentials; score the site that serves it",
		);
	});

	it("MCP_AUTH_REQUIRED at a host root asks for the site rather than repeating the call", async () => {
		rejectWithMcpAuth();
		expect(await run({ url: "api.example.com" })).toBe(EXIT.OK);
		expect(stderrLines().find((line) => line.startsWith("Next:"))).toMatch(
			/^Next: ax audit <site domain> --json {2}#/,
		);
	});
});

describe("auditCommand tunnels", () => {
	const TUNNEL_VARS = ["ORA_TUNNEL_CMD", "ORA_TUNNEL", "ORA_API_KEY"] as const;
	const saved: Partial<Record<(typeof TUNNEL_VARS)[number], string>> = {};
	const fakeTunnel = () => ({ url: "https://abc.t.agentfront.sh", close: vi.fn(async () => {}) });

	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn());
		for (const name of TUNNEL_VARS) {
			saved[name] = process.env[name];
			delete process.env[name];
		}
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		for (const name of TUNNEL_VARS) {
			if (saved[name] !== undefined) process.env[name] = saved[name];
			else delete process.env[name];
		}
	});

	it("--tunnel ora without ORA_API_KEY is a usage error before any request", async () => {
		expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.USAGE);
		expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toMatch(
			/tunnels:write \+ tunnels:connect/,
		);
		expect(fetch).not.toHaveBeenCalled();
		expect(oraTunnel.openOraTunnel).not.toHaveBeenCalled();
		expect(api.performAudit).not.toHaveBeenCalled();
	});

	describe("with a browser sign-in and no key", () => {
		const signIn = (resource: string) =>
			store.write({
				version: 1,
				issuer: "https://account.ora.ai",
				clientId: "ax-cli",
				resource,
				tokenEndpoint: "https://account.ora.ai/oauth2/token",
				accessToken: "access-1",
				refreshToken: "refresh-1",
				expiresAt: Date.now() + 600_000,
				scope: "tunnels:write tunnels:connect",
			});
		beforeEach(() => vi.stubEnv("ORA_PLATFORM_URL", "https://api.ora.ai"));
		afterEach(() => vi.unstubAllEnvs());

		it("--tunnel ora opens the tunnel with the sign-in", async () => {
			signIn("https://api.ora.ai");
			vi.mocked(oraTunnel.openOraTunnel).mockResolvedValue(fakeTunnel());
			resolveWith();
			expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.OK);
			expect(oraTunnel.openOraTunnel).toHaveBeenCalledWith(
				"localhost:3000",
				expect.objectContaining({ credential: expect.objectContaining({ kind: "sign_in" }) }),
			);
		});

		it("--tunnel ora with a sign-in for another platform says which, before any request", async () => {
			signIn("https://api.other.test");
			expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.USAGE);
			expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
				"Your ax sign-in is for https://api.other.test, not https://api.ora.ai.",
			);
			expect(fetch).not.toHaveBeenCalled();
			expect(oraTunnel.openOraTunnel).not.toHaveBeenCalled();
		});
	});

	it("--tunnel with anything but ora, or with no value, is a usage error", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		expect(await run({ url: "localhost:3000", tunnel: "ngrok" })).toBe(EXIT.USAGE);
		expect(await run({ url: "localhost:3000", tunnel: "" })).toBe(EXIT.USAGE);
		expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toMatch(/--tunnel must be "ora"/);
		expect(oraTunnel.openOraTunnel).not.toHaveBeenCalled();
	});

	it("--tunnel ora passes an abort signal so a Ctrl-C during setup can clean up", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		vi.mocked(oraTunnel.openOraTunnel).mockResolvedValue(fakeTunnel());
		resolveWith();
		await run({ url: "localhost:3000", tunnel: "ora" });
		expect(oraTunnel.openOraTunnel).toHaveBeenCalledWith(
			"localhost:3000",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("a tunnel dropped mid-audit fails the run (exit 2) instead of rendering a result", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		const handle = { ...fakeTunnel(), dropped: Promise.resolve(new tunnel.TunnelError("dropped")) };
		vi.mocked(oraTunnel.openOraTunnel).mockResolvedValue(handle);
		vi.mocked(api.performAudit).mockReturnValue(new Promise(() => {})); // never settles
		expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.USAGE);
		expect(handle.close).toHaveBeenCalledTimes(1);
		expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toMatch(/dropped/);
	});

	it("a tunnel ora closed because the sign-in ended stops the audit and says ax login", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		const ended = new SignInEndedError(
			"ora closed the tunnel (4401): your sign-in no longer works. Run ax login.",
		);
		const handle = { ...fakeTunnel(), dropped: Promise.resolve(ended) };
		vi.mocked(oraTunnel.openOraTunnel).mockResolvedValue(handle);
		let stopSignal: AbortSignal | undefined;
		vi.mocked(api.performAudit).mockImplementation((_target, options) => {
			stopSignal = options?.signal;
			// A scan that never ends on its own, and rejects the moment it is stopped, as the real one does.
			return new Promise((_, reject) =>
				options?.signal?.addEventListener("abort", () =>
					reject(new api.AuditApiError("ora audit stopped")),
				),
			);
		});
		expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.USAGE);
		expect(stopSignal?.aborted).toBe(true);
		expect(handle.close).toHaveBeenCalledTimes(1);
		const stderr = vi.mocked(console.error).mock.calls.flat().join("\n");
		expect(stderr).toContain("your sign-in no longer works");
		expect(stderr).not.toContain("ora audit stopped");
		expect(stderr).toMatch(/Next: ax login/);
	});

	it("a sign-in that ends while the tunnel opens reads as it does mid-audit: SIGN_IN_ENDED", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		const ended = new SignInEndedError("Your ax sign-in no longer works. Run ax login.");
		// openOraTunnel wraps a credential's failure, keeping it as the cause.
		vi.mocked(oraTunnel.openOraTunnel).mockRejectedValue(
			new tunnel.TunnelError(`${ended.message}\n(--tunnel ora needs ax login)`, { cause: ended }),
		);
		expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.USAGE);
		const printed = vi
			.mocked(process.stdout.write)
			.mock.calls.map((c) => String(c[0]))
			.join("");
		expect(JSON.parse(printed).error).toMatchObject({
			code: "SIGN_IN_ENDED",
			message: ended.message,
			next: "ax login",
		});
		expect(api.performAudit).not.toHaveBeenCalled();
	});

	it("--tunnel ora audits the tunnel's public URL as ephemeral and closes it afterwards", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		const handle = fakeTunnel();
		vi.mocked(oraTunnel.openOraTunnel).mockResolvedValue(handle);
		resolveWith();
		expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.OK);
		expect(oraTunnel.openOraTunnel).toHaveBeenCalledWith("localhost:3000", expect.anything());
		expect(api.performAudit).toHaveBeenCalledWith(
			"https://abc.t.agentfront.sh",
			expect.objectContaining({ ephemeral: true }),
		);
		expect(handle.close).toHaveBeenCalledTimes(1);
	});

	it("--tunnel ora closes the tunnel when the audit fails, and still exits 3", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		const handle = fakeTunnel();
		vi.mocked(oraTunnel.openOraTunnel).mockResolvedValue(handle);
		vi.mocked(api.performAudit).mockRejectedValue(new api.AuditApiError("ora is down"));
		expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.API);
		expect(handle.close).toHaveBeenCalledTimes(1);
	});

	it("--tunnel ora closes the tunnel on the MCP_AUTH_REQUIRED path, and still exits 0", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		const handle = fakeTunnel();
		vi.mocked(oraTunnel.openOraTunnel).mockResolvedValue(handle);
		rejectWithMcpAuth();
		expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.OK);
		expect(handle.close).toHaveBeenCalledTimes(1);
	});

	it("--tunnel ora setup failure is a usage error and never audits", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		vi.mocked(oraTunnel.openOraTunnel).mockRejectedValue(new tunnel.TunnelError("refused"));
		expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.USAGE);
		expect(api.performAudit).not.toHaveBeenCalled();
	});

	it("--json passes the platform's error body through when --tunnel ora is refused", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		const served = { error: "insufficient_scope", required: ["tunnels:write"] };
		vi.mocked(oraTunnel.openOraTunnel).mockRejectedValue(
			new tunnel.TunnelError("ora refused the tunnel (403): insufficient_scope", {
				payload: served,
			}),
		);
		expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.USAGE);
		const printed = vi
			.mocked(process.stdout.write)
			.mock.calls.map((c) => String(c[0]))
			.join("");
		expect(printed).toBe(`${JSON.stringify(served, null, 2)}\n`);
	});

	it("ORA_TUNNEL=ora selects the ora tunnel, and --tunnel-cmd wins over it", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		process.env.ORA_TUNNEL = "ora";
		vi.mocked(oraTunnel.openOraTunnel).mockResolvedValue(fakeTunnel());
		resolveWith();
		expect(await run({ url: "localhost:3000" })).toBe(EXIT.OK);
		expect(oraTunnel.openOraTunnel).toHaveBeenCalledTimes(1);

		vi.mocked(tunnel.openTunnel).mockResolvedValue(fakeTunnel());
		resolveWith();
		expect(await run({ url: "localhost:3000", tunnelCmd: "ngrok http 3000", tunnel: "ora" })).toBe(
			EXIT.OK,
		);
		expect(tunnel.openTunnel).toHaveBeenCalledWith("ngrok http 3000");
		expect(oraTunnel.openOraTunnel).toHaveBeenCalledTimes(1);
	});

	it("invariant: every tunnel audit is ephemeral, a public target never is", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		vi.mocked(oraTunnel.openOraTunnel).mockResolvedValue(fakeTunnel());
		vi.mocked(tunnel.openTunnel).mockResolvedValue(fakeTunnel());
		const perform = vi.mocked(api.performAudit);

		resolveWith();
		await run({ url: "localhost:3000", tunnel: "ora" });
		expect(perform).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({ ephemeral: true }),
		);

		resolveWith();
		await run({ url: "localhost:3000", tunnelCmd: "ngrok http 3000 --log stdout" });
		expect(perform).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({ ephemeral: true }),
		);

		resolveWith();
		await run({ url: "example.com" });
		expect(perform).toHaveBeenLastCalledWith(
			"example.com",
			expect.objectContaining({ ephemeral: undefined }),
		);
	});
});
