import type { SetRequest } from "../api/sets";

// What a person typed, as the request the platform takes. Nothing is decided here that the
// platform decides: which levels run, which agent a bare harness means, how many runs a set
// starts and whether it fits are all in the preview's answer. This module only refuses what
// cannot be a request at all (no site, a repeat that is not a number).

/** The words after `ax journey` that are not flags or flag values: the goals, or a subcommand and its id. */
export function positionals(rawArgs: readonly string[], valueFlags: ReadonlySet<string>): string[] {
	const found: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--") {
			found.push(...rawArgs.slice(i + 1));
			break;
		}
		if (!arg.startsWith("-")) {
			found.push(arg);
			continue;
		}
		if (!arg.includes("=") && valueFlags.has(arg)) i++;
	}
	return found;
}

/** The subcommands that take the first goal's place. A goal cannot be exactly one of these words. */
export const SET_SUBCOMMANDS = ["view", "list", "cancel"] as const;
export type SetSubcommand = (typeof SET_SUBCOMMANDS)[number];

export function subcommandOf(word: string | undefined): SetSubcommand | undefined {
	return SET_SUBCOMMANDS.find((name) => name === word);
}

/** The flags that make `ax journey "<goal>"` a set rather than one journey. */
export const SET_FLAGS = [
	"agents",
	"levels",
	"brand",
	"docs",
	"exact",
	"repeat",
	"yes",
	"wait",
	"watch",
] as const;

export interface SetFlags {
	domain?: string;
	agents?: string;
	harness?: string;
	model?: string;
	levels: boolean;
	brand?: string;
	docs?: string;
	exact?: string;
	repeat?: string;
}

export type SetRequestResult = { request: SetRequest } | { problem: string };

/** A whole number of 1 or more, or undefined when the text is not one. */
export function wholeNumber(text: string): number | undefined {
	return /^[1-9]\d*$/.test(text.trim()) ? Number(text.trim()) : undefined;
}

export function setRequestOf(goals: readonly string[], flags: SetFlags): SetRequestResult {
	const site = flags.domain?.trim();
	if (!site) return { problem: "A set of journeys needs --domain: the site the agents work on" };
	if (goals.length === 0)
		return { problem: "A set of journeys needs at least one goal, in quotes" };
	if (flags.agents !== undefined && (flags.harness !== undefined || flags.model !== undefined)) {
		return {
			problem:
				"--agents lists the set's agents; --harness and --model name one agent. Use one or the other",
		};
	}
	let agents: string[] | undefined;
	if (flags.agents !== undefined) {
		agents = flags.agents
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name.length > 0);
		if (agents.length === 0)
			return { problem: "--agents takes agents as harness or harness/model, comma separated" };
	} else if (flags.harness !== undefined || flags.model !== undefined) {
		const harness = flags.harness?.trim() || "claude-code";
		agents = [flags.model?.trim() ? `${harness}/${flags.model.trim()}` : harness];
	}
	let repeat: number | undefined;
	if (flags.repeat !== undefined) {
		repeat = wholeNumber(flags.repeat);
		if (repeat === undefined)
			return { problem: `--repeat takes a whole number of 1 or more, not "${flags.repeat}"` };
	}
	return {
		request: {
			site,
			goals: [...goals],
			...(agents ? { agents } : {}),
			...(flags.levels ? { levels: true } : {}),
			...(flags.brand?.trim() ? { brand: flags.brand.trim() } : {}),
			...(flags.docs?.trim() ? { docs: flags.docs.trim() } : {}),
			...(flags.exact?.trim() ? { exact: flags.exact.trim() } : {}),
			...(repeat !== undefined ? { repeat } : {}),
		},
	};
}
