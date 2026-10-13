#!/usr/bin/env node
// Tiny local stand-in for ora's WebMCP ingest endpoint, for manual CLI testing
// without burning the live rate limits (10/min/IP, 20 per 24h):
//
//   node scripts/mock-webmcp-ingest.mjs [port]        # default 8798
//   ORA_API_URL=http://localhost:8798 node dist/main.cjs webmcp-audit http://localhost:3000
//
// Serves:
//   POST /api/webmcp/audit/ingest   data-only SSE: phase/tool-discovered/finding
//                                   progress, then a terminal `done` frame
//
// The audit it answers with is the checked-in real payload at
// src/webmcp/__fixtures__/local-catalogue-audit.json - this CLI's own capture of
// the smoke page, run through ora's real admission, engine and projection. It is
// a FIXED response: the capture you post is validated for shim version and size,
// but the score you get back describes that page, not yours.
//
// Failure paths, to exercise the CLI's branches. Pass the mode as the second
// argument - NOT as a query string on ORA_API_URL, which the client treats as
// an origin and concatenates the path onto:
//
//   node scripts/mock-webmcp-ingest.mjs 8798 shim      400 SHIM_VERSION_MISMATCH
//   node scripts/mock-webmcp-ingest.mjs 8798 rate      429 + retry_after_ms
//   node scripts/mock-webmcp-ingest.mjs 8798 scoring   503 SCORING_UNAVAILABLE
//   node scripts/mock-webmcp-ingest.mjs 8798 stream    progress, then no terminal frame

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] ?? 8798);
/** Failure mode for every request this instance serves; empty means succeed. */
const FAIL_MODE = process.argv[3] ?? "";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_SHIM = "3";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function loadAudit() {
	const raw = readFileSync(
		join(ROOT, "src/webmcp/__fixtures__/local-catalogue-audit.json"),
		"utf8",
	);
	return JSON.parse(raw).audit;
}

function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function openStream(res) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	return (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

const server = createServer((req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);
	if (req.method !== "POST" || url.pathname !== "/api/webmcp/audit/ingest") {
		return sendJson(res, 404, { error: "not found" });
	}

	const fail = FAIL_MODE || url.searchParams.get("fail");
	if (fail === "rate") {
		res.setHeader("retry-after", "42");
		return sendJson(res, 429, {
			error: "rate limit exceeded",
			bucket: "webmcp.audit_ingest",
			retry_after_ms: 42_000,
		});
	}
	if (fail === "scoring") {
		return sendJson(res, 503, {
			code: "SCORING_UNAVAILABLE",
			error: "no model credentials configured",
		});
	}

	const chunks = [];
	let bytes = 0;
	let aborted = false;
	req.on("data", (chunk) => {
		bytes += chunk.length;
		if (bytes > MAX_BODY_BYTES) {
			aborted = true;
			sendJson(res, 413, { code: "BODY_TOO_LARGE", error: "capture exceeds 4 MB" });
			req.destroy();
			return;
		}
		chunks.push(chunk);
	});

	req.on("end", () => {
		if (aborted) return;
		let body;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return sendJson(res, 400, { code: "MALFORMED_BODY", error: "body is not JSON" });
		}
		if (!body || typeof body !== "object" || typeof body.url !== "string") {
			return sendJson(res, 400, { code: "INVALID_URL", error: "url is missing or malformed" });
		}
		const capture = body.capture;
		if (!capture || typeof capture !== "object") {
			return sendJson(res, 400, { code: "INVALID_CAPTURE", error: "capture must be an object" });
		}
		const shim = fail === "shim" ? "999" : capture.shimVersion;
		if (shim !== EXPECTED_SHIM) {
			return sendJson(res, 400, {
				code: "SHIM_VERSION_MISMATCH",
				error: `This capture was taken by shim version ${shim}, and this server scores version ${EXPECTED_SHIM}. Upgrade the CLI and capture again.`,
			});
		}

		// One line per accepted capture, so a caller can assert on what was SENT.
		// The reply is a fixed fixture describing another site, so it says nothing
		// about the page that was actually captured.
		const pages = Array.isArray(capture.pages) ? capture.pages : [];
		const toolNames = pages.flatMap((page) => (page.tools ?? []).map((tool) => tool.name));
		console.log(
			`received: url=${body.url} shim=${capture.shimVersion} pages=${pages.length} tools=${toolNames.length}${toolNames.length ? ` [${toolNames.join(",")}]` : ""} screenshot=${capture.screenshot ? "yes" : "no"}`,
		);

		const audit = loadAudit();
		const send = openStream(res);
		send({ type: "phase", phase: "checks" });
		for (const page of capture.pages ?? []) {
			send({
				type: "page-captured",
				path: new URL(page.url).pathname,
				toolCount: (page.tools ?? []).length,
				verdict: page.verdict,
			});
			for (const tool of page.tools ?? []) send({ type: "tool-discovered", tool });
		}
		for (const finding of audit.findings ?? []) send({ type: "finding", finding });
		if (fail === "stream") {
			// No terminal frame: the CLI must refuse to call this a passing audit.
			return res.end();
		}
		send({ type: "phase", phase: "persist" });
		send({ type: "done", audit });
		res.end();
	});
});

server.listen(PORT, () => {
	console.log(
		`mock webmcp ingest on http://localhost:${PORT}${FAIL_MODE ? ` (fail=${FAIL_MODE})` : ""}`,
	);
	console.log(`  ORA_API_URL=http://localhost:${PORT} node dist/main.cjs webmcp-audit <url>`);
});
