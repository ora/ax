#!/usr/bin/env node
// Tiny local stand-in for ora's sets API (`/ax/v1`), for manual CLI testing of a set of
// journeys without an ora account and without starting real agent runs:
//
//   node scripts/mock-sets-server.mjs [port] [mode]      # default 8798
//   ORA_PLATFORM_URL=http://localhost:8798 ORA_API_KEY=ora_sk_mock \
//     node dist/main.cjs journey "Find the API docs" "Find the pricing" --domain linear.app --yes
//
// Serves:
//   POST /auth/token                 the key exchange (any key is accepted)
//   POST /ax/v1/sets/preview         the plan of a set; nothing is created
//   POST /ax/v1/sets                 a set, just created
//   GET  /ax/v1/sets                 the organization's sets
//   GET  /ax/v1/sets/:id             the set: running on the first read, complete after it
//   POST /ax/v1/sets/:id/cancel      { setId, cancelled: true }
//
// The set bodies are checked-in captures of the real platform's answers
// (src/journey-set/__fixtures__/), served untouched; the cancel and refusal bodies are the
// platform's own, copied from its source. `mode` reaches the refusals:
//   over      the preview plans more runs than the caller's plan has left
//   product   403 PRODUCT_REQUIRED, the organization does not hold the product
//   down      503 ENGINE_UNAVAILABLE on every sets call

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] ?? 8798);
const MODE = process.argv[3] ?? "ok";
const FIXTURES = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"journey-set",
	"__fixtures__",
);
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

const REFUSALS = {
	product: [
		403,
		{
			error: "Set engine",
			code: "PRODUCT_REQUIRED",
			message:
				"This organization does not have the product a set of journeys runs on. An owner or admin of the organization can add it on the approval page when signing a tool in to it; then run this again.",
		},
	],
	down: [
		503,
		{
			error: "Set engine",
			code: "ENGINE_UNAVAILABLE",
			message:
				"The platform could not answer. Nothing was changed by this request if it was a read; check the set before retrying a write.",
		},
	],
};

function send(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

let reads = 0;

const server = createServer((req, res) => {
	const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
	const route = `${req.method} ${pathname}`;

	if (route === "POST /auth/token") return send(res, 200, { token: "mock-bearer" });
	if (!pathname.startsWith("/ax/v1/")) return send(res, 404, { error: "not found" });
	if (REFUSALS[MODE]) return send(res, ...REFUSALS[MODE]);

	if (route === "POST /ax/v1/sets/preview") {
		const preview = fixture("preview");
		if (MODE === "over") preview.runs = { ...preview.runs, left: 3, fits: false };
		return send(res, 200, preview);
	}
	if (route === "POST /ax/v1/sets") return send(res, 201, fixture("set-created"));
	if (route === "GET /ax/v1/sets") return send(res, 200, fixture("list"));
	if (req.method === "GET" && pathname.startsWith("/ax/v1/sets/")) {
		reads += 1;
		return send(res, 200, fixture(reads === 1 ? "set-running" : "set-complete"));
	}
	if (req.method === "POST" && pathname.endsWith("/cancel")) {
		return send(res, 200, { setId: pathname.split("/")[4], cancelled: true });
	}
	return send(res, 404, { error: "Not Found", code: "SET_NOT_FOUND", message: "No such set." });
});

server.listen(PORT, () => {
	console.log(`mock ora sets API on http://localhost:${PORT} (mode: ${MODE})`);
	console.log(
		`try: ORA_PLATFORM_URL=http://localhost:${PORT} ORA_API_KEY=ora_sk_mock node dist/main.cjs journey list`,
	);
});
