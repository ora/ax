// Compares the regenerated contract in src/contract/ (run `pnpm contract:gen`
// first) against the committed one and reports what kind of drift it is:
//
//   none      production matches the committed contract.
//   docs      only comments changed (spec descriptions reworded). Exit 0 with a
//             warning: worth a sync PR, not a red build.
//   contract  a type or the pinned contract version changed. Exit 1: ax may be
//             out of step with what ora.ai now serves.
//
// Usage:
//   pnpm contract:gen && pnpm contract:drift            # exit 1 on contract drift
//   pnpm contract:gen && pnpm contract:drift --report   # always exit 0
//
// In GitHub Actions it also writes `drift=<kind>` and `version=<x.y.z>` to
// $GITHUB_OUTPUT so a later step can branch on them.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDrift } from "./contract-drift-lib.mjs";

const FILES = ["src/contract/types.gen.ts", "src/contract/version.ts"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reportOnly = process.argv.includes("--report");

const files = FILES.map((path) => ({
	committed: execFileSync("git", ["show", `HEAD:${path}`], { cwd: root, encoding: "utf8" }),
	generated: readFileSync(join(root, path), "utf8"),
}));

const drift = classifyDrift(files);
const version = /BUILT_AGAINST = "([^"]+)"/.exec(files[1].generated)?.[1] ?? "unknown";

if (process.env.GITHUB_OUTPUT) {
	appendFileSync(process.env.GITHUB_OUTPUT, `drift=${drift}\nversion=${version}\n`);
}

const annotate = process.env.GITHUB_ACTIONS === "true";
if (drift === "none") {
	console.log(`contract:drift: none - src/contract/ matches production (${version})`);
} else if (drift === "docs") {
	const message = `contract:drift: docs only - production reworded spec descriptions (${version}); no type changed. Run pnpm contract:gen and commit to sync.`;
	console.log(annotate ? `::warning title=Contract docs drift::${message}` : message);
} else {
	const message = `contract:drift: contract - production's types or version differ from src/contract/ (now ${version}). Run pnpm contract:gen, review the diff and commit.`;
	console.log(annotate ? `::error title=Contract drift::${message}` : message);
}

execFileSync("git", ["diff", "--stat", "--", ...FILES], { cwd: root, stdio: "inherit" });

if (drift === "contract" && !reportOnly) process.exit(1);
