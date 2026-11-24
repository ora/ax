import { parseArgs } from "node:util";
import { defineCommand } from "citty";
import { wholeNumber } from "../journey-set/args";
import { reportError } from "../report/json-error";
import { deepJourneyCommand } from "./deep-journey";
import { EXIT } from "./exit-codes";
import { journeyCommand, viewRun } from "./journey";
import {
	DEFAULT_WAIT_MINUTES,
	journeySetCancel,
	journeySetList,
	journeySetRun,
	journeySetView,
} from "./journey-set";

const text = { type: "string" } as const;
const flag = { type: "boolean" } as const;
const output = { json: flag };
const agent = { domain: text, harness: text, model: text };
const watching = { wait: text, watch: flag };

async function dispatch(args: string[], help: string, invoke: () => Promise<number>) {
	try {
		process.exitCode = await invoke();
	} catch (error) {
		if (
			!(
				error instanceof TypeError &&
				"code" in error &&
				String(error.code).startsWith("ERR_PARSE_ARGS_")
			) &&
			!(error instanceof UsageError)
		)
			throw error;
		reportError(
			{ code: "INVALID_ARGUMENT", message: error.message, next: { call: help } },
			{ json: args.includes("--json") },
		);
		process.exitCode = EXIT.USAGE;
	}
}

class UsageError extends Error {}

/** citty exposes --no-stream as stream: false for the deep-journey alias. */
export function noStreamFlag(args: Record<string, unknown>): boolean {
	return args.stream === false || args["no-stream"] === true;
}

export const journey = defineCommand({
	meta: {
		name: "journey",
		description: "Run a curated task or a partner task on ora's public journey API.",
	},
	async run({ rawArgs }) {
		await dispatch(rawArgs, "ax journey --help", async () => {
			const { values, positionals } = parseArgs({
				args: rawArgs,
				allowPositionals: true,
				options: {
					...output,
					domain: text,
					intent: text,
					agent: text,
					"api-key": text,
					"no-stream": flag,
				},
			});
			if (!values.domain?.trim())
				throw new UsageError(
					"--domain names the site the agent works on. Use ax run for a Studio goal.",
				);
			if (positionals.length > 1)
				throw new UsageError(
					"journey takes one public task. To run a Studio set, use ax run set create.",
				);
			return deepJourneyCommand({
				url: values.domain,
				task: positionals[0],
				intent: values.intent,
				agent: values.agent,
				apiKey: values["api-key"],
				noStream: Boolean(values["no-stream"]),
				json: Boolean(values.json),
				via: "journey",
			});
		});
	},
});

async function studioRun(rawArgs: string[]): Promise<number> {
	const [command, operation] = rawArgs;
	if (command === "set") {
		const args = rawArgs.slice(2);
		switch (operation) {
			case "create": {
				const { values, positionals } = parseArgs({
					args,
					allowPositionals: true,
					options: {
						...output,
						...agent,
						...watching,
						agents: text,
						levels: flag,
						brand: text,
						docs: text,
						exact: text,
						repeat: text,
						yes: flag,
					},
				});
				return journeySetRun({
					goals: positionals,
					flags: {
						domain: values.domain,
						harness: values.harness,
						model: values.model,
						agents: values.agents,
						levels: Boolean(values.levels),
						brand: values.brand,
						docs: values.docs,
						exact: values.exact,
						repeat: values.repeat,
					},
					yes: Boolean(values.yes),
					wait: values.wait,
					watch: Boolean(values.watch),
					json: Boolean(values.json),
				});
			}
			case "list": {
				const { values } = parseArgs({ args, options: output });
				return journeySetList({ json: Boolean(values.json) });
			}
			case "view": {
				const { values, positionals } = parseArgs({
					args,
					allowPositionals: true,
					options: { ...output, ...watching },
				});
				if (positionals.length !== 1) throw new UsageError("ax run set view needs one set ID.");
				return journeySetView({
					id: positionals[0],
					wait: values.wait,
					watch: Boolean(values.watch),
					json: Boolean(values.json),
				});
			}
			case "cancel": {
				const { values, positionals } = parseArgs({
					args,
					allowPositionals: true,
					options: output,
				});
				if (positionals.length !== 1) throw new UsageError("ax run set cancel needs one set ID.");
				return journeySetCancel({ id: positionals[0], json: Boolean(values.json) });
			}
			default:
				throw new UsageError("Use ax run set create, list, view or cancel.");
		}
	}
	if (command === "view") {
		const { values, positionals } = parseArgs({
			args: rawArgs.slice(1),
			allowPositionals: true,
			options: { ...output, ...watching },
		});
		if (positionals.length !== 1) throw new UsageError("ax run view needs one run ID.");
		const wait = values.wait === undefined ? DEFAULT_WAIT_MINUTES : wholeNumber(values.wait);
		if (wait === undefined) throw new UsageError("--wait takes a positive number of minutes.");
		return viewRun(
			positionals[0],
			Boolean(values.json),
			values.watch || values.wait !== undefined ? wait : undefined,
		);
	}
	const { values, positionals } = parseArgs({
		args: rawArgs,
		allowPositionals: true,
		options: { ...output, ...agent },
	});
	if (positionals.length !== 1 || !positionals[0].trim())
		throw new UsageError("ax run takes one goal. Use ax run set create for a set.");
	return journeyCommand({
		intent: positionals[0],
		domain: values.domain,
		harness: values.harness ?? "claude-code",
		model: values.model,
		json: Boolean(values.json),
	});
}

export const run = defineCommand({
	meta: { name: "run", description: "Run a signed-in Studio evaluation." },
	async run({ rawArgs }) {
		await dispatch(rawArgs, "ax run --help", () => studioRun(rawArgs));
	},
});

export const journeyUsage = () =>
	[
		"ax journey --domain <site> [--intent <id>] [--agent <id>] [--no-stream] [--json]",
		'ax journey "<partner task>" --domain <site> [--api-key <key>] [--agent <id>] [--no-stream] [--json]',
		"",
		"Curated tasks are free. A custom task needs an ora partner key (--api-key or ORA_PARTNER_API_KEY).",
		"The older ax deep-journey <url> spelling and its --task option are also supported.",
	].join("\n");

export const runUsage = () =>
	[
		'ax run "<goal>" [--domain <site>] [--harness <h>] [--model <m>] [--json]',
		"ax run view <run-id> [--watch] [--wait <minutes>] [--json]",
		'ax run set create "<goal>" ["<goal>" ...] --domain <site> [--agents <harness[/model]>,...]',
		"           [--levels] [--brand <name>] [--docs <url>] [--exact <url>] [--repeat <n>]",
		"           [--yes] [--watch] [--wait <minutes>] [--json]",
		"ax run set list [--json]",
		"ax run set view <set-id> [--watch] [--wait <minutes>] [--json]",
		"ax run set cancel <set-id> [--json]",
		"",
		"Sign in with ax login or set ORA_API_KEY. A standalone goal uses claude-code by default.",
		"Harnesses: claude-consumer, chatgpt-consumer, claude-code, codex.",
		"Set creation previews the run count and asks before launching. Use --yes to confirm.",
	].join("\n");
