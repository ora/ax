import { defineCommand } from "citty";
import pc from "picocolors";
import { platformBase } from "../api/platform-origins";
import { type PlatformCredentials, platformCredentials } from "../auth/resolve-credential";
import { positionals, SET_FLAGS, subcommandOf } from "../journey-set/args";
import { reportError } from "../report/json-error";
import { axCall, placeholder } from "../report/next-line";
import { deepJourneyCommand } from "./deep-journey";
import { EXIT } from "./exit-codes";
import { journeyCommand } from "./journey";
import { journeySetCancel, journeySetList, journeySetRun, journeySetView } from "./journey-set";

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
	agents: {
		type: "string",
		description: "A set: 1 to 4 agents as harness or harness/model, comma separated",
	},
	levels: {
		type: "boolean",
		description: "A set: run each goal at the levels of help",
		default: false,
	},
	brand: {
		type: "string",
		description: "A set: the brand named at the brand and docs levels (turns levels on)",
	},
	docs: {
		type: "string",
		description: "A set: the documentation URL (turns levels on, adds the docs level)",
	},
	exact: {
		type: "string",
		description: "A set: the page the agent starts at (turns levels on, adds the exact level)",
	},
	repeat: {
		type: "string",
		description: "A set: runs per goal, level and agent, 1 to 10",
	},
	yes: {
		type: "boolean",
		description: "A set: launch without asking",
		default: false,
	},
	wait: {
		type: "string",
		description: "A set: minutes to watch the runs before stopping (default 60)",
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
 * on ora's platform, except that a goal with only a partner key set (no platform credential: no
 * ORA_API_KEY and no sign-in) takes the partner tier, which is what `ax deep-journey --task` did.
 * `drop` names the flags to remove when both kinds were given.
 */
export function journeyRoute(input: {
	goal: string | undefined;
	publicFlags: readonly string[];
	platformFlags: readonly string[];
	/** A credential for ora's platform is there: a key, or a sign-in for it. */
	platformCredential: boolean;
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
	if (!input.platformCredential && input.partnerKey) return { route: "public" };
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
	agents?: string;
	levels: boolean;
	brand?: string;
	docs?: string;
	exact?: string;
	repeat?: string;
	yes: boolean;
	wait?: string;
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

/**
 * A set of journeys, when the arguments ask for one: `view`, `list` or `cancel` in the first goal's
 * place, more than one goal, or any flag only a set reads. Undefined: one journey, as before.
 */
function runSet(
	input: JourneyArgs,
	rawArgs: readonly string[],
	credentials: PlatformCredentials,
): Promise<number> | undefined {
	const { json } = input;
	const words = positionals(rawArgs, VALUE_FLAGS);
	const subcommand = subcommandOf(words[0]);
	if (subcommand === "view")
		return journeySetView({ id: words[1], wait: input.wait, json, credentials });
	if (subcommand === "list") return journeySetList({ json, credentials });
	if (subcommand === "cancel") return journeySetCancel({ id: words[1], json, credentials });
	if (words.length < 2 && present(rawArgs, SET_FLAGS).length === 0) return undefined;
	return journeySetRun({
		goals: words,
		flags: {
			domain: input.domain,
			agents: input.agents,
			harness: input.harness,
			model: input.model,
			levels: input.levels,
			brand: input.brand,
			docs: input.docs,
			exact: input.exact,
			repeat: input.repeat,
		},
		yes: input.yes,
		wait: input.wait,
		json,
		credentials,
	});
}

async function runJourney(
	input: JourneyArgs,
	rawArgs: readonly string[],
	credentials: PlatformCredentials,
): Promise<number> {
	const set = runSet(input, rawArgs, credentials);
	if (set !== undefined) return set;
	const { goal, json } = input;
	const route = journeyRoute({
		goal,
		publicFlags: present(rawArgs, PUBLIC_FLAGS),
		platformFlags: present(rawArgs, PLATFORM_FLAGS),
		// The chain every platform call signs with decides: a key, or a sign-in for this platform.
		platformCredential: credentials.chain.find(platformBase()) !== null,
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
	return journeyCommand(
		{
			intent: goal,
			domain: input.domain,
			harness: input.harness ?? DEFAULT_HARNESS,
			model: input.model,
			json,
		},
		{ credentials },
	);
}

const JOURNEY_DESCRIPTION =
	"Send a real AI agent at a site and watch it live: free on one of ora's curated tasks, or on a goal of your own with a platform key";

/**
 * `ax journey`, with the credentials a goal of your own signs in with: ax's own chain unless a
 * caller (a test) hands in another. Made when the command runs, after the local .env is loaded.
 */
export function journeyCommandDefinition(
	credentials: () => PlatformCredentials = () => platformCredentials(),
) {
	return defineCommand({
		meta: { name: "journey", description: JOURNEY_DESCRIPTION },
		args: JOURNEY_ARGS,
		async run({ args, rawArgs }) {
			// Same exitCode-over-exit rule as audit: let stdout drain before exiting.
			process.exitCode = await runJourney(
				{
					agents: args.agents as string | undefined,
					levels: Boolean(args.levels),
					brand: args.brand as string | undefined,
					docs: args.docs as string | undefined,
					exact: args.exact as string | undefined,
					repeat: args.repeat as string | undefined,
					yes: Boolean(args.yes),
					wait: args.wait as string | undefined,
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
				credentials(),
			);
		},
	});
}

export const journey = journeyCommandDefinition();

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
		`  ax journey "<goal>" ["<goal>" ...] --domain <site> [--agents <a>,...] [--levels] [--brand <b>] [--docs <url>] [--exact <url>] [--repeat N] [--yes] [--wait <minutes>] [--json]`,
		"  ax journey view <id> [--wait <minutes>] [--json]",
		"  ax journey list [--json]",
		"  ax journey cancel <id> [--json]",
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
		h("A SET OF JOURNEYS"),
		"",
		`  ${d("Several goals, agents, repeats or levels of help against one site. The platform runs, grades and counts; ax prints.")}`,
		`  --domain <site>   ${d("The site (required): a domain or an http(s) URL")}`,
		`  --agents <list>   ${d("1 to 4 agents as harness or harness/model, comma separated")}`,
		`  --levels          ${d("Run each goal at the levels of help: need only, brand named, and docs or exact when given")}`,
		`  --brand <name>    ${d("The brand the brand and docs levels name (default: the domain's name)")}`,
		`  --docs <url>      ${d("The documentation URL: adds the docs level")}`,
		`  --exact <url>     ${d("The page the agent starts at: adds the exact level")}`,
		`  --repeat <n>      ${d("Runs per goal, level and agent, 1 to 10 (default 1)")}`,
		`  --yes             ${d("Launch without asking")}`,
		`  --wait <minutes>  ${d("Minutes to watch before stopping (default 60); the runs go on either way")}`,
		`  ${d("needs ax login, or ORA_API_KEY with the ax.sets:read and ax.sets:write scopes")}`,
		`  ${d("exit codes: 0 a report printed, or the question was declined · 2 usage or a refusal before launch · 3 the platform failed · 130 Ctrl-C")}`,
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
