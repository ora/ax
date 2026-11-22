import { plain } from "../ui/ansi";

/**
 * What a set's agents are called in a row or beside a count: the harness alone where the set names that harness
 * once (the header names every agent in full, model included), else the whole id, so two models of one harness
 * stay apart. Text the platform sent, so it goes through `plain`.
 */
export function rowLabelsOf(agents: readonly string[]): Map<string, string> {
	const harnessOf = (agent: string) => plain(agent).split("/")[0];
	const named = new Map<string, number>();
	for (const agent of agents) named.set(harnessOf(agent), (named.get(harnessOf(agent)) ?? 0) + 1);
	return new Map(
		agents.map((agent) => [
			agent,
			named.get(harnessOf(agent)) === 1 ? harnessOf(agent) : plain(agent),
		]),
	);
}
