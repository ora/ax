/**
 * The local side of `ax webmcp-audit`: open the developer's page in a Chrome
 * they already have and produce the same `WebmcpCaptureResult` ora's worker
 * produces, so the audit that runs against localhost and the one that runs
 * against the published site are reading the same measurement.
 *
 * Three passes per page, in this order and for these reasons - the same order,
 * the same reasons, and the same in-page code as ora's `capture-server.ts`:
 *   A. Consumer reality, with NO shim. Whatever this pass sees is what a real
 *      browser sees: a `modelContext` the page did not need us to install, an
 *      origin-trial token, the `Permissions-Policy` header. Pass B cannot
 *      answer any of these, because the shim REPLACES the native entry points
 *      before page scripts run.
 *   B. Developer diagnostic, WITH the shim. Sites feature-detect, so tools only
 *      register when `modelContext` already exists. This pass is the only one
 *      that ever sees them.
 *   C. Static evidence, over pass A's HTML and the scripts pass A loaded.
 *
 * What this file is NOT allowed to do: decide anything. Every value that
 * reaches the wire is produced by the copies under `vendor/` - the shim, the
 * verdict ladder, the static signals, the annotation mapping. This file is the
 * plumbing that runs them: budgets, the CDP session, and the single page. If a
 * judgement appears here, it is a bug, because ora's copy of that judgement is
 * the one that scores the published site.
 *
 * Deliberately narrower than ora's service, all of it plumbing:
 *   - One page (the entry page), not up to ten.
 *   - No address-space guard: the developer names a URL on their own machine
 *     and reaching localhost is the point.
 *   - No health circuit, no concurrency slots, no request-budget accounting.
 *     One developer, one page, one browser.
 */

import { type BrowserEndpoint, CdpBrowser, type CdpPage } from "./cdp";
import {
	CAPTURE_INCOMPLETE_PREFIX,
	deriveStatus,
	deriveVerdict,
	evaluateOriginTrial,
	parseOriginTrialHeader,
	type WebmcpPageFacts,
} from "./vendor/capture-verdict";
import { WEBMCP_SHIM_VERSION } from "./vendor/checks";
import { isSecurityChallenge } from "./vendor/security-challenge";
import {
	DECLARATIVE_SCAN_SNIPPET,
	WEBMCP_CAPTURE_SHIM,
	type WebmcpShimDeclarativeScan,
	type WebmcpShimSnapshot,
	type WebmcpShimToolRecord,
} from "./vendor/shim";
import { collectStaticSignals } from "./vendor/static-signals";
import type {
	WebmcpCaptureResult,
	WebmcpPageCapture,
	WebmcpScreenshot,
	WebmcpStaticSignals,
	WebmcpTool,
	WebmcpToolAnnotations,
} from "./vendor/types";

// ---------------------------------------------------------------------------
// Budgets - the same numbers ora's capture service applies
// ---------------------------------------------------------------------------

const NAV_TIMEOUT_MS = 15_000;
const PAGE_BUDGET_MS = 30_000;

/** Registration quiet window: once no new registration has landed for this
 * long, the page is done registering. */
const QUIET_WINDOW_MS = 2_000;
const QUIET_POLL_MS = 250;
/** Before the first registration, silence is not a quiet window: hydration may
 * not have reached the registering bundle yet. Wait this long for the first
 * arrival, then apply the ordinary two-second quiet rule. */
const INITIAL_REGISTRATION_WAIT_MS = { fast: 5_000, deep: 10_000 } as const;
/** Ceiling on the quiet wait, per mode. `deep` buys a longer tail for sites
 * that register behind a slow hydration chain. */
const MAX_QUIET_WAIT_MS = { fast: 12_000, deep: 20_000 } as const;

const MAX_HTML_CHARS = 2 * 1024 * 1024;
/** Tool names are page-controlled and reach the payload verbatim. */
const MAX_TOOL_NAME_CHARS = 512;
/** Shim v1 carries a tool's human label only inside `annotations`; there is no
 * `title` on the tool itself. Same ceiling ora's capture service applies. */
const MAX_ANNOTATION_TITLE_CHARS = 512;

const SCREENSHOT_JPEG_QUALITY = 60;
const MAX_SCREENSHOT_BYTES = 1_500_000;

/**
 * ora sets no viewport, so its capture runs at Playwright's default. Pinning
 * the same size here is what keeps the entry-page screenshot - and therefore
 * the `page-experience` grade - comparable between a local run and ora.ai.
 */
const VIEWPORT = { width: 1280, height: 720 };

const EMPTY_STATIC_SIGNALS: WebmcpStaticSignals = {
	imperative: null,
	polyfillPackages: [],
	keywordMention: false,
};

export type WebmcpCaptureMode = "fast" | "deep";

// ---------------------------------------------------------------------------
// In-page expressions - copied from ora's capture-server.ts, verbatim
// ---------------------------------------------------------------------------

/** Pass A only. Reads the NATIVE surface, which is why no shim may be
 * installed in this context. */
const PASS_A_PROBE = `(function () {
  var tokens = [];
  try {
    var metas = document.querySelectorAll('meta[http-equiv="origin-trial" i]');
    for (var i = 0; i < metas.length && tokens.length < 20; i++) {
      var content = metas[i].getAttribute("content");
      if (content) tokens.push(content);
    }
  } catch (e) {
    // A document without a queryable DOM still answers the native probe.
  }
  var nativeApi = false;
  try {
    nativeApi = Boolean(document.modelContext || navigator.modelContext);
  } catch (e) {
    // A hostile getter on either global; absence is the honest answer.
  }
  return { nativeApi: nativeApi, metaTokens: tokens };
})()`;

/** Native acceptance probe. API existence alone is not enough: getTools() is
 * the page-visible registry defined by the current draft. The Promise result
 * is returned directly so the evaluation waits for enumeration to settle. */
const NATIVE_TOOL_COUNT_EXPRESSION = `(async function () {
  try {
    var modelContext = document.modelContext || navigator.modelContext;
    if (!modelContext || typeof modelContext.getTools !== "function") return null;
    var tools = await modelContext.getTools();
    return tools && typeof tools.length === "number" ? tools.length : null;
  } catch (e) {
    return null;
  }
})()`;

/** The shim's results global is non-writable and non-configurable, so a page
 * cannot swap `snapshot` for one that reports tools it does not have. It can
 * still make the call throw, which is what the catch covers. */
const SNAPSHOT_EXPRESSION = `(function () {
  try {
    var g = window.__oraWebmcpCapture;
    return g ? g.snapshot() : null;
  } catch (e) {
    return null;
  }
})()`;

/** Cheap change detector for the quiet loop: counters only, so polling does
 * not ship every schema across the CDP boundary four times a second. */
const FINGERPRINT_EXPRESSION = `(function () {
  try {
    var g = window.__oraWebmcpCapture;
    if (!g) return "none";
    var s = g.snapshot();
    return s.tools.length + ":" + s.provideContextCalls + ":" + s.toolchangeEvents + ":" +
      s.registrationErrors.length + ":" + s.extraToolCount + ":" + s.takenOver.length;
  } catch (e) {
    return "error";
  }
})()`;

// ---------------------------------------------------------------------------
// Mapping shim records onto the contract - copied from ora, verbatim
// ---------------------------------------------------------------------------

/**
 * Live tools only. The shim marks a tool that was unregistered rather than
 * dropping it, but `WebmcpTool` has no slot for that state, and listing a
 * retired tool as registered would misreport what an agent would find.
 */
function mapShimTools(records: WebmcpShimToolRecord[], pageUrl: string): WebmcpTool[] {
	return records
		.filter((record) => !record.unregistered)
		.map((record) => ({
			name: record.name.slice(0, MAX_TOOL_NAME_CHARS),
			description: record.description,
			via: "imperative" as const,
			// The contract's four-value entry point is the pair the shim records:
			// which global the page reached for, unless it went through
			// provideContext, which is itself the interesting fact.
			entryPoint:
				record.source === "provideContext" ? ("provideContext" as const) : record.entryPoint,
			pageUrl,
			inputSchema: record.inputSchema,
			annotations: mapAnnotations(record.annotations),
			hasExecute: record.hasExecute,
			registrationMs: record.registrationMs,
		}));
}

function mapDeclarativeTools(
	forms: WebmcpShimDeclarativeScan["forms"],
	pageUrl: string,
): WebmcpTool[] {
	return forms.map((form) => ({
		name: form.toolName.slice(0, MAX_TOOL_NAME_CHARS),
		description: form.toolDescription,
		via: "declarative" as const,
		entryPoint: "form" as const,
		pageUrl,
		// A declarative tool declares no JSON Schema; its inputs are the form's
		// own fields. Reporting `null` keeps the schema checks from grading a
		// schema the page never claimed to have.
		inputSchema: null,
		annotations: {},
		// Declarative execution is the browser submitting the element, not a JS
		// callback, so there is no stub axis here to fail.
		hasExecute: true,
		// Declarative tools are in the markup from the first paint; there is no
		// registration moment to time.
		registrationMs: null,
	}));
}

/** Page-supplied annotations, narrowed to the contract's keys. Untrusted
 * metadata: copied by shape, never trusted as a claim about behaviour. */
function mapAnnotations(raw: unknown): WebmcpToolAnnotations {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const out: WebmcpToolAnnotations = {};
	for (const key of [
		"readOnlyHint",
		"destructiveHint",
		"idempotentHint",
		"openWorldHint",
		"untrustedContentHint",
	] as const) {
		if (typeof record[key] === "boolean") out[key] = record[key] as boolean;
	}
	if (typeof record.title === "string") {
		out.title = record.title.slice(0, MAX_ANNOTATION_TITLE_CHARS);
	}
	return out;
}

/**
 * The page's own registration errors, plus the capture's honesty notes.
 *
 * Notes carry `CAPTURE_INCOMPLETE_PREFIX` because they describe OUR blind
 * spots, not the site's defects - a page shipping its own `modelContext`
 * polyfill is legitimate, and scoring it as a stability failure would be wrong.
 */
function buildRegistrationErrors(snapshot: WebmcpShimSnapshot | null): string[] {
	if (!snapshot) return [];
	const errors = [...snapshot.registrationErrors];
	if (snapshot.takenOver.length > 0) {
		errors.push(
			`${CAPTURE_INCOMPLETE_PREFIX} the page replaced modelContext on ${snapshot.takenOver.join(", ")}, so imperative tools may be under-reported`,
		);
	}
	if (snapshot.extraToolCount > 0) {
		errors.push(
			`${CAPTURE_INCOMPLETE_PREFIX} the capture's tool cap was reached and ${snapshot.extraToolCount} further registration attempts were not stored`,
		);
	}
	return errors;
}

/**
 * Whether the page's `Permissions-Policy` delegates the `tools` feature to
 * embedded frames. `null` means the page declared nothing about it, which is
 * a different fact from declaring it closed.
 */
export function deriveIframeAllow(permissionsPolicy: string | null): boolean | null {
	if (!permissionsPolicy) return null;
	for (const directive of permissionsPolicy.split(",")) {
		const match = /^\s*([a-z0-9-]+)\s*=\s*(.*)$/i.exec(directive);
		if (!match) continue;
		if (match[1].toLowerCase() !== "tools") continue;
		const allowlist = match[2]
			.trim()
			.replace(/^\(|\)$/g, "")
			.trim();
		if (allowlist === "*") return true;
		if (allowlist === "" || allowlist.toLowerCase() === "self") return false;
		// Anything else names at least one origin beyond the page itself.
		return allowlist
			.split(/\s+/)
			.some((entry) => entry.toLowerCase() !== "self" && entry.length > 0);
	}
	return null;
}

// ---------------------------------------------------------------------------
// The passes
// ---------------------------------------------------------------------------

interface PassAResult {
	finalUrl: string;
	navMs: number;
	blocked: boolean;
	nativeApi: boolean;
	nativeToolCount: number | null;
	originTrialTokens: string[];
	permissionsPolicy: string | null;
	html: string;
	inlineJs: string;
	scripts: Array<{ url: string; body: string }>;
	screenshot: WebmcpScreenshot | null;
	loadError: string | null;
}

interface PassBResult {
	snapshot: WebmcpShimSnapshot | null;
	declarative: WebmcpShimDeclarativeScan | null;
	quietMs: number;
	loadError: string | null;
}

/**
 * Pass A: no shim, so everything it reports is what a real browser would do.
 * It also supplies the HTML and script bodies pass C reads, taken from the
 * unshimmed load on purpose - the static evidence has to describe the page as
 * shipped, not the page as our shim provoked it.
 */
async function runPassA(
	browser: CdpBrowser,
	url: string,
	mode: WebmcpCaptureMode,
	deadline: number,
	wantScreenshot: boolean,
): Promise<PassAResult> {
	const navStart = Date.now();
	const empty: PassAResult = {
		finalUrl: url,
		navMs: 0,
		blocked: false,
		nativeApi: false,
		nativeToolCount: null,
		originTrialTokens: [],
		permissionsPolicy: null,
		html: "",
		inlineJs: "",
		scripts: [],
		screenshot: null,
		loadError: null,
	};

	let page: CdpPage | null = null;
	try {
		// No init scripts: pass A's whole claim is that nothing we did shaped
		// what it saw.
		page = await browser.newContext({ entryUrl: url, viewport: VIEWPORT });

		let response: Awaited<ReturnType<CdpPage["goto"]>>;
		try {
			response = await page.goto(url, boundedTimeout(deadline, NAV_TIMEOUT_MS));
		} catch (err) {
			return { ...empty, navMs: Date.now() - navStart, loadError: describeError(err) };
		}
		const navMs = Date.now() - navStart;

		// Give late scripts a bounded chance to arrive so pass C sees the bundles
		// a static crawler would fetch. Failing to reach `load` is normal on sites
		// that keep a connection open, so a timeout here is not an error.
		await page.waitForLoad(boundedTimeout(deadline, 5_000));

		const headers = response?.headers ?? {};
		const status = response?.status ?? 0;
		const html = (await page.content()).slice(0, MAX_HTML_CHARS);
		// ora derives this with cheerio inside collectStaticSignals; we read the
		// same selector off the live DOM. See vendor/static-signals.ts.
		const inlineJs = await page.inlineScripts();

		const probe = ((await page
			.evaluate<{ nativeApi?: unknown; metaTokens?: unknown }>(PASS_A_PROBE)
			.catch(() => null)) ?? {}) as { nativeApi?: unknown; metaTokens?: unknown };
		const nativeApi = probe.nativeApi === true;
		const nativeToolCount = nativeApi
			? await waitForNativeToolRegistration(page, mode, deadline)
			: null;

		// Taken from THIS pass on purpose: no shim, so the picture is the page as
		// a person's browser renders it, cookie banners and all.
		const screenshot = wantScreenshot ? await takeScreenshot(page, deadline) : null;

		return {
			finalUrl: page.url(),
			navMs,
			blocked: isSecurityChallenge(status, headers, html),
			nativeApi,
			nativeToolCount,
			originTrialTokens: [
				...parseOriginTrialHeader(headers["origin-trial"]),
				...(Array.isArray(probe.metaTokens) ? (probe.metaTokens as string[]) : []),
			],
			permissionsPolicy: headers["permissions-policy"] ?? null,
			html,
			inlineJs,
			scripts: page.collectedScripts(),
			screenshot,
			loadError: null,
		};
	} catch (err) {
		return { ...empty, navMs: Date.now() - navStart, loadError: describeError(err) };
	} finally {
		await page?.close();
	}
}

/**
 * Pass B: the shim is installed before any page script, so a site that only
 * registers when `modelContext` already exists finally does. The wait is
 * DOMContentLoaded, then a quiet window with no new registrations, capped - a
 * page that keeps churning must not hold the budget open.
 */
async function runPassB(
	browser: CdpBrowser,
	url: string,
	mode: WebmcpCaptureMode,
	deadline: number,
	onTools?: (tools: WebmcpTool[]) => void,
): Promise<PassBResult> {
	let page: CdpPage | null = null;
	try {
		page = await browser.newContext({
			initScripts: [WEBMCP_CAPTURE_SHIM],
			entryUrl: url,
			viewport: VIEWPORT,
		});

		try {
			await page.goto(url, boundedTimeout(deadline, NAV_TIMEOUT_MS));
		} catch (err) {
			return { snapshot: null, declarative: null, quietMs: 0, loadError: describeError(err) };
		}

		const quietMs = await waitForRegistrationQuiet(page, mode, deadline, onTools);

		const snapshot = await page
			.evaluate<WebmcpShimSnapshot | null>(SNAPSHOT_EXPRESSION)
			.catch(() => null);
		const declarative = await page
			.evaluate<WebmcpShimDeclarativeScan | null>(DECLARATIVE_SCAN_SNIPPET)
			.catch(() => null);

		return { snapshot, declarative, quietMs, loadError: null };
	} catch (err) {
		return { snapshot: null, declarative: null, quietMs: 0, loadError: describeError(err) };
	} finally {
		await page?.close();
	}
}

/**
 * Poll the shim's counters until they stop moving for `QUIET_WINDOW_MS`, or the
 * mode's ceiling (or the page budget) runs out. Returns how long we waited.
 */
async function waitForRegistrationQuiet(
	page: CdpPage,
	mode: WebmcpCaptureMode,
	deadline: number,
	onTools?: (tools: WebmcpTool[]) => void,
): Promise<number> {
	const startedAt = Date.now();
	const maxWaitMs = Math.min(MAX_QUIET_WAIT_MS[mode], Math.max(0, deadline - startedAt));
	const initialWaitMs = Math.min(INITIAL_REGISTRATION_WAIT_MS[mode], maxWaitMs);
	let lastFingerprint: string | null = null;
	let lastChangeAt = startedAt;
	let hasRegistered = false;

	while (Date.now() - startedAt < maxWaitMs) {
		const fingerprint = await page.evaluate<string>(FINGERPRINT_EXPRESSION).catch(() => null);
		if (typeof fingerprint === "string" && /^[1-9]\d*:/.test(fingerprint)) {
			hasRegistered = true;
		}
		if (fingerprint !== lastFingerprint) {
			lastFingerprint = typeof fingerprint === "string" ? fingerprint : null;
			lastChangeAt = Date.now();
			// A change means something registered: this is the one moment a
			// streaming consumer can be shown tools DURING the quiet wait, which
			// on a single-page audit is most of the capture's tail.
			if (onTools) await emitRegisteredTools(page, onTools);
		}

		const now = Date.now();
		if (
			registrationWaitComplete({
				elapsedMs: now - startedAt,
				quietMs: now - lastChangeAt,
				hasRegistered,
				initialWaitMs,
				maxWaitMs,
			})
		) {
			break;
		}
		await sleep(Math.min(QUIET_POLL_MS, Math.max(0, deadline - Date.now())));
		if (Date.now() >= deadline) break;
	}
	return Date.now() - startedAt;
}

interface RegistrationWaitState {
	elapsedMs: number;
	quietMs: number;
	hasRegistered: boolean;
	initialWaitMs: number;
	maxWaitMs: number;
}

/** Pure stopping rule, copied from ora with its regression tests. Before the
 * first tool, only the initial-arrival window can end the wait; after it, two
 * quiet seconds end it. The hard ceiling wins in either state. */
export function registrationWaitComplete(state: RegistrationWaitState): boolean {
	if (state.elapsedMs >= state.maxWaitMs) return true;
	if (!state.hasRegistered) return state.elapsedMs >= state.initialWaitMs;
	return state.quietMs >= QUIET_WINDOW_MS;
}

/** Poll the uninstrumented page's native registry. `null` means getTools was
 * unavailable or rejected throughout the bounded window; `0` means it worked
 * and stayed empty. Those are intentionally different verdict inputs. */
async function waitForNativeToolRegistration(
	page: CdpPage,
	mode: WebmcpCaptureMode,
	deadline: number,
): Promise<number | null> {
	const startedAt = Date.now();
	const maxWaitMs = Math.min(INITIAL_REGISTRATION_WAIT_MS[mode], Math.max(0, deadline - startedAt));
	let lastSuccessfulCount: number | null = null;

	while (Date.now() - startedAt < maxWaitMs) {
		const count = await page
			.evaluate<number | null>(NATIVE_TOOL_COUNT_EXPRESSION)
			.catch(() => null);
		if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
			lastSuccessfulCount = count;
			if (count > 0) return count;
		}
		await sleep(Math.min(QUIET_POLL_MS, Math.max(0, deadline - Date.now())));
		if (Date.now() >= deadline) break;
	}
	return lastSuccessfulCount;
}

/** Progress-only read of the shim's live tool list mid-quiet-wait. Any failure
 * is a missed progress line, never a capture problem. */
async function emitRegisteredTools(
	page: CdpPage,
	onTools: (tools: WebmcpTool[]) => void,
): Promise<void> {
	const snapshot = await page
		.evaluate<WebmcpShimSnapshot | null>(SNAPSHOT_EXPRESSION)
		.catch(() => null);
	if (!snapshot) return;
	// The FULL live list every time: the consumer's occurrence-keyed dedupe
	// needs each name's repeats numbered within one walk.
	onTools(mapShimTools(snapshot.tools, page.url()));
}

// ---------------------------------------------------------------------------
// Page capture
// ---------------------------------------------------------------------------

interface PageCaptureOutcome {
	page: WebmcpPageCapture;
	screenshot: WebmcpScreenshot | null;
}

async function capturePage(
	browser: CdpBrowser,
	url: string,
	mode: WebmcpCaptureMode,
	wantScreenshot: boolean,
	onTools?: (tools: WebmcpTool[]) => void,
): Promise<PageCaptureOutcome> {
	const startedAt = Date.now();
	const pageDeadline = startedAt + PAGE_BUDGET_MS;

	const passA = await runPassA(browser, url, mode, pageDeadline, wantScreenshot);

	// A page we could not load, or one that sent us a bot wall, tells us nothing
	// about its WebMCP support. Skip pass B rather than spend a second context
	// reconfirming it.
	const skipPassB = passA.loadError !== null || passA.blocked;
	const passB: PassBResult = skipPassB
		? { snapshot: null, declarative: null, quietMs: 0, loadError: null }
		: await runPassB(browser, url, mode, pageDeadline, onTools);

	// Pass B is the ONLY pass that can see tools, so a pass B that never loaded
	// leaves us with no tool evidence either way. Folding its failure into the
	// page's load error stops an empty capture from being reported as the site's
	// answer.
	const loadError = passA.loadError ?? passB.loadError;

	const snapshot = passB.snapshot;
	const forms = (passB.declarative?.forms ?? []).filter((form) => form.toolName.trim() !== "");
	const finalUrl = passA.finalUrl || url;

	const imperativeTools = snapshot ? mapShimTools(snapshot.tools, finalUrl) : [];
	const declarativeTools = mapDeclarativeTools(forms, finalUrl);
	const tools = [...imperativeTools, ...declarativeTools];

	const staticSignals = safeStaticSignals(passA.html, passA.inlineJs, passA.scripts);

	const originTrial = evaluateOriginTrial(
		passA.originTrialTokens,
		originOf(finalUrl) ?? originOf(url) ?? "",
		new Date(),
	);

	const facts: WebmcpPageFacts = {
		loadError,
		blocked: passA.blocked,
		nativeApi: passA.nativeApi,
		nativeToolCount: passA.nativeToolCount,
		declarativeToolCount: declarativeTools.length,
		toolCount: tools.length,
		shimTakenOver: (snapshot?.takenOver.length ?? 0) > 0,
		staticSignals,
	};

	const verdict = deriveVerdict(facts);

	return {
		page: {
			url,
			finalUrl,
			verdict,
			status: deriveStatus(verdict, tools),
			tools,
			declarativeFormCount: declarativeTools.length,
			consumer: {
				nativeApi: passA.nativeApi,
				nativeToolCount: passA.nativeToolCount,
				originTrial,
				permissionsPolicy: passA.permissionsPolicy,
				iframeAllow: deriveIframeAllow(passA.permissionsPolicy),
			},
			staticSignals,
			apiSurface: {
				toolchangeEvents: snapshot?.toolchangeEvents ?? 0,
				provideContextCalls: snapshot?.provideContextCalls ?? 0,
				registrationErrors: buildRegistrationErrors(snapshot),
			},
			timing: { navMs: passA.navMs, quietMs: passB.quietMs, totalMs: Date.now() - startedAt },
			error: loadError,
		},
		// A bot wall's screenshot is a picture of the wall, not the site; the
		// grade must not read it as the page's answer.
		screenshot: passA.blocked ? null : passA.screenshot,
	};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface LocalCaptureOptions {
	/** The page to capture. Unlike ora's service, this may be localhost. */
	url: string;
	/** A debuggable Chrome, already resolved. */
	endpoint: BrowserEndpoint;
	/**
	 * Defaults to `fast`, which is what ora.ai's user-initiated audits run.
	 * Matching it is what keeps a local run and a published run reading the same
	 * registration tail.
	 */
	mode?: WebmcpCaptureMode;
	/** Set false to skip the entry-page screenshot. The `page-experience` check
	 * then comes back `unmeasured` rather than scored, and evidence coverage
	 * drops by that check's weight. */
	screenshot?: boolean;
	/** Progress sink for tools as they register. */
	onTools?: (tools: WebmcpTool[]) => void;
}

/**
 * Capture one page and return the same shape ora's worker returns.
 *
 * Single page by design: the dev loop is "I changed my tools, re-check", and
 * `deriveAuditVerdict` folds a one-page capture to that page's own verdict.
 */
export async function captureLocally(options: LocalCaptureOptions): Promise<WebmcpCaptureResult> {
	const { url, endpoint, mode = "fast", screenshot = true, onTools } = options;
	const startedAt = Date.now();
	const capturedAt = new Date().toISOString();

	const browser = await CdpBrowser.connect(endpoint);
	try {
		const outcome = await capturePage(browser, url, mode, screenshot, onTools);
		return {
			url,
			pages: [outcome.page],
			chromeVersion: browser.product,
			shimVersion: WEBMCP_SHIM_VERSION,
			capturedAt,
			durationMs: Date.now() - startedAt,
			screenshot: outcome.screenshot,
		};
	} finally {
		browser.close();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Viewport JPEG of the page as it stands. Failure posture matches the rest of
 * the capture: a screenshot we could not take is a missing grade input, never
 * a capture failure, so every branch degrades to `null`.
 */
async function takeScreenshot(page: CdpPage, deadline: number): Promise<WebmcpScreenshot | null> {
	const buffer = await page.screenshot(SCREENSHOT_JPEG_QUALITY, boundedTimeout(deadline, 5_000));
	if (!buffer || buffer.byteLength === 0 || buffer.byteLength > MAX_SCREENSHOT_BYTES) return null;
	const viewport = page.viewportSize();
	return {
		data: buffer.toString("base64"),
		mimeType: "image/jpeg",
		width: viewport?.width ?? 0,
		height: viewport?.height ?? 0,
	};
}

/** `collectStaticSignals` reads third-party HTML; a page that makes it throw
 * must degrade to "no static evidence", never take the capture down with it. */
function safeStaticSignals(
	html: string,
	inlineJs: string,
	scripts: Array<{ url: string; body: string }>,
): WebmcpStaticSignals {
	if (!html) return EMPTY_STATIC_SIGNALS;
	try {
		return collectStaticSignals(html, inlineJs, scripts);
	} catch {
		return EMPTY_STATIC_SIGNALS;
	}
}

/** Origin of a URL, or null when it cannot be parsed. */
function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

function describeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.split("\n")[0].slice(0, 300);
}

/** Never let an op outlive the page budget, and never pass a non-positive
 * timeout down: ora floors this at 250ms and a zero here would fail instantly
 * where the server would still allow a quarter second. */
function boundedTimeout(deadline: number, preferred: number): number {
	return Math.max(250, Math.min(preferred, deadline - Date.now()));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
