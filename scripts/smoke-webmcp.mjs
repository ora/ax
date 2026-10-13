#!/usr/bin/env node
// End-to-end smoke for `ax webmcp-audit`, against the bundled binary.
//
//   pnpm build && node scripts/smoke-webmcp.mjs
//
// What this covers that the unit tests structurally cannot: the whole chain in
// one process, driven the way a user drives it. It launches a real Chrome,
// captures a real page over CDP, posts the capture to the mock ingest server,
// and renders the reply. A break anywhere in that chain - the launcher, the
// three passes, the SSE reader, the report - fails here, and none of it is
// reachable from a test that stubs the browser or the network.
//
// It does NOT need ora: `scripts/mock-webmcp-ingest.mjs` replays the checked-in
// real ingest fixture. That makes the response fixed, so this asserts on the
// chain working rather than on any particular score.
//
// Needs a Chrome on the machine. In a container, set AX_WEBMCP_NO_SANDBOX=1.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist/main.cjs");
const MOCK_PORT = 8897;
const PAGE_PORT = 8898;

/** A page that registers one tool the way a real site does: feature-detected,
 * so it only registers once the capture shim has installed the API. */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ax smoke</title></head>
<body><h1>Catalogue</h1>
<form id="search"><label for="q">Search</label><input id="q" name="q"></form>
<script type="module">
  const mc = document.modelContext ?? navigator.modelContext;
  if (mc) {
    mc.registerTool({
      name: "search_books",
      description: "Search the catalogue by title or author and return matches.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      annotations: { readOnlyHint: true },
      async execute({ query }) { return { content: [{ type: "text", text: "no results for " + query }] }; },
    });
  }
</script></body></html>`;

/** Output as one plain, whitespace-collapsed string - see the call sites. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
const ANSI = /\u001b\[[0-9;]*m/g;
const flat = (text) => text.replace(ANSI, "").replace(/\s+/g, " ");

let failures = 0;
function check(label, condition, detail = "") {
	if (condition) {
		console.log(`  ok    ${label}`);
	} else {
		failures++;
		console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
	}
}

function run(args, env) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [BIN, ...args], {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += c;
		});
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

const pageServer = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(PAGE);
});

// Mock stdout is captured, not ignored: its `received:` lines are the only
// evidence of what the capture actually produced. The reply is a fixed fixture
// describing a different site, so nothing in the report proves the browser ran.
let mockLog = "";
const mock = spawn(
	process.execPath,
	[join(ROOT, "scripts/mock-webmcp-ingest.mjs"), String(MOCK_PORT)],
	{ stdio: ["ignore", "pipe", "ignore"] },
);
mock.stdout.on("data", (chunk) => {
	mockLog += chunk;
});

async function main() {
	await new Promise((resolve) => pageServer.listen(PAGE_PORT, "127.0.0.1", resolve));
	// The mock binds immediately; a short wait is enough and keeps this from
	// racing the first request on a cold runner.
	await new Promise((resolve) => setTimeout(resolve, 1000));

	const target = `http://127.0.0.1:${PAGE_PORT}/`;
	const env = { ORA_API_URL: `http://127.0.0.1:${MOCK_PORT}` };

	console.log(`\nsmoke: ${BIN} webmcp-audit (real Chrome, mock ingest)\n`);

	const report = await run(["webmcp-audit", target], env);
	check(
		"exits 0 on a page that registers a tool",
		report.code === 0,
		`exit ${report.code}\n${report.stderr.slice(0, 400)}`,
	);
	check("renders the availability verdict", /agent-ready/.test(flat(report.stdout)));
	check("renders the pillars", /Pillars/.test(flat(report.stdout)));
	// Collapsed AND stripped of colour: the footer is wrapped prose, so a phrase
	// can straddle a line, and the report colours whole lines - picocolors emits
	// SGR escapes on a CI runner and not in a plain pipe, so a raw match passes
	// locally and fails in CI.
	check(
		"never calls a local audit published or ranked",
		/not published or ranked/.test(flat(report.stdout)),
	);

	const json = await run(["webmcp-audit", target, "--json"], env);
	check("--json exits 0", json.code === 0, `exit ${json.code}`);
	let payload = null;
	try {
		payload = JSON.parse(json.stdout);
	} catch {
		// Left null; the assertion below reports it.
	}
	check("--json emits the payload and nothing else", payload !== null);
	check(
		"--json payload carries the availability verdict",
		payload?.availability?.status !== undefined,
	);

	// What was SENT, from the mock's own log. The report above describes the
	// fixture's site, so it cannot show whether the browser found anything.
	check("the capture reached ora", /received: /.test(mockLog), mockLog.slice(0, 200));
	check("it captured the page it was pointed at", mockLog.includes(`url=${target}`));
	check(
		"it captured one page and found the page's tool",
		/pages=1 tools=1 \[search_books\]/.test(mockLog),
		mockLog.slice(0, 300),
	);
	check("it pinned the shim version the endpoint expects", /shim=3\b/.test(mockLog));
	check("it sent the screenshot page-experience needs", /screenshot=yes/.test(mockLog));

	const gate = await run(["webmcp-audit", target, "--min-score", "101"], env);
	check("rejects a --min-score outside 0-100 as usage", gate.code === 2);

	const noChrome = await run(["webmcp-audit", target, "--chrome-endpoint", "127.0.0.1:1"], env);
	check("exits 2 when the named Chrome does not answer", noChrome.code === 2);
	check(
		"says how to start one, never how to download one",
		/remote-debugging-port/.test(flat(noChrome.stderr)) &&
			!/playwright|puppeteer/i.test(noChrome.stderr),
	);

	console.log(failures === 0 ? "\nwebmcp smoke passed\n" : `\nwebmcp smoke FAILED (${failures})\n`);
}

main()
	.catch((err) => {
		console.error(err);
		failures++;
	})
	.finally(() => {
		mock.kill();
		pageServer.close();
		process.exitCode = failures === 0 ? 0 : 1;
	});
