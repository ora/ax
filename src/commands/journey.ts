import { platformBase } from "../api/platform-origins";
import { createSetsClient } from "../api/sets";
import { runIsLive, type StandaloneRun } from "../api/standalone";
import { SETS_FEATURE } from "../auth/platform-features";
import { type PlatformCredentials, platformCredentials } from "../auth/resolve-credential";
import { onInterrupt } from "../journey-set/interrupt";
import { watchRun } from "../journey-set/journey-progress";
import { servedBody } from "../report/error-chain";
import { type CommandError, reportError } from "../report/json-error";
import { axCall, type NextStep, placeholder, printNext } from "../report/next-line";
import { credentialFailure } from "./credential-failure";
import { printRun } from "./journey-run-result";
import { DEFAULT_WAIT_MINUTES, INTERRUPTED } from "./journey-set";

export interface JourneyCommandInput {
	intent: string;
	domain?: string;
	harness: string;
	model?: string;
	json: boolean;
}

/** A caller reading JSON keeps reading JSON on the next call. */
const jsonWords = (input: JourneyCommandInput) => (input.json ? ["--json"] : []);

/** After a run: audit the site it targeted, or name one when the run had none. */
function resultNext(input: JourneyCommandInput): NextStep {
	if (input.domain) {
		return {
			call: axCall(["audit", input.domain, ...jsonWords(input)]),
			why: "the readiness audit: which checks explain what the agent hit",
		};
	}
	return {
		call: axCall(["journey", input.intent, "--domain", placeholder("domain"), ...jsonWords(input)]),
		why: "name the site so the run can be traced back to it",
	};
}

/**
 * A failed launch: a credential's failure reads as it does for every command (no credential is
 * MISSING_API_KEY, which scripts read; a sign-in that ended says ax login); anything else is
 * retried as the same call.
 */
function launchFailure(input: JourneyCommandInput, cause: unknown): CommandError {
	const retry = axCall([
		"journey",
		input.intent,
		...(input.domain ? ["--domain", input.domain] : []),
		"--harness",
		input.harness,
		...(input.model ? ["--model", input.model] : []),
		...jsonWords(input),
	]);
	const otherwise = "with no goal, ax journey --domain <site> runs one of ora's curated tasks free";
	return (
		credentialFailure(cause, { retry, otherwise }) ?? {
			code: "PLATFORM_ERROR",
			message: cause instanceof Error ? cause.message : String(cause),
			next: {
				call: retry,
				why: "retry; if it fails the same way, check your sign-in (ax whoami) or ORA_API_KEY, and ORA_PLATFORM_URL",
			},
		}
	);
}

/** Create once, follow the native run stream, then read the same run’s stored evidence. */
export async function journeyCommand(
	input: JourneyCommandInput,
	deps: { credentials: PlatformCredentials } = { credentials: platformCredentials() },
): Promise<number> {
	let created: StandaloneRun | undefined;
	const interrupt = onInterrupt();
	try {
		const base = platformBase();
		const credential = deps.credentials.chain.resolve(base, SETS_FEATURE);
		const client = createSetsClient({ base, credential, signal: interrupt.signal });
		created = await client.createRun({
			goal: input.intent,
			...(input.domain !== undefined ? { site: input.domain } : {}),
			agent: input.model ? `${input.harness}/${input.model}` : input.harness,
		});
		console.error(`Run ${created.runId} started.`);
		const evidence = await watchRun(client, created, {
			json: input.json,
			interrupt: interrupt.signal,
			waitMinutes: DEFAULT_WAIT_MINUTES,
		});
		printRun(evidence, input.json);
		if (runIsLive(evidence)) {
			printNext(runViewStep(created.runId, input.json), { stderr: true });
			return 2;
		}
		printNext(resultNext(input), { stderr: input.json });
		return evidence.state === "succeeded" ? 0 : 1;
	} catch (cause) {
		if (interrupt.signal.aborted) {
			if (created) printNext(runViewStep(created.runId, input.json), { stderr: true });
			return INTERRUPTED;
		}
		const error = launchFailure(input, cause);
		if (created) error.next = runViewStep(created.runId, input.json);
		reportError(error, {
			json: input.json,
			display: (message) => `Journey failed: ${message}`,
			served: servedBody(cause),
		});
		return 2;
	} finally {
		interrupt.stop();
	}
}

function runViewStep(runId: string, json: boolean): NextStep {
	return {
		call: axCall(["journey", "view", runId, ...(json ? ["--json"] : [])]),
		why: "open the run already started",
	};
}
