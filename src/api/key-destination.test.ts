import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalEnv } from "../env";
import {
	assertKeyDestination,
	KeyDestinationError,
	keyDestinationProblem,
} from "./key-destination";

const DEFAULT = "https://api.agentfront.sh";
const problem = (base: string) => keyDestinationProblem(base, "ORA_PLATFORM_URL", DEFAULT);

// A `.env` is resolved from cwd, so the cases that load one run in a throwaway
// directory: the repo's own .env must never feed a test.
describe("keyDestinationProblem", () => {
	const originalCwd = process.cwd();
	const original = process.env.ORA_PLATFORM_URL;
	let dir: string | undefined;

	afterEach(() => {
		if (dir) {
			// A load that finds no file forgets the last file's variables. It runs here, never
			// back in the repo, whose .env must not be read.
			rmSync(join(dir, ".env"), { force: true });
			loadLocalEnv();
		}
		process.chdir(originalCwd);
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		// delete, not assignment: process.env would store the string "undefined".
		if (original === undefined) delete process.env.ORA_PLATFORM_URL;
		else process.env.ORA_PLATFORM_URL = original;
	});

	function loadEnvFile(contents: string): void {
		// An exported value wins over the file, so one inherited from the shell would hide it.
		delete process.env.ORA_PLATFORM_URL;
		dir = mkdtempSync(join(tmpdir(), "ax-key-destination-"));
		writeFileSync(join(dir, ".env"), contents);
		process.chdir(dir);
		loadLocalEnv();
	}

	it("passes the default host", () => {
		expect(problem(DEFAULT)).toBeUndefined();
		expect(problem(`${DEFAULT}/`)).toBeUndefined();
	});

	it("passes an https host the shell exported", () => {
		process.env.ORA_PLATFORM_URL = "https://staging.example";
		expect(problem("https://staging.example")).toBeUndefined();
	});

	it("passes plain http to this machine", () => {
		for (const base of [
			"http://localhost:3000",
			"http://127.0.0.1:9999",
			"http://ora.localhost:1355",
			"http://[::1]:8080",
		]) {
			expect(problem(base), base).toBeUndefined();
		}
	});

	it("refuses plain http to any other host, including ones that only start like this machine", () => {
		for (const base of [
			"http://api.example",
			"http://127.0.0.1.collector.example",
			"http://localhost.collector.example",
		]) {
			const refused = problem(base);
			expect(refused, base).toContain("ORA_PLATFORM_URL");
			expect(refused, base).toContain("https");
		}
	});

	it("refuses a value that is not a URL without echoing it", () => {
		const refused = problem("not a url\u001b[2J");
		expect(refused).toContain("ORA_PLATFORM_URL");
		expect(refused).not.toContain("\u001b");
	});

	it("refuses a host that only ./.env named, and says how to choose it", () => {
		loadEnvFile("ORA_PLATFORM_URL=https://collector.example\n");
		const refused = problem("https://collector.example");
		expect(refused).toContain("./.env");
		expect(refused).toContain("collector.example");
		expect(refused).toContain("export ORA_PLATFORM_URL");
	});

	it("passes the default host when ./.env names it", () => {
		loadEnvFile("ORA_PLATFORM_URL=https://api.agentfront.sh\n");
		expect(problem(DEFAULT)).toBeUndefined();
	});

	it("passes this machine when ./.env names it", () => {
		loadEnvFile("ORA_PLATFORM_URL=http://localhost:4000\n");
		expect(problem("http://localhost:4000")).toBeUndefined();
	});

	it("does not hold ./.env against a host the caller passed in code", () => {
		loadEnvFile("ORA_PLATFORM_URL=https://collector.example\n");
		expect(problem("https://staging.example")).toBeUndefined();
	});
});

describe("assertKeyDestination", () => {
	it("throws the problem as a KeyDestinationError", () => {
		expect(() =>
			assertKeyDestination("http://api.example", "ORA_API_URL", "https://ora.ai"),
		).toThrow(KeyDestinationError);
		expect(() =>
			assertKeyDestination("https://ora.ai", "ORA_API_URL", "https://ora.ai"),
		).not.toThrow();
	});
});
