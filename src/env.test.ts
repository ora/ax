import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fromLocalEnvFile, loadLocalEnv } from "./env";

// Every case runs inside a throwaway directory: `.env` is resolved from cwd, and
// the repo's own .env holds a real key that must never leak into a test.
describe("loadLocalEnv", () => {
	const originalCwd = process.cwd();
	const originalKey = process.env.ORA_API_KEY;
	let dir: string | undefined;

	afterEach(() => {
		process.chdir(originalCwd);
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		// loadEnvFile mutates process.env for real, so stub helpers cannot undo it.
		// process.env stringifies whatever it is given, so biome's suggested
		// `= undefined` stores the literal "undefined" and the next test reads it
		// back as a key. delete is the only way to genuinely unset the variable.
		// biome-ignore lint/performance/noDelete: assignment would store "undefined" as a string
		if (originalKey === undefined) delete process.env.ORA_API_KEY;
		else process.env.ORA_API_KEY = originalKey;
	});

	function inTempDir(contents?: string): void {
		dir = mkdtempSync(join(tmpdir(), "ax-env-"));
		if (contents !== undefined) writeFileSync(join(dir, ".env"), contents);
		process.chdir(dir);
	}

	it("reads a local .env into the environment", () => {
		inTempDir("ORA_API_KEY=from_file\n");
		expect(loadLocalEnv()).toBe(true);
		expect(process.env.ORA_API_KEY).toBe("from_file");
	});

	it("lets an exported variable win over the file", () => {
		process.env.ORA_API_KEY = "from_environment";
		inTempDir("ORA_API_KEY=from_file\n");

		loadLocalEnv();

		// A key exported for this shell beats a stale .env sitting in the directory.
		expect(process.env.ORA_API_KEY).toBe("from_environment");
	});

	it("remembers which variables the file supplied", () => {
		inTempDir("ORA_API_KEY=from_file\n");
		loadLocalEnv();
		expect(fromLocalEnvFile("ORA_API_KEY")).toBe(true);
		expect(fromLocalEnvFile("PATH")).toBe(false);
	});

	it("does not count a variable the shell exported, even when the file sets it too", () => {
		process.env.ORA_API_KEY = "from_environment";
		inTempDir("ORA_API_KEY=from_file\n");
		loadLocalEnv();
		expect(fromLocalEnvFile("ORA_API_KEY")).toBe(false);
	});

	it("forgets the file's variables when a later load finds no file", () => {
		inTempDir("ORA_API_KEY=from_file\n");
		loadLocalEnv();
		rmSync(join(process.cwd(), ".env"));
		loadLocalEnv();
		expect(fromLocalEnvFile("ORA_API_KEY")).toBe(false);
	});

	it("reports no load when the directory has no .env", () => {
		inTempDir();
		expect(loadLocalEnv()).toBe(false);
		expect(process.env.ORA_API_KEY).toBe(originalKey);
	});

	it("survives a runtime without loadEnvFile instead of throwing", () => {
		inTempDir("ORA_API_KEY=from_file\n");
		const loader = process.loadEnvFile;
		// Node gained loadEnvFile in 20.12; older runtimes must still start.
		(process as { loadEnvFile?: unknown }).loadEnvFile = undefined;
		try {
			expect(loadLocalEnv()).toBe(false);
		} finally {
			process.loadEnvFile = loader;
		}
	});
});
