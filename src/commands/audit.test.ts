import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import realAuditScan from "../api/__fixtures__/audit-scan.json";
import * as api from "../api/audit";
import type { AuditScanResult } from "../contract";
import * as tunnel from "../tunnel";
import * as oraTunnel from "../tunnel/ora";
import { auditCommand, EXIT } from "./audit";

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

const run = (over: Partial<Parameters<typeof auditCommand>[0]> = {}) =>
	auditCommand({
		url: "example.com",
		json: true, // no spinner / renderer noise in tests
		showSkipped: false,
		showPassing: false,
		force: false,
		...over,
	});

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

	it("--json prints the raw payload byte-for-byte", async () => {
		resolveWith();
		const write = vi.mocked(process.stdout.write);
		await run();
		const printed = write.mock.calls.map((c) => String(c[0])).join("");
		expect(JSON.parse(printed)).toEqual(FIXTURE);
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

	it("--tunnel ora setup failure is a usage error and never audits", async () => {
		process.env.ORA_API_KEY = "ora_sk_test";
		vi.mocked(oraTunnel.openOraTunnel).mockRejectedValue(new tunnel.TunnelError("refused"));
		expect(await run({ url: "localhost:3000", tunnel: "ora" })).toBe(EXIT.USAGE);
		expect(api.performAudit).not.toHaveBeenCalled();
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
