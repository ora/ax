import type { SetRequest } from "../api/sets";

// What a person typed, as the request the platform takes. Nothing is decided here that the
// platform decides: which levels run, which agent a bare harness means, how many runs a set
// starts and whether it fits are all in the preview's answer. This module only refuses what
// cannot be a request at all (no site, a repeat that is not a number).

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
