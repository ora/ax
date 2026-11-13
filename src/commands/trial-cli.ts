import { defineCommand } from "citty";
import { trialRunCommand, trialViewCommand } from "./trial";
import { trialCancelCommand, trialListCommand } from "./trial-records";

// The citty definitions for `ax trial` and its four subcommands. Every command function returns
// its exit code; the runs below assign it to process.exitCode and never call process.exit()
// (ax invariant 10: a large --json document must drain before the process ends). The test seams of
// the command functions (trialsDir, client, now, sleep, ask) get no flag.

const JSON_ARG = {
	type: "boolean",
	description: "Print one JSON document on stdout instead of the report",
	default: false,
} as const;

const WAIT_ARG = {
	type: "string",
	description: "Minutes to follow the runs before printing what has finished (default 60)",
} as const;

/** Flags of `trial run` that take a value; `--task` is one, and the scan below skips their values. */
const RUN_VALUE_FLAGS: ReadonlySet<string> = new Set([
	"--task",
	"--agents",
	"--brand",
	"--docs",
	"--exact",
	"--repeat",
	"--wait",
]);

/**
 * Every `--task` value, in the order typed. citty 0.2 keeps only the LAST value of a repeated
 * string flag (`--task a --task b` gives args.task === "b"), so the tasks are collected from the
 * raw args instead, the way citty reads them: `--task=text` or `--task text`, where the next
 * argument is the value even when it starts with `-`, a string flag swallows the value after it
 * (so `--brand --task` is a brand, not a task), a trailing `--task` is an empty task, and `--`
 * ends the flags. Without raw args (a programmatic call) the parsed value is the only task.
 */
export function collectTasks(rawArgs: readonly string[], parsed?: string): string[] {
	const tasks: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--") break;
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg : arg.slice(0, eq);
		if (!RUN_VALUE_FLAGS.has(name)) continue;
		const value = eq === -1 ? (rawArgs[++i] ?? "") : arg.slice(eq + 1);
		if (name === "--task") tasks.push(value);
	}
	if (tasks.length === 0 && parsed !== undefined) tasks.push(parsed);
	return tasks;
}

const trialRun = defineCommand({
	meta: {
		name: "run",
		description:
			"Run tasks on a site at up to four levels of help, count how often agents finish, and print the report (exit codes: 0 report printed, 2 usage or refusal, 3 API error, 130 Ctrl-C)",
	},
	args: {
		site: {
			type: "positional",
			description: "Site the agents work on (e.g. linear.app)",
			required: true,
		},
		task: {
			type: "string",
			description:
				'What the agents should do, in plain words; repeat the flag for up to 5 tasks (e.g. --task "Find how to create an issue from the API")',
		},
		agents: {
			type: "string",
			description:
				"Agents to run, as harness or harness/model, separated by commas (up to 4; default: the first agent your plan offers)",
		},
		brand: {
			type: "string",
			description:
				"Brand name for the brand level (default: the site's name, Linear for linear.app)",
		},
		docs: { type: "string", description: "Documentation URL; adds the docs level" },
		exact: { type: "string", description: "URL the agent starts at; adds the exact level" },
		repeat: {
			type: "string",
			description: "Runs for each task, level and agent (1 to 10; default 1)",
		},
		yes: {
			type: "boolean",
			description: "Launch without asking after the preview",
			default: false,
		},
		wait: WAIT_ARG,
		json: JSON_ARG,
	},
	async run({ args, rawArgs }) {
		// Same exitCode-over-exit rule as audit: let stdout drain before exiting.
		process.exitCode = await trialRunCommand({
			site: args.site as string,
			tasks: collectTasks(rawArgs, args.task as string | undefined),
			agents: args.agents as string | undefined,
			brand: args.brand as string | undefined,
			docs: args.docs as string | undefined,
			exact: args.exact as string | undefined,
			repeat: args.repeat as string | undefined,
			wait: args.wait as string | undefined,
			yes: Boolean(args.yes),
			json: Boolean(args.json),
		});
	},
});

const trialView = defineCommand({
	meta: {
		name: "view",
		description:
			"Pick up a recorded trial, follow its runs, and print the report (exit codes: 0 report printed, 2 usage, 3 API error, 130 Ctrl-C)",
	},
	args: {
		id: { type: "positional", description: "Trial id (see ax trial list)", required: true },
		wait: WAIT_ARG,
		json: JSON_ARG,
	},
	async run({ args }) {
		process.exitCode = await trialViewCommand({
			id: args.id as string,
			wait: args.wait as string | undefined,
			json: Boolean(args.json),
		});
	},
});

const trialList = defineCommand({
	meta: {
		name: "list",
		description: "List the trials recorded on this machine; makes no API call (exit code 0)",
	},
	args: { json: JSON_ARG },
	async run({ args }) {
		process.exitCode = trialListCommand({ json: Boolean(args.json) });
	},
});

const trialCancel = defineCommand({
	meta: {
		name: "cancel",
		description:
			"Stop the runs of a recorded trial that are still going (exit codes: 0 ok, 2 usage, 3 API error)",
	},
	args: {
		id: { type: "positional", description: "Trial id (see ax trial list)", required: true },
		json: { ...JSON_ARG, description: "Print the platform's cancel answer as JSON" },
	},
	async run({ args }) {
		process.exitCode = await trialCancelCommand({
			id: args.id as string,
			json: Boolean(args.json),
		});
	},
});

const trial = defineCommand({
	meta: {
		name: "trial",
		description:
			"Run the same tasks on a site many times, at different levels of help, and count how often agents finish, on your Front account",
	},
	subCommands: { run: trialRun, view: trialView, list: trialList, cancel: trialCancel },
});

export { trial, trialCancel, trialList, trialRun, trialView };
