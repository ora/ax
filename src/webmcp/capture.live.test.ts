/**
 * The one test that drives a real browser.
 *
 * Skipped unless `AX_WEBMCP_LIVE=1`, because it drives a real browser that CI
 * does not have. It is the manual-verification harness for the capture:
 *
 *   AX_WEBMCP_LIVE=1 pnpm test src/webmcp/capture.live.test.ts
 *
 * It launches its own Chrome the same way the command does - no flags, a
 * throwaway profile, stopped again afterwards - so there is nothing to start
 * first. Set `AX_WEBMCP_CHROME` to a `host:port` to drive one you started
 * instead.
 *
 * The page it serves is a target, not a payload fixture: it exists to make the
 * browser register a tool. Every value the audit is graded on still comes from
 * a real capture of it.
 *
 * Note what this asserts about pass A. It reads `nativeApi` AFTER the page's
 * scripts have run, so it is true when the browser provides WebMCP and ALSO
 * when the page installs a polyfill; only then does it ask the native
 * `getTools()` how many tools it accepted. The target page below does neither,
 * so on a stock Chrome `nativeApi` must be false and `nativeToolCount` null -
 * the same answer ora's capture browser gives. A Chrome started with `--enable-features=WebMCPTesting` answers true
 * and flips the page verdict from `testing-only` to `active`, which is the
 * local-vs-published divergence `webmcpParityWarning` exists to catch, so this
 * test failing on `nativeApi` most likely means the wrong Chrome is on the port.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureLocally } from "./capture";
import type { BrowserEndpoint } from "./cdp";
import { discoverEndpoint } from "./cdp";
import { launchChrome } from "./chrome";

const LIVE = process.env.AX_WEBMCP_LIVE === "1";
const ENDPOINT = process.env.AX_WEBMCP_CHROME ?? "";

/** A page that registers one imperative tool on `document.modelContext`, the
 * canonical entry point. Feature-detected, so it only registers once the shim
 * has installed the API - which is what makes pass B the only pass that sees
 * it, exactly as on a real site. */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ax capture target</title></head>
<body><h1>Search</h1><form id="f"><label for="q">Query</label><input id="q" name="q"></form>
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

/**
 * Ceiling for the setup hook. Vitest's default is 10s, which is fine for the
 * page server and NOT for launching Chrome on a cold CI runner - measured at
 * over 10s there, while a warm local machine does it in about two. The `it`
 * timeouts below do not cover a hook, so this has to be its own.
 */
const HOOK_TIMEOUT_MS = 90_000;

describe.skipIf(!LIVE)("captureLocally against a real Chrome", () => {
	// Both undefined until `beforeAll` finishes. A hook that times out still runs
	// `afterAll`, so teardown must not assume either exists.
	let server: Server | undefined;
	let url: string;
	let endpoint: BrowserEndpoint;
	let stopChrome: () => Promise<void> = async () => {};

	beforeAll(async () => {
		if (ENDPOINT) {
			endpoint = await discoverEndpoint(ENDPOINT);
		} else {
			const chrome = await launchChrome();
			endpoint = chrome.endpoint;
			stopChrome = chrome.close;
		}
		// Assigned to a local first, so the rest of the hook is not narrowing the
		// possibly-undefined field it has to leave behind for teardown.
		const listener = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(PAGE);
		});
		server = listener;
		await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(listener.address() as { port: number }).port}/`;
	}, HOOK_TIMEOUT_MS);

	afterAll(async () => {
		// Guarded, and the browser is stopped even if the server never started:
		// throwing here would replace the real failure with a teardown error and
		// leak a Chrome. `stopChrome` is a no-op until the launch succeeded.
		if (server) await new Promise((resolve) => server?.close(resolve));
		await stopChrome();
	}, HOOK_TIMEOUT_MS);

	it("finds the tool the page registers, and reports the browser honestly", async () => {
		const capture = await captureLocally({ url, endpoint });

		// Pinned deliberately, not read from the constant: "3" is the wire
		// contract, and the ingest endpoint rejects anything else with 400
		// SHIM_VERSION_MISMATCH. Re-vendoring a different shim should fail here
		// loudly rather than at the first user's request.
		expect(capture.shimVersion).toBe("3");
		// Bare build number, the spelling ora's own captures carry (Playwright's
		// `browser.version()`); `/json/version` prefixes it with "Chrome/" and the
		// CDP client strips that, so the two corpora agree.
		expect(capture.chromeVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
		expect(capture.pages).toHaveLength(1);

		const page = capture.pages[0];
		expect(page.error).toBeNull();

		// Pass B: the shim installed the API, the page feature-detected it, and
		// the tool registered. This is the only pass that can see any of it.
		expect(page.tools.map((t) => t.name)).toEqual(["search_books"]);
		const tool = page.tools[0];
		expect(tool.via).toBe("imperative");
		expect(tool.entryPoint).toBe("document");
		expect(tool.hasExecute).toBe(true);
		expect(tool.annotations.readOnlyHint).toBe(true);
		// Timed from navigation, so a registration that happened is a number.
		expect(typeof tool.registrationMs).toBe("number");

		// Pass A: no shim and no polyfill on the page, so this is the browser's
		// own answer. False here means the capturing Chrome matches ora's.
		expect(page.consumer.nativeApi).toBe(false);
		expect(page.consumer.nativeToolCount).toBeNull();
		expect(page.verdict).toBe("testing-only");

		// Pass C: the inline module reaches document.modelContext, read off the
		// live DOM rather than through cheerio.
		expect(page.staticSignals.imperative).toEqual({
			marker: "document.modelContext.registerTool",
			deprecatedAliasOnly: false,
			removedApiOnly: false,
		});

		// The entry-page screenshot, at the viewport ora captures at. Without it
		// `page-experience` comes back unmeasured and evidence coverage drops.
		expect(capture.screenshot?.mimeType).toBe("image/jpeg");
		expect(capture.screenshot?.width).toBe(1280);
		expect(capture.screenshot?.height).toBe(720);
		expect((capture.screenshot?.data.length ?? 0) > 0).toBe(true);
	}, 90_000);

	it("reports a page it could not load as an error, never as an absent surface", async () => {
		// The failure ora's engine cares most about: a capture that could not
		// look must never be reported as proof that a site has no WebMCP.
		const capture = await captureLocally({
			url: "http://127.0.0.1:1/",
			endpoint,
			screenshot: false,
		});
		const page = capture.pages[0];
		expect(page.error).not.toBeNull();
		expect(page.verdict).toBe("load-error");
		expect(page.tools).toEqual([]);
	}, 90_000);
});
