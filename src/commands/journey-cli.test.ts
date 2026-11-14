import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deepJourneyCommand } from "./deep-journey";
import { journeyCommand } from "./journey";
import { firstPositional, journey, journeyRoute, journeyUsage } from "./journey-cli";
import { journeySetRunCommand, journeySetViewCommand } from "./journey-set";
import { journeySetCancelCommand, journeySetListCommand } from "./journey-set-records";

// The six command functions are mocked: these tests pin which one a typed `ax journey` reaches,
// how its arguments map onto that input, and that each exit code reaches process.exitCode.
// Arguments go through citty's own parser (runCommand), so positionals and flag values are the
// real ones.
vi.mock("./journey", () => ({ journeyCommand: vi.fn() }));
vi.mock("./deep-journey", () => ({ deepJourneyCommand: vi.fn() }));
vi.mock("./journey-set", () => ({ journeySetRunCommand: vi.fn(), journeySetViewCommand: vi.fn() }));
vi.mock("./journey-set-records", () => ({
	journeySetListCommand: vi.fn(),
	journeySetCancelCommand: vi.fn(),
}));

const oneMock = vi.mocked(journeyCommand);
const setMock = vi.mocked(journeySetRunCommand);
const viewMock = vi.mocked(journeySetViewCommand);
const listMock = vi.mocked(journeySetListCommand);
const cancelMock = vi.mocked(journeySetCancelCommand);
const freeMock = vi.mocked(deepJourneyCommand);

const savedExitCode = process.exitCode;
const GOAL = "Find how to create an issue from the API";

beforeEach(() => {
	oneMock.mockResolvedValue(0);
	setMock.mockResolvedValue(0);
	viewMock.mockResolvedValue(0);
	listMock.mockReturnValue(0);
	cancelMock.mockResolvedValue(0);
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
const setInput = () => setMock.mock.calls[0][0];
const errored = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0]));

function expectOnly(mock: { mock: { calls: unknown[] } }) {
	for (const other of [oneMock, setMock, viewMock, listMock, cancelMock, freeMock]) {
		expect(other.mock.calls).toHaveLength(other === mock ? 1 : 0);
	}
}

describe("one journey", () => {
	it("runs for one goal with no set flags, on claude-code by default", async () => {
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

	it("reads a single --agents entry as the harness and the model", async () => {
		await argv(GOAL, "--agents", "codex/gpt-5.5");
		expectOnly(oneMock);
		expect(oneInput()).toMatchObject({ harness: "codex", model: "gpt-5.5" });
		await argv(GOAL, "--agents", "eve");
		expect(oneMock.mock.calls[1][0]).toMatchObject({ harness: "eve", model: undefined });
	});

	it("stays one journey with --repeat 1, and ignores --yes and --wait", async () => {
		await argv(GOAL, "--repeat", "1", "--yes", "--wait", "5");
		expectOnly(oneMock);
		expect(Object.keys(oneInput()).sort()).toEqual([
			"domain",
			"harness",
			"intent",
			"json",
			"model",
		]);
	});

	it.each([0, 1, 2])("sets process.exitCode to the returned %i", async (code) => {
		oneMock.mockResolvedValue(code);
		process.exitCode = undefined;
		await argv(GOAL);
		expect(process.exitCode).toBe(code);
	});
});

describe("a set of journeys", () => {
	it("runs for several goals, in the order typed, with every value as typed", async () => {
		await argv(
			...[GOAL, "Plan a sprint", "--domain", "linear.app", "--brand", "Linear"],
			...["--docs", "https://d.example", "--exact", "https://e.example", "--repeat", "3"],
			...["--wait", "15", "--yes", "--json"],
		);
		expectOnly(setMock);
		expect(setInput()).toEqual({
			site: "linear.app",
			goals: [GOAL, "Plan a sprint"],
			agents: undefined,
			levels: false,
			brand: "Linear",
			docs: "https://d.example",
			exact: "https://e.example",
			repeat: "3",
			wait: "15",
			yes: true,
			json: true,
		});
	});

	it("runs for --levels, --brand, --docs or --exact, passing --levels as typed", async () => {
		await argv(GOAL, "--domain", "linear.app", "--levels");
		expect(setInput()).toMatchObject({ levels: true, goals: [GOAL] });
		for (const flag of [
			["--brand", "Linear"],
			["--docs", "https://linear.app/docs"],
			["--exact", "https://linear.app/developers"],
		]) {
			setMock.mockClear();
			await argv(GOAL, "--domain", "linear.app", ...flag);
			expect(setInput()).toMatchObject({ levels: false });
		}
		expect(oneMock).not.toHaveBeenCalled();
	});

	it("runs for several agents or a repeat above 1, passing --agents as typed", async () => {
		await argv(GOAL, "--domain", "linear.app", "--agents", "claude-code/opus, codex");
		expect(setInput()).toMatchObject({ agents: "claude-code/opus, codex" });
		await argv(GOAL, "--domain", "linear.app", "--repeat", "2");
		expect(setMock.mock.calls[1][0]).toMatchObject({ repeat: "2", agents: undefined });
		expect(oneMock).not.toHaveBeenCalled();
	});

	it("turns --harness and --model into the set's one agent", async () => {
		await argv(GOAL, "--levels", "--harness", "codex", "--model", "gpt-5.5");
		await argv(GOAL, "--levels", "--harness", "codex");
		await argv(GOAL, "--levels", "--model", "claude-opus-5");
		expect(setMock.mock.calls.map(([input]) => input.agents)).toEqual([
			"codex/gpt-5.5",
			"codex",
			"claude-code/claude-opus-5",
		]);
	});

	it("passes a missing --domain on, for the set to refuse", async () => {
		await argv(GOAL, "--levels");
		expect(setInput().site).toBeUndefined();
	});

	it("passes no test seam to the command", async () => {
		await argv(GOAL, "--levels", "--yes");
		for (const seam of ["setsDir", "client", "now", "sleep", "ask"]) {
			expect(setInput()).not.toHaveProperty(seam);
		}
	});

	it.each([0, 2, 3, 130])("sets process.exitCode to the returned %i", async (code) => {
		setMock.mockResolvedValue(code);
		process.exitCode = undefined;
		await argv(GOAL, "--levels");
		expect(process.exitCode).toBe(code);
	});
});

describe("usage errors before either path", () => {
	it("refuses --agents with --harness or --model, exit 2, with the call without them", async () => {
		process.exitCode = undefined;
		await argv(GOAL, "--domain", "linear.app", "--agents", "codex", "--harness", "eve");
		expect(process.exitCode).toBe(2);
		expect(errored()).toEqual([
			"--agents cannot be combined with --harness: name each agent in --agents as harness or harness/model",
			`Next: ax journey '${GOAL}' --domain linear.app --agents codex  # --agents alone names the agents`,
		]);
		await argv(GOAL, "--agents", "codex", "--model=gpt-5.5", "--json");
		expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('"INVALID_FLAG"'));
		expect(errored()[2]).toMatch(/^--agents cannot be combined with --model:/);
		expect(oneMock).not.toHaveBeenCalled();
		expect(setMock).not.toHaveBeenCalled();
	});

	it("refuses a bad --agents or --repeat, since the mode cannot be told without them", async () => {
		process.exitCode = undefined;
		await argv(GOAL, "--repeat", "0");
		expect(process.exitCode).toBe(2);
		expect(errored()[0]).toMatch(/^--repeat must be an integer between 1 and 10/);
		expect(errored()[1]).toBe(
			"Next: ax journey <goal> --domain <site> --levels  # with the value named above fixed",
		);
		expect(oneMock).not.toHaveBeenCalled();
		expect(setMock).not.toHaveBeenCalled();
	});
});

describe("view, list and cancel", () => {
	it("view passes the id, --wait and --json", async () => {
		await argv("view", "j-0123456789", "--wait", "5", "--json");
		expectOnly(viewMock);
		expect(viewMock).toHaveBeenCalledWith({ id: "j-0123456789", wait: "5", json: true });
	});

	it("view leaves --wait undefined and --json false when not typed", async () => {
		await argv("view", "j-0123456789");
		expect(viewMock).toHaveBeenCalledWith({ id: "j-0123456789", wait: undefined, json: false });
	});

	it("list passes --json, and sets the exit code from its synchronous return", async () => {
		process.exitCode = 9;
		await argv("--json", "list");
		expectOnly(listMock);
		expect(listMock).toHaveBeenCalledWith({ json: true });
		expect(process.exitCode).toBe(0);
	});

	it("cancel passes the id and --json", async () => {
		await argv("cancel", "j-0123456789", "--json");
		expectOnly(cancelMock);
		expect(cancelMock).toHaveBeenCalledWith({ id: "j-0123456789", json: true });
	});

	it("sets process.exitCode to what view and cancel return", async () => {
		viewMock.mockResolvedValue(130);
		cancelMock.mockResolvedValue(3);
		process.exitCode = undefined;
		await argv("view", "j-0123456789");
		expect(process.exitCode).toBe(130);
		await argv("cancel", "j-0123456789");
		expect(process.exitCode).toBe(3);
	});

	it("reads the word only as the first positional, never as a flag's value or a later goal", async () => {
		await argv("--domain", "list", GOAL);
		await argv(GOAL, "view");
		expect(listMock).not.toHaveBeenCalled();
		expect(viewMock).not.toHaveBeenCalled();
		expect(oneInput()).toMatchObject({ intent: GOAL, domain: "list" });
		expect(setInput().goals).toEqual([GOAL, "view"]);
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
	const freeInput = () => freeMock.mock.calls[0][0];

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

	it("keeps a goal on the Front account when a Front key is set too", async () => {
		vi.stubEnv("ORA_API_KEY", "front");
		vi.stubEnv("ORA_PARTNER_API_KEY", "partner");
		await argv(GOAL, "--domain", "stripe.com");
		expectOnly(oneMock);
	});

	it("refuses public and Front flags together, exit 2, with the call for Front", async () => {
		process.exitCode = undefined;
		await argv(GOAL, "--domain", "stripe.com", "--intent", "pricing", "--no-stream", "--levels");
		expect(process.exitCode).toBe(2);
		expect(errored()).toEqual([
			"--intent, --no-stream are for ora's free journeys and --levels for your Front account's; use one kind",
			`Next: ax journey '${GOAL}' --domain stripe.com --levels  # for your Front account`,
		]);
		expect(freeMock).not.toHaveBeenCalled();
		expect(setMock).not.toHaveBeenCalled();
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

	it("refuses several goals with a public flag, since a free run takes one", async () => {
		process.exitCode = undefined;
		await argv(GOAL, "Find the pricing page", "--domain", "stripe.com", "--agent", "cas-haiku");
		expect(process.exitCode).toBe(2);
		expect(errored()[0]).toBe(
			"a free run takes one goal; several goals run a set, on your Front account",
		);
		expect(freeMock).not.toHaveBeenCalled();
	});

	it("sends no goal with a Front flag to the Front path, where the set asks for a goal", async () => {
		await argv("--domain", "stripe.com", "--levels");
		expectOnly(setMock);
		expect(setInput().goals).toEqual([]);
	});
});

describe("journeyRoute", () => {
	const base = { goals: [], publicFlags: [], frontFlags: [], frontKey: false, partnerKey: false };

	it("routes by the flags first, then by the goal and the keys", () => {
		expect(journeyRoute(base)).toEqual({ route: "public" });
		expect(journeyRoute({ ...base, goals: ["g"] })).toEqual({ route: "front" });
		expect(journeyRoute({ ...base, goals: ["g"], partnerKey: true })).toEqual({ route: "public" });
		expect(journeyRoute({ ...base, goals: ["g", "h"], partnerKey: true })).toEqual({
			route: "front",
		});
		expect(journeyRoute({ ...base, goals: ["g"], frontKey: true, partnerKey: true })).toEqual({
			route: "front",
		});
		expect(journeyRoute({ ...base, goals: ["g"], publicFlags: ["agent"] })).toEqual({
			route: "public",
		});
		expect(journeyRoute({ ...base, frontFlags: ["levels"] })).toEqual({ route: "front" });
	});
});

describe("firstPositional", () => {
	it("skips flags and the values of string flags, even values that look like flags", () => {
		expect(firstPositional(["--json", "--domain", "--x", "list"])).toBe(3);
		expect(firstPositional(["--domain=linear.app", "view", "j-1"])).toBe(1);
		expect(firstPositional(["--levels", "goal"])).toBe(1);
	});

	it("takes the argument after -- as positional, and -1 when there is none", () => {
		expect(firstPositional(["--", "--json"])).toBe(1);
		expect(firstPositional(["--json", "--"])).toBe(-1);
		expect(firstPositional([])).toBe(-1);
	});
});

describe("journeyUsage", () => {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the color codes picocolors may add
	const usage = journeyUsage().replace(/\u001b\[[0-9;]*m/g, "");

	it("shows the one journey form, the set form and the three commands", () => {
		expect(usage).toContain('ax journey "<goal>" [--domain <site>] [--harness <h>] [--model <m>]');
		expect(usage).toContain('ax journey "<goal>" ["<goal>" ...] --domain <site> [--agents <list>]');
		for (const command of ["view <id>", "list [--json]", "cancel <id>"]) {
			expect(usage).toContain(`ax journey ${command}`);
		}
		for (const flag of [
			"--levels",
			"--brand",
			"--docs",
			"--exact",
			"--repeat",
			"--yes",
			"--wait",
		]) {
			expect(usage).toContain(flag);
		}
	});

	it("states the mode rule, the reserved words and what one journey ignores", () => {
		expect(usage).toContain("ax runs a set of journeys");
		expect(usage).toContain("a goal cannot be just view, list or cancel");
		expect(usage).toContain("--yes and --wait apply to a set; one journey ignores them.");
		expect(usage).not.toMatch(/\btrials?\b/i);
	});
});
