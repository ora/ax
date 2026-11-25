#!/usr/bin/env node
// Post-build smoke test for the bundled CLI.
//
// tsup inlines package.json at build time (src/main.ts imports it), so a build
// that ran *before* a version bump would publish a binary whose `ax --version`
// lies. The release workflow bumps then builds; this asserts that ordering held.
// Also checks the things that break `npx ax` but never break `pnpm test`:
// a missing shebang or a non-executable bin.

import { execFileSync, spawn, spawnSync } from "node:child_process";
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

check(
	"--help shows a set of journeys: how to start one, and how to list, follow and stop one",
	() => {
		const help = ax(["--help"]);
		for (const piece of [
			"a set of journeys",
			"run set list",
			"run set view",
			"run set cancel",
			// Every flag a set takes, in the top-level help itself, not only under ax run --help.
			"--agents <list>",
			"--levels",
			"--brand <name>",
			"--docs <url>",
			"--exact <url>",
			"--repeat <n>",
			"--yes",
			"--wait <minutes>",
			"--watch",
		]) {
			if (!help.includes(piece)) throw new Error(`help omits "${piece}"`);
		}
	},
);

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
check("run --help exits 0", () => ax(["run", "--help"]));
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

// A set of journeys, through the bundled bin, against the mock sets server (the platform's real
// answers, checked in). Unit tests drive the commands directly; only this proves the bin routes
// `ax run set create` to a set, signs the calls and prints the served document.
check(
	"run set list with no credential is a usage error that names both ways in, before any call",
	() => {
		// A config home of its own: a sign-in stored on this machine must not answer for the check.
		const run = spawnSync(process.execPath, [BIN, "run", "set", "list"], {
			encoding: "utf8",
			env: { ...process.env, XDG_CONFIG_HOME: home, ORA_API_KEY: "" },
		});
		if (run.status !== 2) throw new Error(`exit ${run.status}, want 2`);
		if (!run.stderr.includes("ax login")) throw new Error("the error does not name ax login");
		if (!run.stderr.includes("ORA_API_KEY")) throw new Error("the error does not name the key");
	},
);

const SETS_PORT = 8798;
const mock = spawn(process.execPath, ["scripts/mock-sets-server.mjs", String(SETS_PORT)], {
	stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((ready, reject) => {
	mock.stdout.once("data", ready);
	mock.once("error", reject);
	mock.once("exit", (code) => reject(new Error(`mock sets server exited ${code}`)));
});
function axSet(args) {
	return spawnSync(process.execPath, [BIN, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			XDG_CONFIG_HOME: home,
			ORA_PLATFORM_URL: `http://localhost:${SETS_PORT}`,
			ORA_API_KEY: "ora_sk_mock",
			NO_COLOR: "1",
		},
	});
}
try {
	check("run set view --json prints the set exactly as the platform served it", () => {
		const served = JSON.parse(
			readFileSync("src/journey-set/__fixtures__/set-running.json", "utf8"),
		);
		const run = axSet(["run", "set", "view", served.setId, "--json"]);
		if (run.status !== 0) throw new Error(`exit ${run.status}: ${run.stderr}`);
		if (JSON.stringify(JSON.parse(run.stdout)) !== JSON.stringify(served))
			throw new Error("stdout is not the served document");
	});

	check(
		"run set create with two goals: the preview is printed and nothing launches without --yes",
		() => {
			const run = axSet([
				"run",
				"set",
				"create",
				"Find the API docs",
				"Find the pricing",
				"--domain",
				"linear.app",
			]);
			if (run.status !== 2) throw new Error(`exit ${run.status}, want 2`);
			if (!run.stderr.includes("a set of journeys")) throw new Error("no preview on stderr");
			if (!run.stderr.includes("Nothing was launched"))
				throw new Error("did not say nothing launched");
			if (run.stdout !== "") throw new Error("stdout is not empty");
		},
	);

	check("run set list prints each set and the next call", () => {
		const run = axSet(["run", "set", "list"]);
		if (run.status !== 0) throw new Error(`exit ${run.status}: ${run.stderr}`);
		if (!run.stdout.includes("Next: ax run set view ")) throw new Error("no Next line");
	});
} finally {
	mock.removeAllListeners("exit");
	mock.kill();
}

if (failures.length > 0) {
	console.error(`\nsmoke failed (${failures.length}):`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log("\nsmoke passed");
