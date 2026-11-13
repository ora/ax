import { describe, expect, it } from "vitest";
import agentsFixture from "../api/__fixtures__/studio/agents.json";
import usageFixture from "../api/__fixtures__/studio/usage.json";
import usageUnlimitedFixture from "../api/__fixtures__/studio/usage-unlimited.json";
import { StudioConnectionError, StudioShapeError } from "../api/studio";
import { studioError } from "../api/studio-errors";
import { STUDIO_SCOPES, type StudioAgent, type StudioUsage } from "../api/studio-types";
import type { LaunchResult } from "./launch";
import { type PreviewInput, previewTrial, type Refusal } from "./preview";
import {
	closeTerminalLine,
	confirmPrompt,
	GET_A_KEY,
	isProductNotGranted,
	PRODUCT_NOT_GRANTED_MESSAGE,
	type PreviewRender,
	progressLine,
	readFailureMessage,
	renderPreview,
	renderRefusal,
	renderRefusals,
	stopMessage,
} from "./render-preview";
import { parseTrialSpec, planCells, type TrialSpecInput } from "./spec";

// The recorded Studio bodies, unwrapped from their `{ success, data }` envelope, run through the
// real previewTrial, parseTrialSpec and planCells.
const catalog: StudioAgent[] = agentsFixture.data.agents;
const usage: StudioUsage = usageFixture.data;
const usageUnlimited: StudioUsage = usageUnlimitedFixture.data;

const TASK = "Find how to create an issue from the API";
const ESC = String.fromCharCode(27);
// biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for exactly these
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function inputs(overrides: Partial<TrialSpecInput> = {}, tasks: string[] = [TASK]) {
	const parsed = parseTrialSpec({ site: "linear.app", tasks, ...overrides });
	if (!parsed.ok) throw new Error(parsed.error);
	const plan = planCells(parsed.spec);
	return { spec: parsed.spec, cells: plan.cells, skipped: plan.skipped };
}

function go(
	overrides: Partial<TrialSpecInput> = {},
	rest: Partial<PreviewInput> = {},
	tasks: string[] = [TASK],
): PreviewRender {
	const { spec, cells, skipped } = inputs(overrides, tasks);
	const preview = previewTrial({
		spec,
		cells,
		scopes: [...STUDIO_SCOPES],
		agents: catalog,
		usage,
		...rest,
	});
	if (!preview.ok) throw new Error(`expected a go: ${JSON.stringify(preview.refusals)}`);
	return { spec, cells, skipped, preview };
}

function refuse(
	overrides: Partial<TrialSpecInput>,
	rest: Partial<PreviewInput> = {},
	tasks: string[] = [TASK],
): Refusal[] {
	const { spec, cells } = inputs(overrides, tasks);
	const result = previewTrial({
		spec,
		cells,
		scopes: [...STUDIO_SCOPES],
		agents: catalog,
		usage,
		...rest,
	});
	if (result.ok) throw new Error("expected a refusal");
	return result.refusals;
}

const withUsage = (resetsAt: string | null, remaining = 38): StudioUsage => ({
	...usage,
	runs: { ...usage.runs, remaining },
	resetsAt,
});

describe("GET_A_KEY", () => {
	it("is the pinned copy, word for word", () => {
		expect(GET_A_KEY).toBe(
			"Trials run on your Front account. Sign up at app.ora.ai with a work email (personal addresses are not accepted), then create an API key in your account settings with these scopes: `journeys:write`, `journeys:read`, `runs:read`, `runs:write`, `intents:read`. Set it as `ORA_API_KEY`. The Free plan includes a monthly number of runs; the preview shows what is left before anything runs.",
		);
	});

	it("names every scope the client asks for", () => {
		for (const scope of STUDIO_SCOPES) expect(GET_A_KEY).toContain(`\`${scope}\``);
	});
});

describe("renderPreview", () => {
	it("words the totals, the allowance and the tracked sites for one task at three levels", () => {
		const lines = renderPreview(go({ docs: "https://linear.app/docs", repeat: "2" }));
		expect(lines).toContain("This trial uses 6 runs (1 task x 3 levels x 1 agent x 2 repeats).");
		expect(lines).toContain("Your plan has 38 runs left this month (resets Dec 1).");
		expect(lines).toContain(
			"It adds linear.app to your Front account's tracked sites if it is not there yet (with a daily ora score scan, which does not count against your plan) and 6 journeys to your journeys list.",
		);
	});

	it("pluralises every count at 1 and at more than 1", () => {
		const many = renderPreview(go({}, {}, ["Create an issue", "Find the pricing page"]));
		expect(many[0]).toBe("This trial uses 4 runs (2 tasks x 2 levels x 1 agent x 1 repeat).");
		expect(many.at(-1)).toContain("and 4 journeys to your journeys list.");

		const one = renderPreview(oneRun());
		expect(one[0]).toBe("This trial uses 1 run (1 task x 1 level x 1 agent x 1 repeat).");
		expect(one).toContain("Your plan has 1 run left this month.");
		expect(one.at(-1)).toContain("and 1 journey to your journeys list.");
	});

	it("uses the task and level pairs form when tasks run different numbers of levels", () => {
		const lines = renderPreview(
			go(
				{
					agents: "claude-code/claude-haiku-4-5-20251001,claude-code/claude-sonnet-5-5",
					repeat: "3",
				},
				{},
				["Create an issue", "Use Linear to create an issue"],
			),
		);
		expect(lines[0]).toBe(
			"This trial uses 18 runs (3 task and level pairs x 2 agents x 3 repeats).",
		);
	});

	it("names the default agent only when --agents was omitted", () => {
		const defaulted = renderPreview(go());
		expect(defaulted).toContain(
			"Agent: Claude Code with Claude Haiku 4.5, the first one your plan offers. Choose others with --agents.",
		);
		const chosen = renderPreview(go({ agents: "claude-code/claude-sonnet-5-5" }));
		expect(chosen.some((line) => line.startsWith("Agent: "))).toBe(false);
	});

	it("names the brand it used", () => {
		expect(renderPreview(go())).toContain("Brand in the prompts: Linear. Change it with --brand.");
		expect(renderPreview(go({ brand: "Acme" }))).toContain(
			"Brand in the prompts: Acme. Change it with --brand.",
		);
	});

	it("prints every skip note verbatim", () => {
		const render = go({}, {}, ["Use Linear to create an issue", TASK]);
		expect(render.skipped).toHaveLength(5);
		const lines = renderPreview(render);
		for (const skip of render.skipped) expect(lines).toContain(skip.note);
		expect(lines).toContain(
			"No --docs URL, so the docs level is skipped. Add --docs <url> to include it.",
		);
		expect(lines).toContain(
			"No --exact URL, so the exact level is skipped. Add --exact <url> to include it.",
		);
		expect(lines).toContain(
			"The task names Linear, so the need level is skipped. Write the task without it to include that level.",
		);
	});

	it("says there is no monthly limit for an unlimited plan", () => {
		const lines = renderPreview(go({}, { usage: usageUnlimited }));
		expect(lines).toContain("Your plan has no monthly run limit.");
		expect(lines.some((line) => line.startsWith("Your plan has") && line.includes("left"))).toBe(
			false,
		);
	});

	it("drops the parenthesis when the reset date is null", () => {
		const lines = renderPreview(go({}, { usage: withUsage(null) }));
		expect(lines).toContain("Your plan has 38 runs left this month.");
	});

	it("drops the parenthesis when the reset date does not parse", () => {
		const lines = renderPreview(go({}, { usage: withUsage("soon") }));
		expect(lines).toContain("Your plan has 38 runs left this month.");
	});

	it("reads the reset date in UTC on any machine", () => {
		const earlier = process.env.TZ;
		try {
			for (const zone of ["Pacific/Honolulu", "Pacific/Auckland", "UTC"]) {
				process.env.TZ = zone;
				const midnight = renderPreview(go({}, { usage: withUsage("2026-12-01T00:00:00Z") }));
				expect(midnight).toContain("Your plan has 38 runs left this month (resets Dec 1).");
				const lateEvening = renderPreview(go({}, { usage: withUsage("2026-12-01T23:30:00Z") }));
				expect(lateEvening).toContain("Your plan has 38 runs left this month (resets Dec 1).");
			}
		} finally {
			if (earlier === undefined) delete process.env.TZ;
			else process.env.TZ = earlier;
		}
	});

	it("strips an escape sequence from a server string", () => {
		const hostile = catalog.map((entry) => ({
			...entry,
			harnessName: `${ESC}[2JCode`,
			modelName: `Model${ESC}]0;title\u0007`,
		}));
		const lines = renderPreview(go({}, { agents: hostile }));
		const agentLine = lines.find((line) => line.startsWith("Agent: "));
		expect(agentLine).toBeDefined();
		expect(agentLine).not.toMatch(CONTROL);
		expect(agentLine).toContain("Code");
	});
});

/** One task at the brand level only: one run, one journey, one run left on the plan. */
function oneRun(): PreviewRender {
	const render = go({}, {}, ["Create an issue"]);
	const cells = render.cells.filter((cell) => cell.level === "brand");
	const preview = previewTrial({
		spec: render.spec,
		cells,
		scopes: [...STUDIO_SCOPES],
		agents: catalog,
		usage: withUsage(null, 1),
	});
	if (!preview.ok) throw new Error("expected a go");
	return { ...render, cells, skipped: [], preview };
}

describe("the line printed once the record exists", () => {
	it("carries the real id", () => {
		expect(closeTerminalLine("t-abc123def4")).toBe(
			"You can close the terminal; `ax trial view t-abc123def4` picks it up.",
		);
	});
});

describe("confirmPrompt", () => {
	it("asks a question about the runs, ready for an answer", () => {
		expect(confirmPrompt(6)).toBe("Launch 6 runs? [y/N] ");
		expect(confirmPrompt(1)).toBe("Launch 1 run? [y/N] ");
	});
});

describe("renderRefusal", () => {
	it("lists each missing scope and ends with GET_A_KEY", () => {
		const refusals = refuse(
			{},
			{ scopes: ["journeys:read", "runs:read"], agents: undefined, usage: undefined },
		);
		const lines = renderRefusals(refusals);
		expect(lines[0]).toBe(
			"Your API key is missing these scopes: journeys:write, runs:write, intents:read.",
		);
		expect(lines.at(-1)).toBe(GET_A_KEY);
	});

	it("names an unknown agent", () => {
		const [refusal] = refuse({ agents: "nope" });
		expect(renderRefusal(refusal)).toEqual([
			"No agent is named nope. --agents takes harness or harness/model.",
		]);
	});

	it("quotes the catalog's reason for an unavailable agent", () => {
		const [refusal] = refuse({ agents: "codex" });
		expect(renderRefusal(refusal)).toEqual([
			"The agent codex is not available to your account: needs the Standard plan.",
		]);
	});

	it("handles an unavailable agent with no reason and a reason that ends in a period", () => {
		expect(renderRefusal({ kind: "unavailable_agent", requested: "codex", reason: null })).toEqual([
			"The agent codex is not available to your account.",
		]);
		expect(
			renderRefusal({ kind: "unavailable_agent", requested: "codex", reason: "needs Pro." }),
		).toEqual(["The agent codex is not available to your account: needs Pro."]);
	});

	it("strips an escape sequence from a catalog reason", () => {
		const [line] = renderRefusal({
			kind: "unavailable_agent",
			requested: "codex",
			reason: `${ESC}[31mneeds Pro${ESC}[0m`,
		});
		expect(line).not.toMatch(CONTROL);
		expect(line).toContain("needs Pro");
	});

	it("names two requests that land on one agent", () => {
		const [refusal] = refuse({ agents: "claude-code,claude-code/claude-haiku-4-5-20251001" });
		expect(renderRefusal(refusal)).toEqual([
			"claude-code and claude-code/claude-haiku-4-5-20251001 name the same agent, claude-code/claude-haiku-4-5-20251001. Name it once.",
		]);
	});

	it("says no agent is offered", () => {
		const none = catalog.map((entry) => ({ ...entry, available: false }));
		const [refusal] = refuse({}, { agents: none });
		expect(renderRefusal(refusal)).toEqual([
			"No agent is available to your account right now. Check your plan at app.ora.ai.",
		]);
	});

	it("states the run cap", () => {
		const everyAgent = catalog.map((entry) => ({ ...entry, available: true, reason: null }));
		const [refusal] = refuse(
			{
				agents: "codex,claude-code/claude-haiku-4-5-20251001,claude-code/claude-sonnet-5-5",
				repeat: "10",
			},
			{ agents: everyAgent },
			["a", "b", "c", "d", "e"],
		);
		expect(renderRefusal(refusal)).toEqual([
			"This trial would use 300 runs, and a trial is capped at 200. Cut tasks, agents or repeats.",
		]);
	});

	it("says which repeat count fits, pluralised", () => {
		// Two cells per repeat with 6 runs left: 3 repeats do not fit, 2 do.
		const two = refuse({ repeat: "4" }, { usage: withUsage("2026-12-01T00:00:00Z", 6) }, [
			"Create an issue",
		]);
		expect(renderRefusal(two[0])).toEqual([
			"This trial needs 8 runs and your plan has 6 runs left this month (resets Dec 1).",
			"3 repeats fit: 6 runs. Try --repeat 3.",
		]);
		const one = refuse({ repeat: "3" }, { usage: withUsage(null, 2) }, ["Create an issue"]);
		expect(renderRefusal(one[0])).toEqual([
			"This trial needs 6 runs and your plan has 2 runs left this month.",
			"1 repeat fits: 2 runs. Try --repeat 1.",
		]);
		const exactTwo = refuse({ repeat: "3" }, { usage: withUsage(null, 5) }, ["Create an issue"]);
		expect(renderRefusal(exactTwo[0])[1]).toBe("2 repeats fit: 4 runs. Try --repeat 2.");
	});

	it("says when not even one repeat fits", () => {
		const [refusal] = refuse({}, { usage: withUsage("2026-12-01T00:00:00Z", 1) }, [
			"Create an issue",
		]);
		expect(renderRefusal(refusal)).toEqual([
			"This trial needs 2 runs and your plan has 1 run left this month (resets Dec 1).",
			"Not even one repeat fits in what is left. Cut tasks or agents, or wait for the reset.",
		]);
	});

	it("prints every refusal when there are several", () => {
		const lines = renderRefusals([
			{ kind: "unknown_agent", requested: "a" },
			{ kind: "unknown_agent", requested: "b" },
		]);
		expect(lines).toHaveLength(2);
	});
});

describe("the product grant message", () => {
	it("says the key is for another product and ends with GET_A_KEY", () => {
		expect(PRODUCT_NOT_GRANTED_MESSAGE).toContain("made for another product");
		expect(PRODUCT_NOT_GRANTED_MESSAGE).toContain("Create a key in your Front account settings.");
		expect(PRODUCT_NOT_GRANTED_MESSAGE.endsWith(GET_A_KEY)).toBe(true);
	});

	it("recognises a 403 with that code and nothing else", () => {
		const grant = studioError({ status: 403, payload: { code: "PRODUCT_NOT_GRANTED" } });
		expect(isProductNotGranted(grant)).toBe(true);
		expect(isProductNotGranted(studioError({ status: 403, payload: { code: "OTHER" } }))).toBe(
			false,
		);
		expect(
			isProductNotGranted(studioError({ status: 401, payload: { code: "PRODUCT_NOT_GRANTED" } })),
		).toBe(false);
		expect(isProductNotGranted(new Error("PRODUCT_NOT_GRANTED"))).toBe(false);
	});
});

describe("progressLine", () => {
	it("counts queued, running and finished", () => {
		expect(progressLine({ queued: 2, running: 1, finished: 3, waitingForSlot: false })).toBe(
			"2 queued, 1 running, 3 finished",
		);
	});

	it("adds the slot clause when a run waits for one", () => {
		expect(progressLine({ queued: 2, running: 1, finished: 0, waitingForSlot: true })).toBe(
			"2 queued, 1 running, 0 finished; waiting for your plan's run slot",
		);
	});
});

describe("stopMessage", () => {
	const stop = (over: Partial<LaunchResult>): LaunchResult => ({
		launchedRuns: 4,
		notLaunched: 6,
		...over,
	});
	const MAY_HAVE_STARTED =
		"The last journey may have started its runs anyway; they will show in your account's journeys list.";
	const DOWN = "The platform is likely down, so launching stopped. Runs that started keep running.";

	it("is empty for a launch that ran to the end", () => {
		expect(stopMessage(stop({ notLaunched: 0 }))).toEqual([]);
	});

	it("says how many runs the quota left unlaunched, and that what started is followed", () => {
		expect(stopMessage(stop({ stoppedReason: "quota" }))).toEqual([
			"Your plan's run limit was reached, so launching stopped. 6 runs were not launched.",
			"Following the 4 runs that started.",
		]);
		expect(stopMessage(stop({ stoppedReason: "quota", notLaunched: 1, launchedRuns: 1 }))).toEqual([
			"Your plan's run limit was reached, so launching stopped. 1 run was not launched.",
			"Following the 1 run that started.",
		]);
	});

	it("says no run started when the quota stopped the first journey", () => {
		expect(stopMessage(stop({ stoppedReason: "quota", launchedRuns: 0 }))[1]).toBe(
			"No run started.",
		);
	});

	it("adds the may have started line for a gateway 502", () => {
		const lastError = studioError({ status: 502, payload: null });
		expect(lastError.gateway).toBe(true);
		expect(stopMessage(stop({ stoppedReason: "platform_down", lastError }))).toEqual([
			DOWN,
			MAY_HAVE_STARTED,
		]);
	});

	it("adds the may have started line for a connection error", () => {
		const lastError = new StudioConnectionError("https://api.example", new Error("boom"));
		expect(stopMessage(stop({ stoppedReason: "platform_down", lastError }))).toContain(
			MAY_HAVE_STARTED,
		);
	});

	it("adds the may have started line for an answer of the wrong shape", () => {
		const lastError = new StudioShapeError("a create", "a journey id");
		expect(stopMessage(stop({ stoppedReason: "platform_down", lastError }))).toContain(
			MAY_HAVE_STARTED,
		);
	});

	it("leaves the line out after Studio's own 502", () => {
		const lastError = studioError({
			status: 502,
			payload: { data: { journeyId: "j-1", runIds: [], failed: [] } },
		});
		expect(lastError.gateway).toBe(false);
		expect(stopMessage(stop({ stoppedReason: "platform_down", lastError }))).toEqual([DOWN]);
	});

	it("leaves the line out when no error is known", () => {
		expect(stopMessage(stop({ stoppedReason: "platform_down" }))).toEqual([DOWN]);
	});

	it("quotes an API error's message and says what keeps running", () => {
		const lastError = studioError({ status: 500, payload: { message: "database is down" } });
		expect(stopMessage(stop({ stoppedReason: "api_error", lastError }))).toEqual([
			"The platform answered with an error, so launching stopped: ora request failed (500): database is down",
			"6 runs were not launched. Runs that started keep running.",
		]);
	});

	it("strips an escape sequence from the quoted error", () => {
		const lastError = new Error(`${ESC}[2Jcleared`);
		const lines = stopMessage(stop({ stoppedReason: "api_error", lastError }));
		expect(lines[0]).not.toMatch(CONTROL);
		expect(lines[0]).toContain("cleared");
	});

	it("says launching was interrupted", () => {
		expect(stopMessage(stop({ stoppedReason: "interrupted" }))).toEqual([
			"Launching stopped. 6 runs were not launched. Runs that started keep running.",
		]);
	});

	it("never names a command: the Next lines do", () => {
		for (const reason of ["quota", "platform_down", "api_error", "interrupted"] as const) {
			for (const line of stopMessage(stop({ stoppedReason: reason }))) {
				expect(line).not.toMatch(/ax trial/);
			}
		}
	});
});

describe("readFailureMessage", () => {
	it("says reading kept failing, with the last error when there is one", () => {
		expect(readFailureMessage()).toEqual(["Reading from the platform kept failing."]);
		const lines = readFailureMessage(new Error(`${ESC}[31mdown`));
		expect(lines[1]).toBe("The last error:  [31mdown");
		expect(lines[1]).not.toContain(ESC);
	});
});

describe("copy rules", () => {
	it("uses no dash characters and no time estimates in any string", () => {
		const all: string[] = [
			GET_A_KEY,
			PRODUCT_NOT_GRANTED_MESSAGE,
			confirmPrompt(3),
			closeTerminalLine("t-abc123def4"),
			progressLine({ queued: 1, running: 1, finished: 1, waitingForSlot: true }),
			...renderPreview(go({}, {}, ["Use Linear to create an issue"])),
			...(["quota", "platform_down", "api_error", "interrupted"] as const).flatMap((reason) =>
				stopMessage({ launchedRuns: 1, notLaunched: 2, stoppedReason: reason }),
			),
			...readFailureMessage(new Error("down")),
		];
		for (const text of all) {
			expect(text).not.toMatch(/[\u2013\u2014]/);
			expect(text).not.toMatch(/\b(minutes?|seconds?|hours?|about|takes)\b/i);
		}
	});
});
