import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import pkg from "../package.json";
import { auditCommand } from "./commands/audit";
import { deepJourneyCommand } from "./commands/deep-journey";
import { journeyCommand } from "./commands/journey";
import { skillCommand } from "./commands/skill";
import { webmcpAuditCommand } from "./commands/webmcp-audit";
import { loadLocalEnv } from "./env";

const NAME = "ax";

const audit = defineCommand({
	meta: {
		name: "audit",
		description:
			"Score a site's agent readiness (exit codes: 0 ok, 1 below --min-score, 2 usage, 3 API error)",
	},
	args: {
		url: {
			type: "positional",
			description: "URL or domain to audit (e.g. https://docs.example.com)",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Print the raw ora audit payload as JSON",
			default: false,
		},
		"min-score": {
			type: "string",
			description: "Exit 1 when the score is below this threshold (0-100); the CI gate",
		},
		"max-age": {
			type: "string",
			description: "Accept a cached result up to this many seconds old (server default 6h)",
		},
		force: {
			type: "boolean",
			description: "Bypass the cache and rescan (spends the stricter 6/day force budget)",
			default: false,
		},
		tunnel: {
			type: "string",
			description:
				"Open ora's own tunnel to a local target (value: ora); needs ORA_API_KEY with the tunnels:write + tunnels:connect scopes. Also read from ORA_TUNNEL. The result is stored as ephemeral",
		},
		"tunnel-cmd": {
			type: "string",
			description:
				"Bring your own tunnel: a command that exposes a local target and prints its public https URL (e.g. 'ngrok http 3000 --log stdout'); also read from ORA_TUNNEL_CMD. The result is stored as ephemeral",
		},
		"api-key": {
			type: "string",
			description:
				"ora-issued scan API key that lifts the scan rate limits; also read from ORA_SCAN_API_KEY",
		},
		"show-passing": {
			type: "boolean",
			description: "List each passing check individually",
			default: false,
		},
		"show-skipped": {
			type: "boolean",
			description: "List not-applicable / pending checks too",
			default: false,
		},
	},
	async run({ args }) {
		// exitCode, not process.exit(): a large --json payload can exceed the
		// 64KB pipe buffer, and process.exit() drops whatever stdout has not
		// flushed yet. Setting exitCode lets Node drain stdout, then exit.
		process.exitCode = await auditCommand({
			url: args.url as string,
			json: Boolean(args.json),
			showSkipped: Boolean(args["show-skipped"]),
			showPassing: Boolean(args["show-passing"]),
			minScore: args["min-score"] as string | undefined,
			maxAge: args["max-age"] as string | undefined,
			force: Boolean(args.force),
			tunnelCmd: args["tunnel-cmd"] as string | undefined,
			tunnel: args.tunnel as string | undefined,
			apiKey: args["api-key"] as string | undefined,
		});
	},
});

const journey = defineCommand({
	meta: {
		name: "journey",
		description: "Send a real AI agent at a site and watch it navigate live",
	},
	args: {
		intent: {
			type: "positional",
			description: 'Goal for the agent (e.g. "Find the API docs and how to auth")',
			required: true,
		},
		domain: { type: "string", description: "Site the agent targets (e.g. stripe.com)" },
		harness: {
			type: "string",
			description: "Agent harness: claude-code, codex, openclaw, hermess, claude-agent, eve, …",
			default: "claude-code",
		},
		model: { type: "string", description: "Model override (harness default when omitted)" },
		json: { type: "boolean", description: "Output as JSON", default: false },
	},
	async run({ args }) {
		// Same exitCode-over-exit rule as audit: let stdout drain before exiting.
		process.exitCode = await journeyCommand({
			intent: args.intent as string,
			domain: args.domain as string | undefined,
			harness: args.harness as string,
			model: args.model as string | undefined,
			json: Boolean(args.json),
		});
	},
});

const deepJourney = defineCommand({
	meta: {
		name: "deep-journey",
		description:
			"Run a real AI agent at a site on a curated task — or, with a partner API key, a free-text one — via ora's public API (exit codes: 0 ok, 1 run failed, 2 usage, 3 API error)",
	},
	args: {
		url: {
			type: "positional",
			description: "URL or domain the agent targets (e.g. stripe.com)",
			required: true,
		},
		intent: {
			type: "string",
			description: "Curated intent id (see GET /api/journey/intents; server default when omitted)",
		},
		agent: {
			type: "string",
			description:
				"Agent id (see GET /api/journey/agents); defaults to cas-haiku (Claude Code · Haiku 4.5)",
		},
		json: {
			type: "boolean",
			description: "Print the terminal run detail as JSON",
			default: false,
		},
		task: {
			type: "string",
			description:
				"Free-text task for the agent (needs a partner API key; mutually exclusive with --intent)",
		},
		"api-key": {
			type: "string",
			description:
				"ora-issued partner API key: unlocks --task and the 1000/24h keyed allowance; also read from ORA_PARTNER_API_KEY",
		},
		"no-stream": {
			type: "boolean",
			description: "Skip the live trajectory stream and poll for the result instead",
			default: false,
		},
	},
	async run({ args }) {
		// Same exitCode-over-exit rule as audit: let stdout drain before exiting.
		process.exitCode = await deepJourneyCommand({
			url: args.url as string,
			intent: args.intent as string | undefined,
			task: args.task as string | undefined,
			apiKey: args["api-key"] as string | undefined,
			agent: args.agent as string | undefined,
			json: Boolean(args.json),
			noStream: Boolean(args["no-stream"]),
		});
	},
});

const skill = defineCommand({
	meta: {
		name: "skill",
		description:
			"List, print, or install ora's agent skills (digest-verified from the registry, never bundled)",
	},
	args: {
		name: {
			type: "positional",
			description: "Skill name (omit to list the registry)",
			required: false,
		},
		install: {
			type: "boolean",
			description: "Write <dir>/<name>/SKILL.md instead of printing",
			default: false,
		},
		dir: {
			type: "string",
			description: "Install directory (default .claude/skills)",
		},
		json: { type: "boolean", description: "Print the raw registry index as JSON", default: false },
	},
	async run({ args }) {
		process.exitCode = await skillCommand({
			name: args.name as string | undefined,
			install: Boolean(args.install),
			dir: args.dir as string | undefined,
			json: Boolean(args.json),
		});
	},
});

const webmcpAudit = defineCommand({
	meta: {
		name: "webmcp-audit",
		description:
			"Audit a page's WebMCP tools in a real browser - localhost included, so you can check before you publish (exit codes: 0 ok, 1 below --min-score, 2 usage, 3 API error)",
	},
	args: {
		url: {
			type: "positional",
			description: "Page to audit, scheme included (e.g. http://localhost:3000)",
			required: true,
		},
		"chrome-endpoint": {
			type: "string",
			description:
				"Drive a Chrome you started instead of launching one: ws:// URL, http origin, or host:port",
		},
		"min-score": {
			type: "string",
			description: "Exit 1 when the score is below this threshold (0-100); the CI gate",
		},
		"api-key": {
			type: "string",
			description: "ora API key that lifts the ingest rate limits; also read from ORA_API_KEY",
		},
		json: {
			type: "boolean",
			description: "Print the raw ora audit payload as JSON",
			default: false,
		},
		"show-passing": {
			type: "boolean",
			description: "List each passing check individually",
			default: false,
		},
	},
	async run({ args }) {
		// Same exitCode-over-exit rule as audit: let stdout drain before exiting.
		process.exitCode = await webmcpAuditCommand({
			url: args.url as string,
			json: Boolean(args.json),
			showPassing: Boolean(args["show-passing"]),
			minScore: args["min-score"] as string | undefined,
			chromeEndpoint: args["chrome-endpoint"] as string | undefined,
			apiKey: args["api-key"] as string | undefined,
		});
	},
});

function helpScreen(): string {
	const g = pc.green("$");
	const d = pc.dim;
	return [
		"",
		`  ${pc.bold(NAME)} ${d(`v${pkg.version}`)}`,
		`  ${d("Score any site's agent readiness — and watch real AI agents navigate it")}`,
		"",
		`  ${d("Commands:")}`,
		`    audit ${d("<url>")}         ${d("Score a site's agent readiness")}`,
		`    webmcp-audit ${d("<url>")}  ${d("Audit a WebMCP surface in a real browser, localhost included")}`,
		`    deep-journey ${d("<url>")}  ${d("Run a real agent at a site on a curated or free-text task")}`,
		`    journey ${d("<intent>")}    ${d("Send a real agent at a site and watch it live (workspace)")}`,
		`    skill ${d("[name]")}        ${d("List, print, or install ora's agent skills")}`,
		"",
		`  ${d("Examples:")}`,
		`    ${g} ${NAME} audit https://docs.example.com`,
		`    ${g} ${NAME} audit https://docs.example.com --min-score 70   ${d("# CI gate")}`,
		`    ${g} ${NAME} audit https://docs.example.com --json`,
		`    ${g} ${NAME} audit localhost:3000 --tunnel ora   ${d("# audit a local dev server")}`,
		`    ${g} ${NAME} webmcp-audit http://localhost:3000`,
		`    ${g} ${NAME} deep-journey stripe.com --intent pricing`,
		`    ${g} ${NAME} journey "Find the API docs and how to authenticate" --domain stripe.com`,
		"",
		`  ${d("audit options:")}`,
		`    --min-score <n>  ${d("Exit 1 when the score is below n (0-100); the CI gate")}`,
		`    --max-age <s>    ${d("Accept a cached result up to s seconds old (default 6h)")}`,
		`    --force          ${d("Bypass the cache and rescan (6/day budget)")}`,
		`    --tunnel ora     ${d("Expose a local target through ora's own tunnel (needs ORA_API_KEY: tunnels:write + tunnels:connect)")}`,
		`    --tunnel-cmd <c> ${d("...or through your own tunnel command (e.g. 'ngrok http 3000 --log stdout')")}`,
		`    --api-key <k>    ${d("ora-issued scan API key that lifts the rate limits; also read from ORA_SCAN_API_KEY")}`,
		`    --json           ${d("Print the raw ora audit payload as JSON")}`,
		`    --show-passing   ${d("List each passing check (hidden by default)")}`,
		`    --show-skipped   ${d("List skipped checks (hidden by default)")}`,
		"",
		`  ${d("audit exit codes:")}`,
		`    ${d("0 success · 1 below --min-score · 2 usage error · 3 API unreachable/rate-limited")}`,
		"",
		`  ${d("webmcp-audit options:")}`,
		`    --chrome-endpoint ${d("<e>  Drive a Chrome you started: ws:// URL, http origin, or host:port")}`,
		`    --min-score <n>  ${d("Exit 1 when the score is below n (0-100); the CI gate")}`,
		`    --api-key <k>    ${d("ora API key that lifts the ingest rate limits; also read from ORA_API_KEY")}`,
		`    --json           ${d("Print the raw ora audit payload as JSON")}`,
		`    --show-passing   ${d("List each passing check (hidden by default)")}`,
		`    ${d("starts a headless Chrome you already have installed; never downloads one")}`,
		`    ${d("scored by ora, stored nowhere: the result is never published or ranked")}`,
		"",
		`  ${d("deep-journey options:")}`,
		`    --intent <id>    ${d("Curated task id, e.g. pricing, signup, api-docs (server default when omitted)")}`,
		`    --task <text>    ${d("Free-text task (needs a partner API key; replaces --intent)")}`,
		`    --api-key <k>    ${d("ora partner API key: unlocks --task + 1000 runs/24h; also read from ORA_PARTNER_API_KEY")}`,
		`    --agent <id>     ${d("Agent to run (default: cas-haiku — Claude Code · Haiku 4.5)")}`,
		`    --no-stream      ${d("Poll for the result instead of streaming the trajectory")}`,
		`    --json           ${d("Print the terminal run detail as JSON")}`,
		`    ${d("no key needed · public caps: 100 runs/24h per target, 200 runs/24h per IP")}`,
		"",
		`  ${d("journey options:")}`,
		`    --domain <d>     ${d("Site the agent targets (e.g. stripe.com)")}`,
		`    --harness <h>    ${d("Agent harness: claude-code (default), codex, openclaw, hermess, claude-agent, eve, …")}`,
		`    --model <m>      ${d("Model override (harness default when omitted)")}`,
		`    --json           ${d("Output as JSON")}`,
		`    ${d("requires ORA_API_KEY (see .env.example)")}`,
		"",
	].join("\n");
}

const root = defineCommand({
	meta: {
		name: NAME,
		version: pkg.version,
		description: "Score any site's agent readiness — and watch real AI agents navigate it",
	},
	subCommands: { audit, "webmcp-audit": webmcpAudit, "deep-journey": deepJourney, journey, skill },
	setup() {
		// Bare invocation and top-level --help get the curated screen; subcommand
		// --help stays with citty's generated usage.
		const first = process.argv[2];
		if (!first || first === "--help" || first === "-h") {
			console.log(helpScreen());
			process.exit(0);
		}
	},
});

// Before anything reads process.env — every command resolves its configuration
// at call time, so the file has to be in place first.
loadLocalEnv();

runMain(root);
