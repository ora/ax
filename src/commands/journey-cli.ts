import { defineCommand, runCommand } from "citty";
import pc from "picocolors";
import { SET_USAGE_CALL } from "../journey-set/report-flow";
import {
	DEFAULT_HARNESS,
	DEFAULT_WAIT_MINUTES,
	journeyMode,
	MAX_AGENTS,
	MAX_GOALS,
	MAX_REPEAT,
} from "../journey-set/spec";
import { reportError } from "../report/json-error";
import { axCall, placeholder } from "../report/next-line";
import { EXIT } from "./audit";
import { deepJourneyCommand } from "./deep-journey";
import { journeyCommand } from "./journey";
import { journeySetRunCommand, journeySetViewCommand } from "./journey-set";
import { journeySetCancelCommand, journeySetListCommand } from "./journey-set-records";

// The citty definition of `ax journey`. With no goal of its own it runs one of ora's curated
// tasks on ora.ai's public journeys, free (journeyRoute); with a goal, one journey drawn live or
// a set of journeys on your Front account, as journeyMode reads the flags; plus `view`, `list`
// and `cancel` for recorded sets. Those three
// are words the run dispatches on, not citty subcommands: citty refuses a first positional that
// names no subcommand, so a goal in plain words could not sit beside them. Every command function
// returns its exit code; the runs assign it to process.exitCode and never call process.exit()
// (ax invariant 10: a large --json document must drain before the process ends). The test seams
// of the command functions (setsDir, client, now, sleep, ask) get no flag.

const JSON_ARG = {
	type: "boolean",
	description: "Print JSON on stdout instead of the report",
	default: false,
} as const;

const WAIT_ARG = {
	type: "string",
	description: `Minutes to follow the runs before printing what has finished (default ${DEFAULT_WAIT_MINUTES})`,
} as const;

const SET_ID_ARG = {
	type: "positional",
	description: "Set id (see ax journey list)",
	required: true,
} as const;

const VIEW_DESCRIPTION = "Pick up a recorded set, follow its runs, and print the report";
const LIST_DESCRIPTION = "List the sets recorded on this machine; makes no API call";
const CANCEL_DESCRIPTION = "Stop the runs of a recorded set that are still going";

const view = defineCommand({
	meta: { name: "view", description: VIEW_DESCRIPTION },
	args: { id: SET_ID_ARG, wait: WAIT_ARG, json: JSON_ARG },
	async run({ args }) {
		process.exitCode = await journeySetViewCommand({
			id: args.id as string,
			wait: args.wait as string | undefined,
			json: Boolean(args.json),
		});
	},
});

const list = defineCommand({
	meta: { name: "list", description: LIST_DESCRIPTION },
	args: { json: JSON_ARG },
	async run({ args }) {
		process.exitCode = journeySetListCommand({ json: Boolean(args.json) });
	},
});

const cancel = defineCommand({
	meta: { name: "cancel", description: CANCEL_DESCRIPTION },
	args: {
		id: SET_ID_ARG,
		json: { ...JSON_ARG, description: "Print the platform's answer as JSON" },
	},
	async run({ args }) {
		process.exitCode = await journeySetCancelCommand({
			id: args.id as string,
			json: Boolean(args.json),
		});
	},
});

const SET_COMMANDS = {
	view: (rawArgs: string[]) => runCommand(view, { rawArgs }),
	list: (rawArgs: string[]) => runCommand(list, { rawArgs }),
	cancel: (rawArgs: string[]) => runCommand(cancel, { rawArgs }),
};

function isSetCommand(word: string | undefined): word is keyof typeof SET_COMMANDS {
	return word !== undefined && Object.hasOwn(SET_COMMANDS, word);
}

const JOURNEY_ARGS = {
	goal: {
		type: "positional",
		description: `What the agent should do, in plain words; up to ${MAX_GOALS} goals run a set. Leave it out to run one of ora's curated tasks, free`,
		required: false,
	},
	domain: {
		type: "string",
		description: "Site the agent works on, a domain or an http(s) URL (a set needs one)",
	},
	harness: {
		type: "string",
		description: `Agent harness for one agent (default ${DEFAULT_HARNESS})`,
	},
	model: { type: "string", description: "Model for one agent (the harness default when omitted)" },
	agents: {
		type: "string",
		description: `Agents as harness or harness/model, comma separated (up to ${MAX_AGENTS})`,
	},
	levels: {
		type: "boolean",
		description: "Run each goal at the levels of help and count them",
		default: false,
	},
	brand: { type: "string", description: "Brand for the brand level; turns levels on" },
	docs: { type: "string", description: "Documentation URL; adds the docs level" },
	exact: { type: "string", description: "URL the agent starts at; adds the exact level" },
	repeat: {
		type: "string",
		description: `Runs for each goal, level and agent (1 to ${MAX_REPEAT}; default 1)`,
	},
	yes: { type: "boolean", description: "Launch a set without asking", default: false },
	wait: WAIT_ARG,
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
	json: JSON_ARG,
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
/** Flags only your Front account's journeys read. */
const FRONT_FLAGS = [
	"harness",
	"model",
	"agents",
	"levels",
	"brand",
	"docs",
	"exact",
	"repeat",
	"yes",
	"wait",
] as const;

export type JourneyRoute =
	| { route: "public" }
	| { route: "front" }
	| { error: string; drop: readonly string[] };

/**
 * Which system a journey runs on. A public flag, or no goal at all, means ora.ai's public
 * journeys: a curated task, free, or a goal of your own with a partner key. Otherwise a goal runs
 * on your Front account, except that a goal with only a partner key set (no ORA_API_KEY) takes the
 * partner tier, which is what `ax deep-journey --task` did. `drop` names the flags to remove when
 * both kinds were given.
 */
export function journeyRoute(input: {
	goals: readonly string[];
	publicFlags: readonly string[];
	frontFlags: readonly string[];
	frontKey: boolean;
	partnerKey: boolean;
}): JourneyRoute {
	const { goals, publicFlags, frontFlags } = input;
	if (publicFlags.length > 0 && frontFlags.length > 0) {
		const pub = publicFlags.map((f) => `--${f}`).join(", ");
		const front = frontFlags.map((f) => `--${f}`).join(", ");
		return {
			error: `${pub} ${publicFlags.length === 1 ? "is" : "are"} for ora's free journeys and ${front} for your Front account's; use one kind`,
			drop: publicFlags.map((f) => `--${f}`),
		};
	}
	if (publicFlags.length > 0) return { route: "public" };
	if (frontFlags.length > 0) return { route: "front" };
	if (goals.length === 0) return { route: "public" };
	if (goals.length === 1 && !input.frontKey && input.partnerKey) return { route: "public" };
	return { route: "front" };
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

/** The flags that take a value, so the scans below skip it. */
const VALUE_FLAGS: ReadonlySet<string> = new Set(
	Object.entries(JOURNEY_ARGS)
		.filter(([, def]) => def.type === "string")
		.map(([name]) => `--${name}`),
);

/**
 * Where the first positional sits in the raw args, found the way citty finds a subcommand: the
 * value after a string flag is skipped even when it starts with `-`, `--name=value` is one
 * argument, and after `--` every argument is positional. -1 when there is none.
 */
export function firstPositional(rawArgs: readonly string[]): number {
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--") return i + 1 < rawArgs.length ? i + 1 : -1;
		if (!arg.startsWith("-")) return i;
		if (!arg.includes("=") && VALUE_FLAGS.has(arg)) i++;
	}
	return -1;
}

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
	goals: string[];
	intent?: string;
	agent?: string;
	apiKey?: string;
	noStream: boolean;
	domain?: string;
	harness?: string;
	model?: string;
	agents?: string;
	levels: boolean;
	brand?: string;
	docs?: string;
	exact?: string;
	repeat?: string;
	wait?: string;
	yes: boolean;
	json: boolean;
}

/** --harness and --model as one --agents entry, for a set that names its agent the long way. */
function agentEntry(harness: string | undefined, model: string | undefined): string | undefined {
	if (harness === undefined && model === undefined) return undefined;
	const named = harness ?? DEFAULT_HARNESS;
	return model === undefined ? named : `${named}/${model}`;
}

/** A free run on ora.ai's public journeys: a curated task, or a goal of your own with a partner key. */
function runFree(input: JourneyArgs): Promise<number> | number {
	const { goals, json } = input;
	const next = (why: string) => ({
		call: axCall(["journey", "--domain", placeholder("domain"), ...(json ? ["--json"] : [])]),
		why,
	});
	if (goals.length > 1) {
		const message = "a free run takes one goal; several goals run a set, on your Front account";
		reportError(
			{ code: "INVALID_SPEC", message, next: { call: SET_USAGE_CALL, why: "for a set" } },
			{ json },
		);
		return EXIT.USAGE;
	}
	if (!input.domain?.trim()) {
		const message = "--domain names the site the agent works on";
		reportError({ code: "INVALID_TARGET", message, next: next("ora picks the task") }, { json });
		return EXIT.USAGE;
	}
	return deepJourneyCommand({
		url: input.domain,
		intent: input.intent,
		task: goals[0],
		apiKey: input.apiKey,
		agent: input.agent,
		json,
		noStream: input.noStream,
		via: "journey",
	});
}

/** One journey or a set; --yes and --wait only mean something to a set, so one journey ignores them. */
async function runJourney(input: JourneyArgs, rawArgs: readonly string[]): Promise<number> {
	const { goals, harness, model, agents, json } = input;
	const route = journeyRoute({
		goals,
		publicFlags: present(rawArgs, PUBLIC_FLAGS),
		frontFlags: present(rawArgs, FRONT_FLAGS),
		frontKey: Boolean(process.env.ORA_API_KEY),
		partnerKey: Boolean(
			input.apiKey || process.env.ORA_PARTNER_API_KEY || process.env.ORA_SCAN_API_KEY,
		),
	});
	if ("error" in route) {
		const next = {
			call: axCall(["journey", ...withoutFlags(rawArgs, route.drop)]),
			why: "for your Front account",
		};
		reportError({ code: "INVALID_FLAG", message: route.error, next }, { json });
		return EXIT.USAGE;
	}
	if (route.route === "public") return runFree(input);
	if (agents !== undefined && (harness !== undefined || model !== undefined)) {
		const flag = harness !== undefined ? "--harness" : "--model";
		const message = `--agents cannot be combined with ${flag}: name each agent in --agents as harness or harness/model`;
		const next = {
			call: axCall(["journey", ...withoutFlags(rawArgs, ["--harness", "--model"])]),
			why: "--agents alone names the agents",
		};
		reportError({ code: "INVALID_FLAG", message, next }, { json });
		return EXIT.USAGE;
	}
	const mode = journeyMode(input);
	if ("error" in mode) {
		const next = { call: SET_USAGE_CALL, why: "with the value named above fixed" };
		reportError({ code: "INVALID_SPEC", message: mode.error, next }, { json });
		return EXIT.USAGE;
	}
	if (!mode.value.set) {
		const [agent] = mode.value.agents;
		return journeyCommand({
			intent: goals[0],
			domain: input.domain,
			harness: agent?.harness ?? harness ?? DEFAULT_HARNESS,
			model: agent?.model ?? model,
			json,
		});
	}
	return journeySetRunCommand({
		site: input.domain,
		goals,
		agents: agents ?? agentEntry(harness, model),
		levels: input.levels,
		brand: input.brand,
		docs: input.docs,
		exact: input.exact,
		repeat: input.repeat,
		wait: input.wait,
		yes: input.yes,
		json,
	});
}

const JOURNEY_DESCRIPTION =
	"Send a real AI agent at a site and watch it live: free on one of ora's curated tasks, or on a goal of your own with a Front API key, one journey or a set with the verdicts counted";

export const journey = defineCommand({
	meta: { name: "journey", description: JOURNEY_DESCRIPTION },
	args: JOURNEY_ARGS,
	async run({ args, rawArgs }) {
		const at = firstPositional(rawArgs);
		const word = rawArgs[at];
		if (isSetCommand(word)) {
			const rest = [...rawArgs.slice(0, at), ...rawArgs.slice(at + 1)];
			await SET_COMMANDS[word](rest);
			return;
		}
		// Same exitCode-over-exit rule as audit: let stdout drain before exiting.
		process.exitCode = await runJourney(
			{
				goals: args._,
				intent: args.intent as string | undefined,
				agent: args.agent as string | undefined,
				apiKey: args["api-key"] as string | undefined,
				noStream: noStreamFlag(args),
				domain: args.domain as string | undefined,
				harness: args.harness as string | undefined,
				model: args.model as string | undefined,
				agents: args.agents as string | undefined,
				levels: Boolean(args.levels),
				brand: args.brand as string | undefined,
				docs: args.docs as string | undefined,
				exact: args.exact as string | undefined,
				repeat: args.repeat as string | undefined,
				wait: args.wait as string | undefined,
				yes: Boolean(args.yes),
				json: Boolean(args.json),
			},
			rawArgs,
		);
	},
});

/** `ax journey --help`: citty's generated usage cannot show both forms and the three commands. */
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
		`  ax journey "<goal>" ["<goal>" ...] --domain <site> [--agents <list>] [--levels]`,
		"    [--brand <name>] [--docs <url>] [--exact <url>] [--repeat <n>] [--yes] [--wait <min>] [--json]",
		"  ax journey view <id> [--wait <min>] [--json]",
		"  ax journey list [--json]",
		"  ax journey cancel <id> [--json]",
		"",
		"  With no goal, ax runs one of ora's curated tasks on ora.ai's public journeys: free, no key.",
		"  With a goal, the journey runs on your Front account.",
		"",
		"  One goal and one agent, with no --repeat and no levels: ax runs one journey and draws it",
		"  live. Ask for more (several goals or agents, --repeat, or levels with --levels, --docs,",
		"  --exact or --brand) and ax runs a set of journeys: it previews the set, asks before",
		"  launching, waits for the platform's verdicts and counts them.",
		"",
		h("FREE, NO GOAL OF YOUR OWN"),
		"",
		`  --domain <site>  ${d("Site the agent works on (required)")}`,
		`  --intent <id>    ${d("Curated task id, e.g. pricing, signup, api-docs (ora picks one when omitted)")}`,
		`  --agent <id>     ${d("Agent from ora's public roster (default cas-haiku, Claude Code on Haiku)")}`,
		`  --api-key <k>    ${d("ora partner API key: allows a goal of your own here; also read from ORA_PARTNER_API_KEY, then ORA_SCAN_API_KEY")}`,
		`  --no-stream      ${d("Print only the result, not the live view")}`,
		`  --json           ${d("Print the finished run as JSON")}`,
		`  ${d("these flags cannot be combined with the Front flags below")}`,
		`  ${d("exit codes: 0 the run finished (any verdict) · 1 the run failed · 2 usage · 3 API error")}`,
		`  ${d("ax deep-journey <url> is the older name for this; it still works and will be removed in a future major release")}`,
		"",
		h("ONE JOURNEY"),
		"",
		`  --domain <site>  ${d("Site the agent works on (e.g. stripe.com)")}`,
		`  --harness <h>    ${d(`Agent harness: ${DEFAULT_HARNESS} (default), codex, openclaw, hermess, claude-agent, eve, ...`)}`,
		`  --model <m>      ${d("Model override (the harness default when omitted)")}`,
		`  --agents <a>     ${d("One agent as harness or harness/model, instead of --harness and --model")}`,
		`  --json           ${d("Print the run as JSON")}`,
		`  ${d("exit codes: 0 the run succeeded · 1 it finished without success · 2 error")}`,
		"",
		h("A SET OF JOURNEYS"),
		"",
		`  <goal> ...       ${d(`1 to ${MAX_GOALS} goals, each in quotes`)}`,
		`  --domain <site>  ${d("Site the agents work on, a domain or an http(s) URL (required)")}`,
		`  --agents <list>  ${d(`Agents as harness or harness/model, comma separated (up to ${MAX_AGENTS}; default: your plan's Claude Code agent, else the first it offers)`)}`,
		`  --levels         ${d("Run each goal at the levels of help: need only, brand named, docs linked, exact target")}`,
		`  --brand <name>   ${d("Brand for the brand level (default: the site's name); turns levels on")}`,
		`  --docs <url>     ${d("Documentation URL; adds the docs level and turns levels on")}`,
		`  --exact <url>    ${d("URL the agent starts at; adds the exact level and turns levels on")}`,
		`  --repeat <n>     ${d(`Runs for each goal, level and agent (1 to ${MAX_REPEAT}; default 1)`)}`,
		`  --yes            ${d("Launch without asking after the preview")}`,
		`  --wait <min>     ${d(`Minutes to follow the runs before printing what has finished (default ${DEFAULT_WAIT_MINUTES})`)}`,
		`  --json           ${d("Print one JSON document on stdout instead of the report")}`,
		`  ${d("--harness and --model name one agent for a set too; --agents cannot be combined with them")}`,
		`  ${d("without levels, each goal runs once as written; the preview shows the runs before any start")}`,
		`  ${d("exit codes: 0 report printed, even with runs unfinished · 2 usage or refusal before launch · 3 API error · 130 Ctrl-C")}`,
		"",
		h("COMMANDS"),
		"",
		`  view <id>        ${d(`${VIEW_DESCRIPTION}; takes --wait and --json`)}`,
		`  list             ${d(`${LIST_DESCRIPTION}; takes --json`)}`,
		`  cancel <id>      ${d(`${CANCEL_DESCRIPTION}; takes --json`)}`,
		`  ${d("a goal cannot be just view, list or cancel: ax runs the command of that name")}`,
		"",
		`  ${d("--yes and --wait apply to a set; one journey ignores them.")}`,
		`  ${d("A goal of your own needs a Front API key as ORA_API_KEY; sign up at app.ora.ai (see the README's Get a key).")}`,
	].join("\n");
}
