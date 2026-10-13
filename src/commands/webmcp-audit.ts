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

export async function webmcpAuditCommand(input: WebmcpAuditCommandInput): Promise<number> {
	const target = normalizeTarget(input.url);
	if (!target) {
		console.error(`Not an auditable URL: ${JSON.stringify(input.url)}`);
		console.error("Pass the page you want audited, e.g. http://localhost:3000");
		return EXIT.USAGE;
	}

	const minScore = parseMinScore(input.minScore);
	if (minScore.error) {
		console.error(minScore.error);
		return EXIT.USAGE;
	}

	// A Chrome we cannot reach is a usage problem with a fix the developer can
	// act on, not an API failure - and never a prompt to download a browser.
	const chrome = await resolveChrome(input.chromeEndpoint);
	if (!chrome.ok) {
		console.error(chrome.message);
		return EXIT.USAGE;
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
		console.error(`Capture failed: ${err instanceof Error ? err.message : String(err)}`);
		return EXIT.API;
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
		console.error(`Could not capture ${target}: ${page.error}`);
		console.error("Is the dev server running?");
		return EXIT.USAGE;
	}

	const rejection = preflightCapture(capture);
	if (rejection) {
		spinner.stop();
		console.error(`ora would refuse this capture: ${rejection}`);
		return EXIT.USAGE;
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
		if (err instanceof WebmcpIngestError) {
			console.error(err.message);
			return EXIT.API;
		}
		console.error(`Scoring failed: ${err instanceof Error ? err.message : String(err)}`);
		return EXIT.API;
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
		if (audit.score === null) {
			if (!input.json) {
				console.error("\n  ora returned no score, so --min-score cannot be evaluated.");
			}
			return EXIT.API;
		}
		if (audit.score < minScore.value) {
			if (!input.json) {
				console.log(`\n  Score ${audit.score} is below the required minimum ${minScore.value}\n`);
			}
			return EXIT.BELOW_MIN_SCORE;
		}
	}

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
