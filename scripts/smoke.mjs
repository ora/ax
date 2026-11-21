#!/usr/bin/env node
// Post-build smoke test for the bundled CLI.
//
// tsup inlines package.json at build time (src/main.ts imports it), so a build
// that ran *before* a version bump would publish a binary whose `ax --version`
// lies. The release workflow bumps then builds; this asserts that ordering held.
// Also checks the things that break `npx ax` but never break `pnpm test`:
// a missing shebang or a non-executable bin.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
		"login",
		"logout",
		"whoami",
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
check("login --help exits 0", () => ax(["login", "--help"]));
check("logout --help exits 0", () => ax(["logout", "--help"]));
check("whoami --help exits 0", () => ax(["whoami", "--help"]));

// Each call below fails on its flags before any network call, so these run offline.
function axFails(args) {
	const run = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
	return { status: run.status, stderr: run.stderr };
}

// The sign-in commands, from an empty directory (no .env) with an empty config home, so a
// developer's own sign-in or key never reaches them. Each one ends before any network call.
const home = mkdtempSync(join(tmpdir(), "ax-smoke-"));
function axSignedOut(args, env = {}) {
	const run = spawnSync(process.execPath, [resolve(BIN), ...args], {
		cwd: home,
		encoding: "utf8",
		env: { ...process.env, XDG_CONFIG_HOME: home, ORA_API_KEY: "", ...env },
	});
	return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

check("whoami with no sign-in and no key exits 2 and says ax login", () => {
	const { status, stderr } = axSignedOut(["whoami"]);
	if (status !== 2) throw new Error(`exit ${status}, want 2`);
	if (!stderr.includes("ax login")) throw new Error("does not point at ax login");
});

check("logout with nothing stored exits 0 and says so", () => {
	const { status, stdout } = axSignedOut(["logout"]);
	if (status !== 0) throw new Error(`exit ${status}, want 0`);
	if (!stdout.includes("Not signed in")) throw new Error("does not say it was not signed in");
});

check("login refuses a platform that is not api.<domain> before any request", () => {
	const { status } = axSignedOut(["login", "--no-browser"], {
		ORA_PLATFORM_URL: "https://platform.example.test",
	});
	if (status !== 2) throw new Error(`exit ${status}, want 2`);
});

check("deep-journey still runs, notes its new name, and keeps its exit codes", () => {
	const args = [
		"deep-journey",
		"example.com",
		"--task",
		"Find the pricing page",
		"--intent",
		"pricing",
	];
	const { status, stderr } = axFails(args);
	if (status !== 2) throw new Error(`exit ${status}, want 2`);
	if (
		!stderr.includes(
			"ax deep-journey is now ax journey 'Find the pricing page' --domain example.com",
		)
	) {
		throw new Error("no deprecation note naming the new call");
	}
	if (!stderr.includes("ax deep-journey: --task and --intent"))
		throw new Error("the error changed");
});

check("journey with no goal takes the free path, which needs --domain", () => {
	const { status, stderr } = axFails(["journey", "--intent", "pricing"]);
	if (status !== 2) throw new Error(`exit ${status}, want 2`);
	if (!stderr.includes("--domain names the site")) throw new Error("not the free path's error");
	if (stderr.includes("ORA_API_KEY")) throw new Error("the free path asked for a Front key");
});

if (failures.length > 0) {
	console.error(`\nsmoke failed (${failures.length}):`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log("\nsmoke passed");
