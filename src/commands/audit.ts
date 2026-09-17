import pc from "picocolors";
import { AuditApiError, type AuditOutcome, isMcpAuthRequired, performAudit } from "../api/audit";
import { toReport } from "../report/model";
import { MCP_AUTH_REQUIRED_NOTICE, renderReport } from "../report/terminal";
import { isLocalTarget, openTunnel, type Tunnel } from "../tunnel";
import { MISSING_KEY_HINT, openOraTunnel } from "../tunnel/ora";
import { spinner } from "../ui/spinner";

export interface AuditCommandInput {
	url: string;
	json: boolean;
	showSkipped: boolean;
	showPassing: boolean;
	/** Raw --min-score value; validated here so a bad value is a usage error. */
	minScore?: string;
	/** Raw --max-age value in seconds. */
	maxAge?: string;
	force: boolean;
	/** User-supplied command that exposes the target and prints a public https URL. */
	tunnelCmd?: string;
	/** Raw --tunnel value; "ora" opens ora's own tunnel (needs ORA_API_KEY). */
	tunnel?: string;
	/** ora-issued scan API key (--api-key); the client falls back to ORA_SCAN_API_KEY. */
	apiKey?: string;
}

/**
 * The documented exit-code contract (README + --help):
 *   0 success (and score >= --min-score when given)
 *   1 score below --min-score
 *   2 usage error (bad flags, malformed URL, local target without a tunnel)
 *   3 API unreachable / timeout / rate limit exhausted
 */
export const EXIT = { OK: 0, BELOW_MIN_SCORE: 1, USAGE: 2, API: 3 } as const;

// Documented contract guidance: an auth-gated MCP target is unscored, so a
// gate has nothing to compare against and must not fail on it. Both routes to
// that state - ora's MCP_AUTH_REQUIRED error and the legacy marker on a stored
// result - say it with this one line.
const MIN_SCORE_SKIPPED_NOTE =
	"--min-score skipped: the MCP handshake requires credentials, so the target is unscored\n";

function parseIntFlag(
	raw: string | undefined,
	flag: string,
	min: number,
	max: number,
): { value?: number; error?: string } {
	if (raw === undefined) return {};
	const value = Number(raw);
	// Number("") is 0, so an empty value (e.g. an unset CI variable expanding
	// to "") would silently become a gate of 0 - reject it as a usage error.
	if (raw.trim() === "" || !Number.isInteger(value) || value < min || value > max) {
		return {
			error: `${flag} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`,
		};
	}
	return { value };
}

/** Accepts bare domains and full URLs; rejects anything the API would 400 on sight. */
function normalizeTarget(raw: string): string | undefined {
	const target = raw.trim().replace(/\/+$/, "");
	if (!target || /\s/.test(target)) return undefined;
	try {
		const url = new URL(target.includes("://") ? target : `https://${target}`);
		if (!url.hostname.includes(".") && url.hostname !== "localhost") return undefined;
		return target;
	} catch {
		return undefined;
	}
}

type TunnelMode = { kind: "none" } | { kind: "ora" } | { kind: "cmd"; command: string };

/**
 * Which tunnel to open, if any. Explicit flags beat the environment, and a
 * command beats the ora mode at each level, so a `--tunnel-cmd` on the
 * command line always wins over an `ORA_TUNNEL=ora` left in a .env.
 */
function resolveTunnelMode(input: AuditCommandInput): TunnelMode | { error: string } {
	const flagCmd = input.tunnelCmd?.trim();
	if (flagCmd) return { kind: "cmd", command: flagCmd };
	const flagMode = input.tunnel?.trim();
	if (flagMode !== undefined) {
		if (flagMode !== "ora") {
			return {
				error: `--tunnel must be "ora" (ora's own tunnel), got ${JSON.stringify(input.tunnel)}`,
			};
		}
		return { kind: "ora" };
	}
	const envCmd = process.env.ORA_TUNNEL_CMD?.trim();
	if (envCmd) return { kind: "cmd", command: envCmd };
	const envMode = process.env.ORA_TUNNEL?.trim();
	if (envMode) {
		if (envMode !== "ora") {
			return {
				error: `ORA_TUNNEL must be "ora" (ora's own tunnel), got ${JSON.stringify(envMode)}`,
			};
		}
		return { kind: "ora" };
	}
	return { kind: "none" };
}

/** The MCP endpoint ora named in its error object, when it named one. */
function mcpUrlOf(payload: unknown): string | undefined {
	const url = (payload as { mcpUrl?: unknown } | null | undefined)?.mcpUrl;
	return typeof url === "string" && url ? url : undefined;
}

export async function auditCommand(input: AuditCommandInput): Promise<number> {
	const target = normalizeTarget(input.url);
	if (!target) {
		console.error(`Not a scannable URL or domain: ${JSON.stringify(input.url)}`);
		return EXIT.USAGE;
	}
	const minScore = parseIntFlag(input.minScore, "--min-score", 0, 100);
	const maxAge = parseIntFlag(input.maxAge, "--max-age", 0, 86_400);
	for (const flag of [minScore, maxAge]) {
		if (flag.error) {
			console.error(flag.error);
			return EXIT.USAGE;
		}
	}

	// A local target only exists on this machine, so ora can never reach it
	// directly. Two ways through: ora's own tunnel (--tunnel ora, needs the
	// platform key) or a user-supplied command (--tunnel-cmd / ORA_TUNNEL_CMD)
	// that prints a public https URL. Either way the result is stored as
	// ephemeral so the throwaway hostname never pollutes rankings.
	const tunnelMode = resolveTunnelMode(input);
	if ("error" in tunnelMode) {
		console.error(tunnelMode.error);
		return EXIT.USAGE;
	}
	const useTunnel = tunnelMode.kind !== "none";
	if (!useTunnel && isLocalTarget(target)) {
		console.error(
			[
				`${target} only exists on this machine, and ora audits public URLs.`,
				"Either audit a publicly reachable deployment of this site (e.g. a preview URL),",
				"or run it through a tunnel:",
				"  ax audit localhost:3000 --tunnel ora   # ora's own tunnel; needs ORA_API_KEY",
				"  ax audit localhost:3000 --tunnel-cmd 'ora tunnel 3000 --access public'",
				"  ax audit localhost:3000 --tunnel-cmd 'ngrok http 3000 --log stdout'",
				"Any command that prints a public https URL works; the result is stored as",
				"ephemeral (excluded from rankings, deleted after a few days).",
			].join("\n"),
		);
		return EXIT.USAGE;
	}
	if (tunnelMode.kind === "ora" && !process.env.ORA_API_KEY) {
		console.error(MISSING_KEY_HINT);
		return EXIT.USAGE;
	}

	const interactive = !input.json;
	if (interactive) spinner.start(`Auditing ${target} with ora`);
	let tunnel: Tunnel | undefined;
	let opening: Promise<Tunnel> | undefined;
	const interrupt = new AbortController();
	const closeTunnel = async () => {
		await tunnel?.close();
	};
	// The tunnel must not outlive an interrupted run. Installing a signal
	// listener removes Node's default exit, so after cleanup the handler
	// must terminate the process itself (conventional 128 + signal codes).
	// ora's tunnel deletes its row over HTTP, so the exit waits for close();
	// a Ctrl-C during setup aborts the open, whose own cleanup deletes the row.
	// The listeners come off on the first signal so a second Ctrl-C gets
	// Node's default exit if the cleanup itself hangs.
	const onSignal = (signal: NodeJS.Signals) => {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		interrupt.abort();
		void (async () => {
			await opening?.catch(() => undefined);
			await closeTunnel();
		})().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
	};
	let auditTarget = target;
	if (tunnelMode.kind !== "none") {
		if (interactive) spinner.update(`Opening a tunnel to ${target}`);
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
		try {
			opening =
				tunnelMode.kind === "ora"
					? openOraTunnel(target, { signal: interrupt.signal })
					: openTunnel(tunnelMode.command);
			tunnel = await opening;
		} catch (cause) {
			spinner.stop();
			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
			console.error(cause instanceof Error ? cause.message : String(cause));
			return EXIT.USAGE;
		}
		auditTarget = tunnel.url;
	}

	let outcome: AuditOutcome;
	try {
		const audit = performAudit(auditTarget, {
			progress: interactive ? (line) => spinner.update(line) : undefined,
			maxAgeSeconds: maxAge.value,
			force: input.force,
			ephemeral: useTunnel || undefined,
			apiKey: input.apiKey?.trim() || undefined,
		});
		// A tunnel that dies mid-audit leaves ora scoring a hostname that no
		// longer answers: fail the run rather than render that as a result.
		outcome = tunnel?.dropped
			? await Promise.race([audit, tunnel.dropped.then((error) => Promise.reject(error))])
			: await audit;
	} catch (cause) {
		spinner.stop();
		// Not a failure: ora refused to scan a target whose MCP handshake needs
		// credentials, which is the same unscored state the legacy marker
		// describes - report it and exit 0.
		if (isMcpAuthRequired(cause)) {
			if (input.json) {
				// Raw passthrough: the error object exactly as ora served it.
				process.stdout.write(`${JSON.stringify(cause.payload, null, 2)}\n`);
			} else {
				console.log("");
				console.log(pc.yellow(`  ${MCP_AUTH_REQUIRED_NOTICE}`));
				const mcpUrl = mcpUrlOf(cause.payload);
				if (mcpUrl) console.log(pc.dim(`  MCP endpoint: ${mcpUrl}`));
				console.log("");
			}
			if (minScore.value !== undefined) process.stderr.write(MIN_SCORE_SKIPPED_NOTE);
			return EXIT.OK;
		}
		console.error(`Audit failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		return cause instanceof AuditApiError ? EXIT.API : EXIT.USAGE;
	} finally {
		await closeTunnel();
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
	}
	spinner.stop();

	const { result } = outcome;
	if (input.json) {
		// Raw contract passthrough: the payload exactly as ora served it.
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		for (const line of renderReport(toReport(outcome, target), {
			showSkipped: input.showSkipped,
			showPassing: input.showPassing,
			tunnel: useTunnel,
		})) {
			console.log(line);
		}
	}

	if (minScore.value !== undefined) {
		// Legacy marker on a stored result (older servers, and score polls that
		// still return a marked row): unscored for the same reason.
		if (result.mcpAuthRequired) {
			process.stderr.write(MIN_SCORE_SKIPPED_NOTE);
			return EXIT.OK;
		}
		if (result.score < minScore.value) {
			if (!input.json) {
				console.log(`  Score ${result.score} is below the required minimum ${minScore.value}\n`);
			}
			return EXIT.BELOW_MIN_SCORE;
		}
	}
	return EXIT.OK;
}
