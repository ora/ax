import { defineCommand, renderUsage, runMain, showUsage } from "citty";
import pc from "picocolors";
import pkg from "../package.json";
import { platformBase } from "./api/platform-origins";
import { resolveBase } from "./api/skills";
import { scopeList, TUNNEL_FEATURE } from "./auth/platform-features";
import { auditCommand } from "./commands/audit";
import { deepJourneyCommand } from "./commands/deep-journey";
import { generateFilesCommand } from "./commands/generate-files";
import { journey, journeyUsage, noStreamFlag } from "./commands/journey-cli";
import { learnCommand } from "./commands/learn";
import { loginCommand } from "./commands/login";
import { logoutCommand } from "./commands/logout";
import { skillCommand } from "./commands/skill";
import { webmcpAuditCommand } from "./commands/webmcp-audit";
import { whoamiCommand } from "./commands/whoami";
import { loadLocalEnv } from "./env";
import { axCall, type NextStep, placeholder, printNext } from "./report/next-line";

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
			description: `Open ora's own tunnel to a local target (value: ora); needs ax login, or ORA_API_KEY with the ${scopeList(TUNNEL_FEATURE)} scopes. Also read from ORA_TUNNEL. The result is stored as ephemeral`,
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

// The older name for `ax journey` with no goal of its own. It keeps working, flags and exit codes
// unchanged, with a note on stderr naming the new call, until a future major release removes it.
const deepJourney = defineCommand({
	meta: {
		name: "deep-journey",
		description:
			"Deprecated: now ax journey --domain <url>. Runs a real AI agent at a site on a curated task, or with a partner API key a free-text one, via ora's public API (exit codes: 0 ok, 1 run failed, 2 usage, 3 API error)",
		hidden: true,
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
				"Agent id (see GET /api/journey/agents); defaults to cas-haiku, Claude Code on the Haiku model ora's roster lists",
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
				"ora-issued partner API key: unlocks --task and the 1000/24h keyed allowance; also read from ORA_PARTNER_API_KEY, then ORA_SCAN_API_KEY",
		},
		"no-stream": {
			type: "boolean",
			description: "Hide the live trajectory view and print only the final result",
			default: false,
		},
	},
	async run({ args }) {
		const task = args.task as string | undefined;
		const intent = args.intent as string | undefined;
		const agent = args.agent as string | undefined;
		const now = axCall([
			"journey",
			...(task ? [task] : []),
			"--domain",
			args.url as string,
			...(intent && !task ? ["--intent", intent] : []),
			...(agent ? ["--agent", agent] : []),
		]);
		console.error(
			pc.dim(
				`ax deep-journey is now ${now}. This name keeps working and will be removed in a future major release.`,
			),
		);
		// Same exitCode-over-exit rule as audit: let stdout drain before exiting.
		process.exitCode = await deepJourneyCommand({
			url: args.url as string,
			intent: args.intent as string | undefined,
			task: args.task as string | undefined,
			apiKey: args["api-key"] as string | undefined,
			agent: args.agent as string | undefined,
			json: Boolean(args.json),
			noStream: noStreamFlag(args),
			via: "deep-journey",
		});
	},
});

const generateFiles = defineCommand({
	meta: {
		name: "generate-files",
		description:
			"Draft a domain's agent files (ard.json, ai-catalog.json, poppy.json, llms.txt, a robots.txt edit, api-catalog, MCP server cards) into <out> (exit codes: 0 ok, 2 usage or files already exist, 3 API error)",
	},
	args: {
		domain: {
			type: "positional",
			description: "Domain the files speak for (e.g. example.com)",
			required: true,
		},
		out: {
			type: "string",
			description:
				"Your site's web root; files land under it (.well-known/, robots.txt, llms.txt) (default: current directory)",
		},
		force: {
			type: "boolean",
			description: "Overwrite files that already exist",
			default: false,
		},
		json: {
			type: "boolean",
			description: "Print ora's payload as JSON and write nothing",
			default: false,
		},
	},
	async run({ args }) {
		// Same exitCode-over-exit rule as audit: let stdout drain before exiting.
		process.exitCode = await generateFilesCommand({
			domain: args.domain as string,
			out: args.out as string | undefined,
			force: Boolean(args.force),
			json: Boolean(args.json),
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
			description:
				"ora partner or scan API key that lifts the daily ingest limit; also read from ORA_PARTNER_API_KEY, then ORA_SCAN_API_KEY",
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

const login = defineCommand({
	meta: {
		name: "login",
		description:
			"Sign in to ora's platform through your browser, for a journey with a goal and audit --tunnel ora (exit codes: 0 signed in, 2 address refused, 3 sign-in failed)",
	},
	args: {
		"no-browser": {
			type: "boolean",
			description: "Print the link and the code without opening a browser",
			default: false,
		},
		json: {
			type: "boolean",
			description: "Print the result as JSON (the link and the code still go to stderr)",
			default: false,
		},
	},
	async run({ args }) {
		process.exitCode = await loginCommand({
			json: Boolean(args.json),
			// citty reads --no-browser as browser: false (see noStreamFlag).
			noBrowser: args.browser === false || args["no-browser"] === true,
		});
	},
});

const logout = defineCommand({
	meta: {
		name: "logout",
		description: "End the sign-in ax login stored, on ora and on this machine",
	},
	args: {
		json: { type: "boolean", description: "Print the result as JSON", default: false },
	},
	async run({ args }) {
		process.exitCode = await logoutCommand({ json: Boolean(args.json) });
	},
});

const whoami = defineCommand({
	meta: {
		name: "whoami",
		description:
			"Who ax calls ora's platform as: your browser sign-in, or ORA_API_KEY (exit codes: 0, 2 not signed in, 3 refused)",
	},
	args: {
		json: { type: "boolean", description: "Print the identity as JSON", default: false },
	},
	async run({ args }) {
		process.exitCode = await whoamiCommand({ json: Boolean(args.json) });
	},
});

const learn = defineCommand({
	meta: {
		name: "learn",
		description:
			"Print the ax workflow from ora's skill: score a site, read the report, run a journey, read its result",
	},
	args: {},
	async run() {
		process.exitCode = await learnCommand();
	},
});

// Read at help time, after loadLocalEnv(), so help names the hosts this run
// would actually call.
const oraSite = () => `ora.ai at ${resolveBase()} (set by ORA_API_URL)`;
const oraPlatform = () =>
	`ora's platform API at ${platformBase()} (set by ORA_PLATFORM_URL), signed in with ax login or with ORA_API_KEY`;
const oraSignIn = () =>
	`ora's sign-in server for ${platformBase()} (account.<domain>), then ${oraPlatform()}`;

/** The chain every help screen ends with; `ax learn` prints the skill's own copy. */
function workflowLines(): string[] {
	const d = pc.dim;
	return [
		`  ${d("Workflow:")}`,
		`    1. ax audit <domain>          ${d("score the site and list what to fix")}`,
		`    2. read the report            ${d("start with its Top fixes, ranked by ora")}`,
		`    3. ax journey --domain <domain> ${d("send a real agent at the site on a task")}`,
		`    4. read its result            ${d("whether the agent finished, and where it got stuck")}`,
		`    ${d("Every result and error ends with a Next: line, the call to make next.")}`,
		`    ${d("ax learn prints these steps from ora's skill.")}`,
		"",
	];
}

interface CommandHelp {
	talksTo: () => string;
	/** Replaces citty's generated usage, for a command whose forms it cannot show. */
	usage?: () => string;
	/** The call to suggest when citty rejects the arguments (a missing positional). */
	usageNext: NextStep;
}

const COMMAND_HELP = new Map<unknown, CommandHelp>([
	[
		audit,
		{
			talksTo: () => `${oraSite()}; with --tunnel ora, also ${oraPlatform()}`,
			usageNext: { call: axCall(["audit", placeholder("domain")]) },
		},
	],
	[
		webmcpAudit,
		{
			talksTo: () => `a Chrome on this machine for the capture, then ${oraSite()} to score it`,
			usageNext: { call: axCall(["webmcp-audit", "http://localhost:3000"]) },
		},
	],
	[
		deepJourney,
		{
			talksTo: oraSite,
			usageNext: { call: axCall(["journey", "--domain", placeholder("domain")]) },
		},
	],
	[
		journey,
		{
			talksTo: () => `${oraSite()} with no goal of your own (free); ${oraPlatform()} with a goal`,
			usage: journeyUsage,
			usageNext: {
				call: axCall(["journey", "--domain", placeholder("domain")]),
				why: "ora picks the task",
			},
		},
	],
	[
		generateFiles,
		{
			talksTo: oraSite,
			usageNext: { call: axCall(["generate-files", placeholder("domain")]) },
		},
	],
	[
		skill,
		{ talksTo: () => `ora's skill registry on ${oraSite()}`, usageNext: { call: "ax skill" } },
	],
	[
		learn,
		{ talksTo: () => `ora's skill registry on ${oraSite()}`, usageNext: { call: "ax learn" } },
	],
	[login, { talksTo: oraSignIn, usageNext: { call: "ax login" } }],
	[
		logout,
		{
			talksTo: () => `ora's sign-in server for ${platformBase()}`,
			usageNext: { call: "ax logout" },
		},
	],
	[whoami, { talksTo: oraPlatform, usageNext: { call: "ax whoami" } }],
]);

function commandFooter(help: CommandHelp): string {
	return [`  ${pc.dim("Talks to:")} ${help.talksTo()}`, "", ...workflowLines()].join("\n");
}

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
		`    journey ${d("--domain <d>")} ${d("Send a real agent at a site on one of ora's curated tasks, drawn live; free, no key")}`,
		`    journey ${d("<goal>")}      ${d("The same on a goal of your own (needs ax login, or a platform key)")}`,
		`    skill ${d("[name]")}        ${d("List, print, or install ora's agent skills")}`,
		`    generate-files ${d("<domain>")} ${d("Draft a domain's agent files: ARD catalog, poppy.json, llms.txt, robots.txt edit, …")}`,
		`    learn                ${d("Print the ax workflow from ora's skill")}`,
		`    login                ${d("Sign in to ora's platform through your browser (for a goal, and --tunnel ora)")}`,
		`    whoami               ${d("Who ax calls ora's platform as")}`,
		`    logout               ${d("End that sign-in")}`,
		"",
		`  ${d("Talks to:")}`,
		`    ${oraSite()}`,
		`      ${d("audit, webmcp-audit, journey with no goal, generate-files, skill, learn")}`,
		`    ${oraPlatform()}`,
		`      ${d("journey with a goal, audit --tunnel ora, login, whoami, logout")}`,
		"",
		`  ${d("Examples:")}`,
		`    ${g} ${NAME} audit https://docs.example.com`,
		`    ${g} ${NAME} audit https://docs.example.com --min-score 70   ${d("# CI gate")}`,
		`    ${g} ${NAME} audit https://docs.example.com --json`,
		`    ${g} ${NAME} audit localhost:3000 --tunnel ora   ${d("# audit a local dev server")}`,
		`    ${g} ${NAME} webmcp-audit http://localhost:3000`,
		`    ${g} ${NAME} journey --domain stripe.com --intent pricing   ${d("# free, no key")}`,
		`    ${g} ${NAME} journey "Find the API docs and how to authenticate" --domain stripe.com`,
		`    ${g} ${NAME} generate-files example.com --out public`,
		`    ${g} ${NAME} learn`,
		"",
		`  ${d("audit options:")}`,
		`    --min-score <n>  ${d("Exit 1 when the score is below n (0-100); the CI gate")}`,
		`    --max-age <s>    ${d("Accept a cached result up to s seconds old (default 6h)")}`,
		`    --force          ${d("Bypass the cache and rescan (6/day budget)")}`,
		`    --tunnel ora     ${d(`Expose a local target through ora's own tunnel (needs ax login, or ORA_API_KEY: ${scopeList(TUNNEL_FEATURE)})`)}`,
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
		`    --api-key <k>    ${d("ora partner or scan API key that lifts the daily ingest limit; also read from ORA_PARTNER_API_KEY")}`,
		`    --json           ${d("Print the raw ora audit payload as JSON")}`,
		`    --show-passing   ${d("List each passing check (hidden by default)")}`,
		`    ${d("starts a headless Chrome you already have installed; never downloads one")}`,
		`    ${d("scored by ora, stored nowhere: the result is never published or ranked")}`,
		`    ${d("exit codes: 0 ok · 1 below --min-score · 2 usage · 3 API error")}`,
		"",
		`  ${d("generate-files options:")}`,
		`    --out <dir>      ${d("Your site's web root: writes .well-known/*, robots.txt, llms.txt there (default: .)")}`,
		`    --force          ${d("Overwrite files that already exist (otherwise nothing is written)")}`,
		`    --json           ${d("Print ora's payload as JSON and write nothing")}`,
		`    ${d("drafts from ora's last scan of the domain - review each file before you publish it")}`,
		`    ${d("exit codes: 0 written · 2 usage or files already exist · 3 API error")}`,
		"",
		`  ${d("skill options:")}`,
		`    --install        ${d("Write <dir>/<name>/SKILL.md instead of printing it")}`,
		`    --dir <path>     ${d("Install directory (default .claude/skills)")}`,
		`    --json           ${d("Print the raw registry index as JSON")}`,
		"",
		`  ${d("journey options, free (no goal of your own):")}`,
		`    --domain <d>     ${d("Site the agent works on (e.g. stripe.com)")}`,
		`    --intent <id>    ${d("Curated task id, e.g. pricing, signup, api-docs (server default when omitted)")}`,
		`    --agent <id>     ${d("Agent to run (default: cas-haiku, Claude Code on the Haiku model ora's roster lists)")}`,
		`    --api-key <k>    ${d("ora partner API key: a goal of your own + 1000 runs/24h; also read from ORA_PARTNER_API_KEY, then ORA_SCAN_API_KEY")}`,
		`    --no-stream      ${d("Hide the live trajectory view and print only the final result")}`,
		`    --json           ${d("Print the terminal run detail as JSON")}`,
		`    ${d("public caps: 100 runs/24h per target and task, 20 runs/24h per IP")}`,
		`    ${d("exit codes: 0 run succeeded (any verdict) · 1 run failed · 2 usage · 3 API unreachable/rate-limited")}`,
		`    ${d("ax deep-journey <url> still runs this, and will be removed in a future major release")}`,
		"",
		`  ${d("journey options, on ora's platform (a goal of your own):")}`,
		`    --domain <d>     ${d("Site the agent works on (e.g. stripe.com)")}`,
		`    --harness <h>    ${d("Agent harness: claude-code (default), codex, openclaw, hermess, claude-agent, eve, …")}`,
		`    --model <m>      ${d("Model override (harness default when omitted)")}`,
		`    --json           ${d("Output as JSON")}`,
		`    ${d("requires ax login (a browser sign-in), or ORA_API_KEY (see .env.example)")}`,
		"",
		...workflowLines(),
	].join("\n");
}

const root = defineCommand({
	meta: {
		name: NAME,
		version: pkg.version,
		description: "Score any site's agent readiness — and watch real AI agents navigate it",
	},
	subCommands: {
		audit,
		"webmcp-audit": webmcpAudit,
		"deep-journey": deepJourney,
		journey,
		skill,
		"generate-files": generateFiles,
		learn,
		login,
		logout,
		whoami,
	},
	setup() {
		// Bare invocation gets the curated screen. Top-level --help is handled in
		// runMain below: citty answers --help before any setup() runs.
		if (!process.argv[2]) {
			console.log(helpScreen());
			process.exit(0);
		}
	},
});

// Before anything reads process.env — every command resolves its configuration
// at call time, so the file has to be in place first.
loadLocalEnv();

const HELP_FLAGS = new Set(["--help", "-h"]);

// citty intercepts --help itself and prints its generated usage, so the root
// command's help is routed to the curated screen here. Subcommand --help
// (`ax audit --help`) keeps citty's per-command usage, followed by what the
// command talks to and the workflow. citty also lands here when it rejects
// the arguments (a missing positional), before printing its error and exiting
// 1; that path gets a Next line on stderr instead of the footer.
runMain(root, {
	showUsage: async (cmd, parent) => {
		const asked = process.argv.slice(2).some((arg) => HELP_FLAGS.has(arg));
		const help = COMMAND_HELP.get(cmd);
		if (cmd === root) console.log(helpScreen());
		else if (asked && help) {
			const usage = help.usage ? help.usage() : (await renderUsage(cmd, parent)).trimEnd();
			console.log(`${usage}\n\n${commandFooter(help)}`);
		} else if (help?.usage) console.log(`${help.usage()}\n`);
		else await showUsage(cmd, parent);
		if (!asked) {
			printNext(help?.usageNext ?? { call: axCall(["audit", placeholder("domain")]) }, {
				stderr: true,
			});
		}
	},
});
