import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import invalidDomain from "../api/__fixtures__/agent-files-invalid.json";
import realBundle from "../api/__fixtures__/agent-files-unscanned.json";
import realBundleAll from "../api/__fixtures__/agent-files-unscanned-all.json";
import * as api from "../api/agent-files";
import { EXIT } from "./audit";
import { displayPath, generateFilesCommand, serializeAgentFile } from "./generate-files";

vi.mock("../api/agent-files", async (importOriginal) => {
	const original = await importOriginal<typeof api>();
	return { ...original, fetchAgentFiles: vi.fn() };
});

const BUNDLE = realBundle as api.AgentFilesBundle;
let out: string;

const run = (over: Partial<Parameters<typeof generateFilesCommand>[0]> = {}) =>
	generateFilesCommand({ domain: "stripe.com", out, force: false, json: false, ...over });

beforeEach(() => {
	out = mkdtempSync(join(tmpdir(), "ax-generate-files-"));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.mocked(api.fetchAgentFiles).mockResolvedValue(BUNDLE);
});

afterEach(() => {
	rmSync(out, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("generateFilesCommand", () => {
	it("writes every file under <out>/.well-known/ exactly as ora drafted it", async () => {
		expect(await run()).toBe(EXIT.OK);
		for (const file of BUNDLE.files) {
			const target = join(out, file.path);
			expect(readFileSync(target, "utf8")).toBe(serializeAgentFile(file));
		}
	});

	it("writes nothing and exits 2 when a file already exists, unless --force", async () => {
		mkdirSync(join(out, ".well-known"));
		writeFileSync(join(out, ".well-known", "poppy.json"), "{}\n");
		expect(await run()).toBe(EXIT.USAGE);
		expect(existsSync(join(out, ".well-known", "ard.json"))).toBe(false);
		expect(readFileSync(join(out, ".well-known", "poppy.json"), "utf8")).toBe("{}\n");

		expect(await run({ force: true })).toBe(EXIT.OK);
		expect(readFileSync(join(out, ".well-known", "poppy.json"), "utf8")).not.toBe("{}\n");
	});

	it("writes only the files it knows, skipping any path ora adds later", async () => {
		const extra = { ...BUNDLE.files[0], path: "/.well-known/future.json" };
		vi.mocked(api.fetchAgentFiles).mockResolvedValueOnce({
			...BUNDLE,
			files: [...BUNDLE.files, extra],
		});
		expect(await run()).toBe(EXIT.OK);
		expect(existsSync(join(out, ".well-known", "future.json"))).toBe(false);
		expect(existsSync(join(out, ".well-known", "ard.json"))).toBe(true);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("skipped /.well-known/future.json"),
		);
	});

	it("--json prints ora's payload verbatim and writes nothing", async () => {
		expect(await run({ json: true })).toBe(EXIT.OK);
		expect(process.stdout.write).toHaveBeenCalledWith(`${JSON.stringify(BUNDLE, null, 2)}\n`);
		expect(existsSync(join(out, ".well-known"))).toBe(false);
	});

	it("exits 2 on ora's invalid-domain refusal and 3 on any other failure", async () => {
		vi.mocked(api.fetchAgentFiles).mockRejectedValueOnce(
			new api.AgentFilesApiError(invalidDomain.message, { status: 400, payload: invalidDomain }),
		);
		expect(await run({ domain: "localhost" })).toBe(EXIT.USAGE);

		vi.mocked(api.fetchAgentFiles).mockRejectedValueOnce(
			new api.AgentFilesApiError("could not reach ora"),
		);
		expect(await run()).toBe(EXIT.API);
	});

	it("--json prints ora's error body on a refusal", async () => {
		vi.mocked(api.fetchAgentFiles).mockRejectedValueOnce(
			new api.AgentFilesApiError(invalidDomain.message, { status: 400, payload: invalidDomain }),
		);
		expect(await run({ domain: "localhost", json: true })).toBe(EXIT.USAGE);
		expect(process.stdout.write).toHaveBeenCalledWith(
			`${JSON.stringify(invalidDomain, null, 2)}\n`,
		);
	});

	it("exits 2 with no domain", async () => {
		expect(await run({ domain: "  " })).toBe(EXIT.USAGE);
		expect(api.fetchAgentFiles).not.toHaveBeenCalled();
	});
});

describe("displayPath", () => {
	it("is relative inside the working directory and absolute outside it", () => {
		expect(displayPath("/home/me/site/public/.well-known/ard.json", "/home/me/site")).toBe(
			join("public", ".well-known", "ard.json"),
		);
		expect(displayPath("/tmp/ax-check/.well-known/ard.json", "/home/me/site")).toBe(
			"/tmp/ax-check/.well-known/ard.json",
		);
	});
});

describe("generateFilesCommand with the 1.31.0 files", () => {
	// The real ?include=all response for an unscanned domain, plus explicit
	// deltas for the files only a scanned domain produces.
	const ALL = realBundleAll as api.AgentFilesBundle;
	const text = (path: string, body: string, mediaType: string): api.AgentFile => ({
		path,
		spec: { name: path, version: "1", url: "https://example.org/" },
		content: {},
		notes: [`note for ${path}`],
		mediaType,
		body,
		url: `https://stripe.com${path}`,
	});
	const card = (url: string): api.AgentFile => ({
		path: new URL(url).pathname,
		spec: { name: "MCP server card", version: "v1", url: "https://example.org/" },
		content: { name: "com.stripe/mcp" },
		notes: [],
		mediaType: "application/json",
		body: '{\n  "name": "com.stripe/mcp"\n}\n',
		url,
	});

	it("writes text files byte for byte at the web root and cards on the domain under their path", async () => {
		vi.mocked(api.fetchAgentFiles).mockResolvedValueOnce({
			...ALL,
			files: [
				...ALL.files,
				text("/robots.txt", "User-agent: *\nAllow: /\n", "text/plain"),
				text("/llms.txt", "# Stripe\n", "text/markdown"),
				card("https://stripe.com/mcp/server-card"),
			],
		});
		expect(await run()).toBe(EXIT.OK);
		expect(readFileSync(join(out, "robots.txt"), "utf8")).toBe("User-agent: *\nAllow: /\n");
		expect(readFileSync(join(out, "llms.txt"), "utf8")).toBe("# Stripe\n");
		expect(readFileSync(join(out, "mcp", "server-card"), "utf8")).toBe(
			'{\n  "name": "com.stripe/mcp"\n}\n',
		);
		expect(existsSync(join(out, ".well-known", "ard.json"))).toBe(true);
	});

	it("names a card that lives on another host instead of writing it, and prints the bundle notes", async () => {
		vi.mocked(api.fetchAgentFiles).mockResolvedValueOnce({
			...ALL,
			files: [...ALL.files, card("https://mcp.stripe.com/server-card")],
		});
		expect(await run()).toBe(EXIT.OK);
		expect(existsSync(join(out, "server-card"))).toBe(false);
		const printed = vi
			.mocked(console.log)
			.mock.calls.map((c) => String(c[0]))
			.join("\n");
		expect(printed).toContain("https://mcp.stripe.com/server-card");
		expect(printed).toContain("No robots.txt draft");
	});

	it("writes a 1.30.0 server's files, which carry no body or url, from their JSON content", async () => {
		expect(await run()).toBe(EXIT.OK);
		const poppy = BUNDLE.files.find((f) => f.path === "/.well-known/poppy.json")!;
		expect(readFileSync(join(out, ".well-known", "poppy.json"), "utf8")).toBe(
			`${JSON.stringify(poppy.content, null, 2)}\n`,
		);
	});
});
