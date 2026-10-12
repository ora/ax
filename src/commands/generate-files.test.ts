import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import invalidDomain from "../api/__fixtures__/agent-files-invalid.json";
import realBundle from "../api/__fixtures__/agent-files-unscanned.json";
import * as api from "../api/agent-files";
import { EXIT } from "./audit";
import { generateFilesCommand, serializeAgentFile } from "./generate-files";

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
			expect(readFileSync(target, "utf8")).toBe(serializeAgentFile(file.content));
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
