import { defineCommand } from "citty";
import pc from "picocolors";
import { platformBase } from "../api/platform";
import { signInFor } from "../auth/credential";
import { SessionStore } from "../auth/session-store";
import { reportError } from "../report/json-error";
import { axCall, placeholder } from "../report/next-line";
import { EXIT } from "./audit";
import { deepJourneyCommand } from "./deep-journey";
import { journeyCommand } from "./journey";

// The citty definition of `ax journey`. With no goal of its own it runs one of ora's curated
// tasks on ora.ai's public journeys, free (journeyRoute); with a goal, one journey drawn live on
// ora's platform. Every command function returns its exit code; the run assigns it to
// process.exitCode and never calls process.exit() (ax invariant 10: a large --json document must
// drain before the process ends).

/** The harness a goal runs on when none is named. */
export const DEFAULT_HARNESS = "claude-code";

const JOURNEY_ARGS = {
	goal: {
		type: "positional",
		description:
			"What the agent should do, in plain words. Leave it out to run one of ora's curated tasks, free",
		required: false,
	},
	domain: {
		type: "string",
		description: "Site the agent works on (e.g. stripe.com)",
	},
	harness: {
		type: "string",
		description: `Agent harness for a goal of your own (default ${DEFAULT_HARNESS})`,
	},
	model: {
		type: "string",
		description: "Model for a goal of your own (the harness default when omitted)",
	},
	intent: {
		type: "string",
		description: "One of ora's curated tasks, e.g. pricing, signup, api-docs (a free run)",
	},
	agent: {
		type: "string",
		description:
			"Agent from ora's public roster for a free run (default cas-haiku, Claude Code on Haiku)",
	},
	"api-key": {
		type: "string",
		description:
			"ora partner API key: lets a free run take a goal of your own; also read from ORA_PARTNER_API_KEY, then ORA_SCAN_API_KEY",
	},
	"no-stream": {
		type: "boolean",
		description: "A free run prints only its result, not the live view",
		default: false,
	},
	json: {
		type: "boolean",
		description: "Print JSON on stdout instead of the report",
		default: false,
	},
} as const;

/**
 * Whether `--no-stream` was given. citty reads `--no-<name>` as `<name>: false`, so the flag
 * arrives as `stream: false` and the declared `no-stream` arg keeps its default.
 */
export function noStreamFlag(args: Record<string, unknown>): boolean {
	return args.stream === false || args["no-stream"] === true;
}

/** Flags only ora.ai's public journeys read. */
const PUBLIC_FLAGS = ["intent", "agent", "api-key", "no-stream"] as const;
/** Flags only ora's platform journeys read. */
const PLATFORM_FLAGS = ["harness", "model"] as const;

export type JourneyRoute =
	| { route: "public" }
	| { route: "platform" }
	| { error: string; drop: readonly string[] };

/**
 * Which system a journey runs on. A public flag, or no goal at all, means ora.ai's public
 * journeys: a curated task, free, or a goal of your own with a partner key. Otherwise a goal runs
 * on ora's platform, except that a goal with only a partner key set (no ORA_API_KEY) takes the
 * partner tier, which is what `ax deep-journey --task` did. `drop` names the flags to remove when
 * both kinds were given.
 */
export function journeyRoute(input: {
	goal: string | undefined;
	publicFlags: readonly string[];
	platformFlags: readonly string[];
	platformKey: boolean;
	partnerKey: boolean;
}): JourneyRoute {
	const { goal, publicFlags, platformFlags } = input;
	if (publicFlags.length > 0 && platformFlags.length > 0) {
		const pub = publicFlags.map((f) => `--${f}`).join(", ");
		const platform = platformFlags.map((f) => `--${f}`).join(", ");
		return {
			error: `${pub} ${publicFlags.length === 1 ? "is" : "are"} for ora's free journeys and ${platform} for ora's platform; use one kind`,
			drop: publicFlags.map((f) => `--${f}`),
		};
	}
	if (publicFlags.length > 0) return { route: "public" };
	if (platformFlags.length > 0) return { route: "platform" };
	if (goal === undefined) return { route: "public" };
	if (!input.platformKey && input.partnerKey) return { route: "public" };
	return { route: "platform" };
}

/** The flag names present in the raw args, in the order of `names`. */
function present(rawArgs: readonly string[], names: readonly string[]): string[] {
	const typed = new Set<string>();
	for (const arg of rawArgs) {
		if (arg === "--") break;
		if (arg.startsWith("--"))
			typed.add(
				arg
					.slice(2)
					.split("=")[0]
					.replace(/^no-(?!stream)/, ""),
			);
	}
	return names.filter((name) => typed.has(name));
}

/** The flags that take a value, so the scan below skips it. */
const VALUE_FLAGS: ReadonlySet<string> = new Set(
	Object.entries(JOURNEY_ARGS)
		.filter(([, def]) => def.type === "string")
		.map(([name]) => `--${name}`),
);

/** The raw args without the named flags and their values; the rest stays as typed. */
function withoutFlags(rawArgs: readonly string[], names: readonly string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--") {
			kept.push(...rawArgs.slice(i));
			break;
		}
		const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		if (!names.includes(name)) kept.push(arg);
		else if (!arg.includes("=") && VALUE_FLAGS.has(name)) i++;
	}
	return kept;
}

interface JourneyArgs {
	goal?: string;
	intent?: string;
	agent?: string;
	apiKey?: string;
	noStream: boolean;
	domain?: string;
	harness?: string;
	model?: string;
	json: boolean;
}

/** A free run on ora.ai's public journeys: a curated task, or a goal of your own with a partner key. */
function runFree(input: JourneyArgs): Promise<number> | number {
	const { json } = input;
	if (!input.domain?.trim()) {
		const message = "--domain names the site the agent works on";
		const next = {
			call: axCall(["journey", "--domain", placeholder("domain"), ...(json ? ["--json"] : [])]),
			why: "ora picks the task",
		};
		reportError({ code: "INVALID_TARGET", message, next }, { json });
		return EXIT.USAGE;
	}
	return deepJourneyCommand({
		url: input.domain,
		intent: input.intent,
		task: input.goal,
		apiKey: input.apiKey,
		agent: input.agent,
		json,
		noStream: input.noStream,
		via: "journey",
	});
}

async function runJourney(input: JourneyArgs, rawArgs: readonly string[]): Promise<number> {
	const { goal, json } = input;
	const route = journeyRoute({
		goal,
		publicFlags: present(rawArgs, PUBLIC_FLAGS),
		platformFlags: present(rawArgs, PLATFORM_FLAGS),
		// Signed in through the browser counts as having a platform key: a goal then runs on the platform.
		platformKey:
			Boolean(process.env.ORA_API_KEY) || signInFor(platformBase(), new SessionStore()) !== null,
		partnerKey: Boolean(
			input.apiKey || process.env.ORA_PARTNER_API_KEY || process.env.ORA_SCAN_API_KEY,
		),
	});
	if ("error" in route) {
		const next = {
			call: axCall(["journey", ...withoutFlags(rawArgs, route.drop)]),
			why: "for ora's platform",
		};
		reportError({ code: "INVALID_FLAG", message: route.error, next }, { json });
		return EXIT.USAGE;
	}
	if (route.route === "public") return runFree(input);
	if (goal === undefined) {
		const flags = present(rawArgs, PLATFORM_FLAGS).map((f) => `--${f}`);
		const message = `${flags.join(", ")} ${flags.length === 1 ? "picks" : "pick"} the agent for a goal of your own; with no goal, ax runs one of ora's curated tasks free`;
		const next = {
			call: axCall(["journey", ...withoutFlags(rawArgs, flags)]),
			why: "ora picks the task",
		};
		reportError({ code: "INVALID_FLAG", message, next }, { json });
		return EXIT.USAGE;
	}
	return journeyCommand({
		intent: goal,
		domain: input.domain,
		harness: input.harness ?? DEFAULT_HARNESS,
		model: input.model,
		json,
	});
}

const JOURNEY_DESCRIPTION =
	"Send a real AI agent at a site and watch it live: free on one of ora's curated tasks, or on a goal of your own with a platform key";

export const journey = defineCommand({
	meta: { name: "journey", description: JOURNEY_DESCRIPTION },
	args: JOURNEY_ARGS,
	async run({ args, rawArgs }) {
		// Same exitCode-over-exit rule as audit: let stdout drain before exiting.
		process.exitCode = await runJourney(
			{
				goal: args.goal as string | undefined,
				intent: args.intent as string | undefined,
				agent: args.agent as string | undefined,
				apiKey: args["api-key"] as string | undefined,
				noStream: noStreamFlag(args),
				domain: args.domain as string | undefined,
				harness: args.harness as string | undefined,
				model: args.model as string | undefined,
				json: Boolean(args.json),
			},
			rawArgs,
		);
	},
});

/** `ax journey --help`: citty's generated usage cannot show both forms. */
export function journeyUsage(): string {
	const d = pc.dim;
	const h = (title: string) => pc.underline(pc.bold(title));
	return [
		d(`${JOURNEY_DESCRIPTION} (ax journey)`),
		"",
		h("USAGE"),
		"",
		"  ax journey --domain <site> [--intent <id>] [--agent <id>] [--no-stream] [--json]",
		`  ax journey "<goal>" [--domain <site>] [--harness <h>] [--model <m>] [--json]`,
		"",
		"  With no goal, ax runs one of ora's curated tasks on ora.ai's public journeys: free, no key.",
		"  With a goal, the journey runs on ora's platform: signed in with ax login, or with your platform key.",
		"",
		h("FREE, NO GOAL OF YOUR OWN"),
		"",
		`  --domain <site>  ${d("Site the agent works on (required)")}`,
		`  --intent <id>    ${d("Curated task id, e.g. pricing, signup, api-docs (ora picks one when omitted)")}`,
		`  --agent <id>     ${d("Agent from ora's public roster (default cas-haiku, Claude Code on Haiku)")}`,
		`  --api-key <k>    ${d("ora partner API key: allows a goal of your own here; also read from ORA_PARTNER_API_KEY, then ORA_SCAN_API_KEY")}`,
		`  --no-stream      ${d("Print only the result, not the live view")}`,
		`  --json           ${d("Print the finished run as JSON")}`,
		`  ${d("these flags cannot be combined with --harness or --model")}`,
		`  ${d("exit codes: 0 the run finished (any verdict) · 1 the run failed · 2 usage · 3 API error")}`,
		`  ${d("ax deep-journey <url> is the older name for this; it still works and will be removed in a future major release")}`,
		"",
		h("A GOAL OF YOUR OWN"),
		"",
		`  --domain <site>  ${d("Site the agent works on (e.g. stripe.com)")}`,
		`  --harness <h>    ${d(`Agent harness: ${DEFAULT_HARNESS} (default), codex, openclaw, hermess, claude-agent, eve, ...`)}`,
		`  --model <m>      ${d("Model override (the harness default when omitted)")}`,
		`  --json           ${d("Print the run as JSON")}`,
		`  ${d("needs ax login (a browser sign-in), or ORA_API_KEY (see .env.example)")}`,
		`  ${d("exit codes: 0 the run succeeded · 1 it finished without success · 2 error")}`,
	].join("\n");
}
