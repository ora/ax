import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deepJourneyCommand } from "./deep-journey";
import { journeyCommand } from "./journey";
import { journey, journeyRoute, journeyUsage } from "./journey-cli";

// Both command functions are mocked: these tests pin which one a typed `ax journey` reaches, how
// its arguments map onto that input, and that each exit code reaches process.exitCode. Arguments
// go through citty's own parser (runCommand), so positionals and flag values are the real ones.
vi.mock("./journey", () => ({ journeyCommand: vi.fn() }));
vi.mock("./deep-journey", () => ({ deepJourneyCommand: vi.fn() }));

const oneMock = vi.mocked(journeyCommand);
const freeMock = vi.mocked(deepJourneyCommand);

const savedExitCode = process.exitCode;
const GOAL = "Find how to create an issue from the API";

beforeEach(() => {
	oneMock.mockResolvedValue(0);
	freeMock.mockResolvedValue(0);
	// A partner key in the shell would send a lone goal to the free path.
	vi.stubEnv("ORA_PARTNER_API_KEY", "");
	vi.stubEnv("ORA_SCAN_API_KEY", "");
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	vi.restoreAllMocks();
	process.exitCode = savedExitCode;
});

const argv = (...rawArgs: string[]) => runCommand(journey, { rawArgs });
const oneInput = () => oneMock.mock.calls[0][0];
const freeInput = () => freeMock.mock.calls[0][0];
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the color codes picocolors may add
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const errored = () => vi.mocked(console.error).mock.calls.map((call) => plain(String(call[0])));

function expectOnly(mock: { mock: { calls: unknown[] } }) {
	for (const other of [oneMock, freeMock]) {
		expect(other.mock.calls).toHaveLength(other === mock ? 1 : 0);
	}
}

describe("a goal of your own", () => {
	it("runs one journey on ora's platform, on claude-code by default", async () => {
		await argv(GOAL, "--domain", "stripe.com");
		expectOnly(oneMock);
		expect(oneInput()).toEqual({
			intent: GOAL,
			domain: "stripe.com",
			harness: "claude-code",
			model: undefined,
			json: false,
		});
	});

	it("takes --harness, --model and --json as before", async () => {
		await argv(GOAL, "--harness", "codex", "--model", "gpt-5.5", "--json");
		expect(oneInput()).toMatchObject({ harness: "codex", model: "gpt-5.5", json: true });
	});

	it.each([0, 1, 2])("sets process.exitCode to the returned %i", async (code) => {
		oneMock.mockResolvedValue(code);
		process.exitCode = undefined;
		await argv(GOAL);
		expect(process.exitCode).toBe(code);
	});

	it("refuses --harness or --model with no goal, exit 2, with the free call", async () => {
		process.exitCode = undefined;
		await argv("--domain", "stripe.com", "--harness", "codex");
		expect(process.exitCode).toBe(2);
		expect(errored()).toEqual([
			"--harness picks the agent for a goal of your own; with no goal, ax runs one of ora's curated tasks free",
			"Next: ax journey --domain stripe.com  # ora picks the task",
		]);
		expect(oneMock).not.toHaveBeenCalled();
		expect(freeMock).not.toHaveBeenCalled();
	});
});

describe("a free journey, with no goal of its own", () => {
	const FREE = {
		url: "stripe.com",
		intent: undefined,
		task: undefined,
		apiKey: undefined,
		agent: undefined,
		json: false,
		noStream: false,
		via: "journey",
	};

	it("runs ora's curated task on the public journeys when no goal is given", async () => {
		process.exitCode = undefined;
		freeMock.mockResolvedValue(1);
		await argv("--domain", "stripe.com");
		expectOnly(freeMock);
		expect(freeInput()).toEqual(FREE);
		expect(process.exitCode).toBe(1);
	});

	it("maps the public flags onto the free run", async () => {
		await argv(
			"--domain=stripe.com",
			"--intent",
			"pricing",
			"--agent",
			"cas-sonnet",
			"--no-stream",
			"--json",
		);
		expectOnly(freeMock);
		expect(freeInput()).toEqual({
			...FREE,
			intent: "pricing",
			agent: "cas-sonnet",
			noStream: true,
			json: true,
		});
	});

	it("sends a goal with a public flag to the free path as its task", async () => {
		await argv(GOAL, "--domain", "stripe.com", "--api-key", "k");
		expectOnly(freeMock);
		expect(freeInput()).toEqual({ ...FREE, task: GOAL, apiKey: "k" });
	});

	it("takes a lone goal to the partner tier when only a partner key is set", async () => {
		vi.stubEnv("ORA_API_KEY", "");
		vi.stubEnv("ORA_PARTNER_API_KEY", "partner");
		await argv(GOAL, "--domain", "stripe.com");
		expectOnly(freeMock);
		expect(freeInput().task).toBe(GOAL);
	});

	it("keeps a goal on ora's platform when a platform key is set too", async () => {
		vi.stubEnv("ORA_API_KEY", "platform");
		vi.stubEnv("ORA_PARTNER_API_KEY", "partner");
		await argv(GOAL, "--domain", "stripe.com");
		expectOnly(oneMock);
	});

	it("refuses public and platform flags together, exit 2, with the call for the platform", async () => {
		process.exitCode = undefined;
		await argv(
			GOAL,
			"--domain",
			"stripe.com",
			"--intent",
			"pricing",
			"--no-stream",
			"--harness",
			"codex",
		);
		expect(process.exitCode).toBe(2);
		expect(errored()).toEqual([
			"--intent, --no-stream are for ora's free journeys and --harness for ora's platform; use one kind",
			`Next: ax journey '${GOAL}' --domain stripe.com --harness codex  # for ora's platform`,
		]);
		expect(freeMock).not.toHaveBeenCalled();
		expect(oneMock).not.toHaveBeenCalled();
	});

	it("needs --domain, exit 2", async () => {
		process.exitCode = undefined;
		await argv("--intent", "pricing");
		expect(process.exitCode).toBe(2);
		expect(errored()).toEqual([
			"--domain names the site the agent works on",
			"Next: ax journey --domain <domain>  # ora picks the task",
		]);
		expect(freeMock).not.toHaveBeenCalled();
	});
});

describe("journeyRoute", () => {
	const base = {
		goal: undefined,
		publicFlags: [],
		platformFlags: [],
		platformKey: false,
		partnerKey: false,
	};

	it("routes by the flags first, then by the goal and the keys", () => {
		expect(journeyRoute(base)).toEqual({ route: "public" });
		expect(journeyRoute({ ...base, goal: "g" })).toEqual({ route: "platform" });
		expect(journeyRoute({ ...base, goal: "g", partnerKey: true })).toEqual({ route: "public" });
		expect(journeyRoute({ ...base, goal: "g", platformKey: true, partnerKey: true })).toEqual({
			route: "platform",
		});
		expect(journeyRoute({ ...base, goal: "g", publicFlags: ["agent"] })).toEqual({
			route: "public",
		});
		expect(journeyRoute({ ...base, platformFlags: ["harness"] })).toEqual({ route: "platform" });
	});
});

describe("journeyUsage", () => {
	const usage = plain(journeyUsage());

	it("shows the free form and the goal form, and names the older command", () => {
		expect(usage).toContain("ax journey --domain <site> [--intent <id>] [--agent <id>]");
		expect(usage).toContain('ax journey "<goal>" [--domain <site>] [--harness <h>] [--model <m>]');
		expect(usage).toContain("ax deep-journey <url> is the older name for this");
	});
});

// A set of journeys: which typed forms reach the set commands, and that one journey is untouched.
vi.mock("./journey-set", () => ({
	journeySetRun: vi.fn(async () => 0),
	journeySetView: vi.fn(async () => 0),
	journeySetList: vi.fn(async () => 0),
	journeySetCancel: vi.fn(async () => 0),
}));

describe("ax journey: when the arguments ask for a set", async () => {
	const sets = vi.mocked(await import("./journey-set"));
	const typed = async (rawArgs: string[]) => {
		vi.clearAllMocks();
		oneMock.mockResolvedValue(0);
		freeMock.mockResolvedValue(0);
		await runCommand(journey, { rawArgs });
	};

	it("view, list and cancel take the first goal's place", async () => {
		await typed(["view", "set-1", "--wait", "5", "--json"]);
		expect(sets.journeySetView).toHaveBeenCalledWith({ id: "set-1", wait: "5", json: true });
		await typed(["list"]);
		expect(sets.journeySetList).toHaveBeenCalledWith({ json: false });
		await typed(["cancel", "set-1"]);
		expect(sets.journeySetCancel).toHaveBeenCalledWith({ id: "set-1", json: false });
		expect(oneMock).not.toHaveBeenCalled();
	});

	it("more than one goal is a set, with every goal as typed", async () => {
		await typed([GOAL, "Find the pricing page", "--domain", "linear.app", "--yes"]);
		expect(sets.journeySetRun).toHaveBeenCalledWith(
			expect.objectContaining({
				goals: [GOAL, "Find the pricing page"],
				yes: true,
				json: false,
				flags: expect.objectContaining({ domain: "linear.app", levels: false }),
			}),
		);
	});

	it.each([
		["--levels", []],
		["--agents", ["claude-code,codex"]],
		["--brand", ["Linear"]],
		["--docs", ["https://linear.app/docs"]],
		["--exact", ["https://linear.app/developers"]],
		["--repeat", ["3"]],
	])("one goal with %s is a set", async (flag, value) => {
		await typed([GOAL, "--domain", "linear.app", flag, ...value]);
		expect(sets.journeySetRun).toHaveBeenCalledTimes(1);
		expect(oneMock).not.toHaveBeenCalled();
	});

	it("one goal with none of a set's flags is still one journey", async () => {
		vi.stubEnv("ORA_API_KEY", "ora_sk_test");
		await typed([GOAL, "--domain", "linear.app"]);
		expect(sets.journeySetRun).not.toHaveBeenCalled();
		expect(oneMock).toHaveBeenCalledTimes(1);
	});
});
