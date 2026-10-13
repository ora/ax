#!/usr/bin/env node
// Post-build smoke test for the bundled CLI.
//
// tsup inlines package.json at build time (src/main.ts imports it), so a build
// that ran *before* a version bump would publish a binary whose `ax --version`
// lies. The release workflow bumps then builds; this asserts that ordering held.
// Also checks the things that break `npx ax` but never break `pnpm test`:
// a missing shebang or a non-executable bin.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const BIN = "dist/main.cjs";
const failures = [];

function check(label, fn) {
	try {
		fn();
		console.log(`  ok    ${label}`);
	} catch (error) {
		failures.push(`${label}: ${error.message}`);
		console.log(`  FAIL  ${label}`);
	}
}

function ax(args) {
	return execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" }).trim();
}

const expectedVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

console.log(`smoke: ${BIN} (expecting v${expectedVersion})`);

check("bin is executable", () => {
	const mode = statSync(BIN).mode;
	if (!(mode & 0o111)) throw new Error("missing executable bit");
});

check("bin has a node shebang", () => {
	const head = readFileSync(BIN, "utf8").slice(0, 32);
	if (!head.startsWith("#!/usr/bin/env node")) throw new Error(`starts with ${head.slice(0, 20)}`);
});

check("--version matches package.json", () => {
	// citty prints through consola, which tags lines as "[log] 0.1.0" whenever CI
	// is set and prints a bare "0.1.0" otherwise. Match the semver rather than the
	// whole line so this asserts the same thing on a laptop and on a runner.
	const raw = ax(["--version"]);
	const actual = raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
	if (actual !== expectedVersion) {
		throw new Error(`got ${JSON.stringify(raw)}, want "${expectedVersion}"`);
	}
});

check("--help exits 0 and lists every command", () => {
	const help = ax(["--help"]);
	for (const command of [
		"audit",
		"webmcp-audit",
		"deep-journey",
		"journey",
		"skill",
		"generate-files",
	]) {
		if (!help.includes(command)) throw new Error(`help omits "${command}"`);
	}
});

check("--help and -h show the curated screen, the same one as bare ax", () => {
	const bare = ax([]);
	for (const flag of ["--help", "-h"]) {
		const help = ax([flag]);
		if (help !== bare) throw new Error(`${flag} differs from bare ax`);
		if (!help.includes("Examples:")) throw new Error(`${flag} is not the curated screen`);
	}
});

check("audit --help exits 0", () => ax(["audit", "--help"]));
check("webmcp-audit --help exits 0", () => ax(["webmcp-audit", "--help"]));
check("deep-journey --help exits 0", () => ax(["deep-journey", "--help"]));
check("journey --help exits 0", () => ax(["journey", "--help"]));

if (failures.length > 0) {
	console.error(`\nsmoke failed (${failures.length}):`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log("\nsmoke passed");
