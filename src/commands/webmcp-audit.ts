import { type CommandError, reportError } from "../report/json-error";
import { axCall, type NextStep, placeholder, printNext, type Word } from "../report/next-line";
import { isLocalTarget } from "../tunnel";
import { plain } from "../ui/ansi";
import { spinner } from "../ui/spinner";
import { captureLocally } from "../webmcp/capture";
import { resolveChrome, webmcpParityWarning } from "../webmcp/chrome";
import {
	ingestCapture,
	preflightCapture,
	prepareForIngest,
	WebmcpIngestError,
} from "../webmcp/ingest";
import { renderWebmcpReport } from "../webmcp/report";
import type { WebmcpAuditEvent } from "../webmcp/vendor/types";

export interface WebmcpAuditCommandInput {
	url: string;
	json: boolean;
	showPassing: boolean;
	/** Raw --min-score value; validated here so a bad value is a usage error. */
	minScore?: string;
	/** ws:// endpoint, http origin, or host:port of a debuggable Chrome. */
	chromeEndpoint?: string;
	/** ora API key; lifts the anonymous ingest rate limits. */
	apiKey?: string;
}

/**
 * The documented exit-code contract (README + --help), unchanged from `audit`:
 *   0 success (and score >= --min-score when given)
 *   1 score below --min-score
 *   2 usage error (bad flags, malformed URL, no debuggable Chrome)
 *   3 API unreachable / timeout / rate limit / ora refused the capture
 */
export const EXIT = { OK: 0, BELOW_MIN_SCORE: 1, USAGE: 2, API: 3 } as const;

/**
 * Unlike `ax audit`, a bare hostname is not accepted and localhost is the
 * expected case: this command drives a browser at a URL on the developer's own
 * machine, so it needs a scheme and it must not reject a non-default port.
 */
function normalizeTarget(raw: string): string | undefined {
	const target = raw.trim();
	if (!target || /\s/.test(target)) return undefined;
	try {
		const url = new URL(target.includes("://") ? target : `http://${target}`);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function parseMinScore(raw: string | undefined): { value?: number; error?: string } {
	if (raw === undefined) return {};
	const value = Number(raw);
	// Number("") is 0, so an empty value (an unset CI variable expanding to "")
	// would silently become a gate of 0 - reject it as a usage error.
	if (raw.trim() === "" || !Number.isInteger(value) || value < 0 || value > 100) {
		return {
			error: `--min-score must be an integer between 0 and 100, got ${JSON.stringify(raw)}`,
		};
	}
	return { value };
}

/** The same audit as a call, with a key passed as a flag shown as a placeholder. */
function sameCallWords(input: WebmcpAuditCommandInput, minScore = input.minScore): Word[] {
	return [
		"webmcp-audit",
		input.url.trim(),
		...(input.json ? ["--json"] : []),
		...(input.showPassing ? ["--show-passing"] : []),
		...(minScore !== undefined ? ["--min-score", minScore] : []),
		...(input.chromeEndpoint ? ["--chrome-endpoint", input.chromeEndpoint] : []),
		...(input.apiKey ? ["--api-key", placeholder("key")] : []),
	];
}

/** A failed ingest: an outdated shim is an upgrade, never a retry. */
function ingestNext(input: WebmcpAuditCommandInput, err: unknown): NextStep {
	if (err instanceof WebmcpIngestError && err.code === "SHIM_VERSION_MISMATCH") {
		return {
			call: "npm i -g ax@latest",
			why: "this ax captures with a shim ora no longer scores; then run it again",
		};
	}
	if (err instanceof WebmcpIngestError && err.code === "RATE_LIMITED") {
		return { call: axCall(sameCallWords(input)), why: "after the wait the message names" };
	}
	return { call: axCall(sameCallWords(input)), why: "retry; ora may be briefly unreachable" };
}

/**
 * After a result: a local page or one under the gate is re-audited once the
 * fixes are in; a public page that cleared it moves on to the whole site.
 */
function resultNext(input: WebmcpAuditCommandInput, target: string, belowGate: boolean): NextStep {
	if (isLocalTarget(target) || belowGate) {
		return {
			call: axCall(sameCallWords(input)),
			why: "after you fix the failing checks above, run it again",
		};
	}
	return {
		call: axCall(["audit", new URL(target).host, ...(input.json ? ["--json"] : [])]),
		why: "the readiness audit of the whole site",
	};
}

export async function webmcpAuditCommand(input: WebmcpAuditCommandInput): Promise<number> {
	const fail = (error: CommandError, exit: number, display?: string): number => {
		reportError(error, { json: input.json, display });
		return exit;
	};
	const target = normalizeTarget(input.url);
	if (!target) {
		return fail(
			{
				code: "INVALID_TARGET",
				message: `Not an auditable URL: ${JSON.stringify(input.url)}`,
				next: {
					call: axCall([
						"webmcp-audit",
						"http://localhost:3000",
						...(input.json ? ["--json"] : []),
					]),
				},
			},
			EXIT.USAGE,
			`Not an auditable URL: ${JSON.stringify(input.url)}\nPass the page you want audited, e.g. http://localhost:3000`,
		);
	}

	const minScore = parseMinScore(input.minScore);
	if (minScore.error) {
		return fail(
			{
				code: "INVALID_FLAG",
				message: minScore.error,
				next: { call: axCall(sameCallWords(input, "70")) },
			},
			EXIT.USAGE,
		);
	}

	// A Chrome we cannot reach is a usage problem with a fix the developer can
	// act on, not an API failure - and never a prompt to download a browser.
	const chrome = await resolveChrome(input.chromeEndpoint);
	if (!chrome.ok) {
		const words = sameCallWords({ ...input, chromeEndpoint: undefined });
		return fail(
			{
				code: "NO_CHROME",
				message: chrome.message,
				next: {
					call: axCall([...words, "--chrome-endpoint", placeholder("host:port")]),
					why: "a Chrome started with --remote-debugging-port, or install Chrome",
				},
			},
			EXIT.USAGE,
		);
	}

	if (!input.json) {
		spinner.start(
			chrome.launched ? `Starting Chrome and capturing ${target}` : `Capturing ${target}`,
		);
	}

	let capture: Awaited<ReturnType<typeof captureLocally>>;
	try {
		capture = await captureLocally({
			url: target,
			endpoint: chrome.endpoint,
			onTools: (tools) => {
				if (!input.json) spinner.update(`Capturing ${target} — ${tools.length} tools`);
			},
		});
	} catch (err) {
		spinner.stop();
		const message = err instanceof Error ? err.message : String(err);
		return fail(
			{
				code: "CAPTURE_FAILED",
				message,
				next: { call: axCall(sameCallWords(input)), why: "retry the capture" },
			},
			EXIT.API,
			`Capture failed: ${message}`,
		);
	} finally {
		// A Chrome we started is ours to stop, on every path out of the capture.
		// Leaking one holds a profile directory and a port until reboot, and this
		// is a command people run dozens of times a day. An attached browser is
		// somebody else's and `close` is a no-op for it.
		await chrome.close();
	}

	// A page that never loaded is a local problem, and sending it would spend an
	// ingest just to be told the page could not be read.
	const page = capture.pages[0];
	if (page?.error) {
		spinner.stop();
		return fail(
			{
				code: "PAGE_UNREACHABLE",
				message: `Could not capture ${target}: ${page.error}`,
				next: { call: axCall(sameCallWords(input)), why: "start the dev server first" },
			},
			EXIT.USAGE,
			`Could not capture ${target}: ${page.error}\nIs the dev server running?`,
		);
	}

	const rejection = preflightCapture(capture);
	if (rejection) {
		spinner.stop();
		return fail(
			{
				code: "CAPTURE_REFUSED",
				message: `ora would refuse this capture: ${rejection}`,
				next: { call: axCall(sameCallWords(input)), why: "after you fix what the message names" },
			},
			EXIT.USAGE,
		);
	}

	const { capture: payload, droppedScreenshot } = prepareForIngest(capture);

	if (!input.json) spinner.update("Scoring with ora");
	let audit: Awaited<ReturnType<typeof ingestCapture>>;
	try {
		audit = await ingestCapture(target, payload, {
			// ora's ingest recognizes partner and scan keys only; a platform key
			// (ORA_API_KEY) would silently fall back to the anonymous limits.
			apiKey:
				input.apiKey ||
				process.env.ORA_PARTNER_API_KEY ||
				process.env.ORA_SCAN_API_KEY ||
				undefined,
			onEvent: (event) => {
				if (!input.json) spinner.update(progressLine(event));
			},
		});
	} catch (err) {
		spinner.stop();
		const message = err instanceof Error ? err.message : String(err);
		const ingest = err instanceof WebmcpIngestError;
		return fail(
			{
				code: (ingest && err.code) || "SCORING_FAILED",
				message,
				next: ingestNext(input, err),
			},
			EXIT.API,
			ingest ? message : `Scoring failed: ${message}`,
		);
	}
	spinner.stop();

	// Raw passthrough (design decision #4): the payload exactly as ora served
	// it, no reshaping and no injected fields.
	if (input.json) {
		console.log(JSON.stringify(audit, null, 2));
	} else {
		for (const line of renderWebmcpReport(audit, { showPassing: input.showPassing })) {
			console.log(line);
		}
	}

	// On stderr, and in BOTH modes. These two say the result is not what the
	// reader thinks it is, which matters most in the mode nobody is watching:
	// `--json` is what CI runs, and stdout there has to stay the raw payload.
	if (droppedScreenshot) {
		console.error(
			"Note: the screenshot exceeded ora's 2 MB limit and was not sent, so page-experience could not be graded.",
		);
	}
	const parity = webmcpParityWarning(capture);
	if (parity) console.error(`\n${parity}`);

	if (minScore.value !== undefined) {
		// Availability is informational and never gates the score, so a
		// not-ready page is compared on its score like any other.
		// Compared against the score, never the grade: below the coverage
		// threshold the grade is withheld and a check keyed on it would pass
		// everything.
		// The payload is already on stdout, so this is a note, not an envelope.
		if (audit.score === null) {
			if (!input.json) {
				console.error("\n  ora returned no score, so --min-score cannot be evaluated.");
			}
			printNext(
				{
					call: axCall(sameCallWords(input)),
					why: "ora returned no score to gate on; retry, or drop --min-score",
				},
				{ stderr: true },
			);
			return EXIT.API;
		}
		if (audit.score < minScore.value) {
			if (!input.json) {
				console.log(`\n  Score ${audit.score} is below the required minimum ${minScore.value}\n`);
			}
			printNext(resultNext(input, target, true), { stderr: input.json });
			return EXIT.BELOW_MIN_SCORE;
		}
	}

	printNext(resultNext(input, target, false), { stderr: input.json });
	return EXIT.OK;
}

/** Spinner copy for one stream event. Progress only - nothing here decides
 * anything, and an event with no interesting line simply keeps the last one. */
function progressLine(event: WebmcpAuditEvent): string {
	switch (event.type) {
		case "phase":
			return `Scoring with ora — ${event.phase}`;
		case "tool-discovered":
			// Whatever the audited page called its tool, on its way to a terminal.
			return `Scoring with ora — found ${plain(event.tool.name)}`;
		case "finding":
			return `Scoring with ora — ${event.finding.checkId}`;
		case "simulation-step":
			return `Scoring with ora — simulating "${plain(event.step.intent)}"`;
		default:
			return "Scoring with ora";
	}
}
