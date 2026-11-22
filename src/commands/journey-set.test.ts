import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformApiError } from "../api/platform-error";
import type { SetDocument, SetList, SetPreview, SetRequest, SetsClient } from "../api/sets";
import { KeyRejectedError, SignInEndedError } from "../auth/errors";
import { platformCredentials } from "../auth/resolve-credential";
import { SessionStore } from "../auth/session-store";
import list from "../journey-set/__fixtures__/list.json";
import preview from "../journey-set/__fixtures__/preview.json";
import complete from "../journey-set/__fixtures__/set-complete.json";
import created from "../journey-set/__fixtures__/set-created.json";
import running from "../journey-set/__fixtures__/set-running.json";
import { EXIT } from "./exit-codes";
import {
	INTERRUPTED,
	journeySetCancel,
	journeySetList,
	journeySetRun,
	journeySetView,
	progressLines,
} from "./journey-set";

// The set commands over a client that answers the platform's real documents (the fixtures). These
// pin what each command asks, what it prints where, and its exit code.
const PREVIEW = preview as SetPreview;
const CREATED = created as SetDocument;
const RUNNING = running as SetDocument;
const COMPLETE = complete as SetDocument;

function fakeClient(over: Partial<SetsClient> = {}) {
	const calls: { op: string; arg?: unknown }[] = [];
	const gets = [RUNNING, COMPLETE];
	/** Records the call, then answers. */
	const noted = <T>(op: string, arg: unknown, answer: T): T => {
		calls.push(arg === undefined ? { op } : { op, arg });
		return answer;
	};
	const client: SetsClient = {
		preview: async (request: SetRequest) => noted("preview", request, PREVIEW),
		create: async (request: SetRequest) => noted("create", request, CREATED),
		get: async (id: string) => noted("get", id, gets.shift() ?? COMPLETE),
		list: async () => noted("list", undefined, list as SetList),
		cancel: async (id: string) => noted("cancel", id, { setId: id, cancelled: true }),
		// No live stream unless a test gives one: the platform cannot open it.
		follow: async (id: string) => {
			noted("follow", id, undefined);
			throw new PlatformApiError("No such route", { status: 404 });
		},
		...over,
	};
	return { client, calls };
}

let stdout = "";
let stderr = "";
beforeEach(() => {
	stdout = "";
	stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout += String(chunk);
		return true;
	});
	vi.spyOn(console, "log").mockImplementation((...args) => {
		stdout += `${args.join(" ")}\n`;
	});
	vi.spyOn(console, "error").mockImplementation((...args) => {
		stderr += `${args.join(" ")}\n`;
	});
});
afterEach(() => vi.restoreAllMocks());

const run = (over: Record<string, unknown> = {}, client = fakeClient()) =>
	journeySetRun({
		goals: ["Find how to create an issue from the API"],
		flags: { domain: "linear.app", levels: true },
		yes: true,
		json: false,
		client: client.client,
		sleep: async () => {},
		interrupt: new AbortController().signal,
		...over,
	}).then((exit) => ({ exit, calls: client.calls }));

describe("ax journey: a set", () => {
	it("previews, launches, watches until the set is complete, and prints the report on stdout", async () => {
		const { exit, calls } = await run();
		expect(exit).toBe(EXIT.OK);
		expect(calls.map((c) => c.op)).toEqual(["preview", "create", "get", "get"]);
		expect(calls[0].arg).toEqual({
			site: "linear.app",
			goals: ["Find how to create an issue from the API"],
			levels: true,
		});
		expect(stderr).toContain("linear.app: a set of journeys");
		expect(stdout).toContain(`linear.app  set ${COMPLETE.setId}`);
		expect(stdout).toContain(`Next: ${COMPLETE.next.line}`);
	});

	it("under --json, stdout is the platform's document exactly as served, and the Next line goes to stderr", async () => {
		const { exit } = await run({ json: true });
		expect(exit).toBe(EXIT.OK);
		expect(JSON.parse(stdout)).toEqual(COMPLETE);
		expect(stderr).toContain(`Next: ${COMPLETE.next.line}`);
	});

	it("asks before launching, and launches nothing on anything but yes", async () => {
		const declined = fakeClient();
		const no = await run(
			{
				yes: false,
				ask: async (question: string) => {
					expect(question).toBe("Launch 10 runs? [y/N] ");
					return "n";
				},
			},
			declined,
		);
		expect(no.exit).toBe(EXIT.OK);
		expect(declined.calls.map((c) => c.op)).toEqual(["preview"]);
		expect(stderr).toContain("Nothing was launched.");
		const agreed = await run({ yes: false, ask: async () => "y" });
		expect(agreed.calls.map((c) => c.op)).toContain("create");
	});

	it("with no terminal to ask on and no --yes, launches nothing and exits 2", async () => {
		const client = fakeClient();
		const { exit } = await run({ yes: false, ask: async () => null }, client);
		expect(exit).toBe(EXIT.USAGE);
		expect(client.calls.map((c) => c.op)).toEqual(["preview"]);
	});

	it("refuses a set the preview says does not fit, before anything is launched", async () => {
		const client = fakeClient({
			preview: async () => ({
				...PREVIEW,
				runs: { total: 240, limit: 200, left: 9000, fits: true },
			}),
		});
		const { exit } = await run({}, client);
		expect(exit).toBe(EXIT.USAGE);
		expect(stderr).toContain("would start 240 runs");
		expect(stderr).toContain("Nothing was launched.");
	});

	it("a usage mistake never reaches the platform", async () => {
		const client = fakeClient();
		expect((await run({ flags: { levels: false } }, client)).exit).toBe(EXIT.USAGE);
		expect((await run({ wait: "soon" }, client)).exit).toBe(EXIT.USAGE);
		expect(client.calls).toEqual([]);
	});

	it("the platform's refusal is exit 2 with its own body under --json; its failure is exit 3", async () => {
		const body = {
			error: "Unprocessable",
			code: "SET_INVALID",
			message: "'cursor' is not an agent your plan offers.",
		};
		const refused = fakeClient({
			preview: async () => {
				throw new PlatformApiError(body.message, { status: 422, payload: body });
			},
		});
		expect((await run({ json: true }, refused)).exit).toBe(EXIT.USAGE);
		expect(JSON.parse(stdout)).toEqual(body);
		stdout = "";
		const down = fakeClient({
			preview: async () => {
				throw new PlatformApiError("ora answered HTTP 503", { status: 503, payload: null });
			},
		});
		expect((await run({}, down)).exit).toBe(EXIT.API);
	});

	it("when the wait runs out it prints what it has, says why, and points at view", async () => {
		const client = fakeClient({ get: async () => RUNNING });
		let clock = 0;
		const { exit } = await run({ wait: "1", now: () => (clock += 40_000) }, client);
		expect(exit).toBe(EXIT.OK);
		expect(stderr).toContain("The wait ran out before the set finished.");
		expect(stdout).toContain(`Next: ax journey view ${RUNNING.setId}`);
	});

	it("Ctrl-C stops watching, not the set: it points at view and exits 130", async () => {
		const interrupt = new AbortController();
		const client = fakeClient({ get: async () => RUNNING });
		const { exit } = await run(
			{ interrupt: interrupt.signal, sleep: async () => interrupt.abort() },
			client,
		);
		expect(exit).toBe(INTERRUPTED);
		expect(client.calls.map((c) => c.op)).not.toContain("cancel");
		expect(stderr).toContain("Stopped watching. The set's runs go on.");
		expect(stdout).toContain(`Next: ax journey view ${CREATED.setId}`);
	});
});

describe("ax journey view, list and cancel", () => {
	it("view prints the set as it stands; a complete one ends with the platform's next step", async () => {
		const { client, calls } = fakeClient({ get: async () => COMPLETE });
		const asked: string[] = [];
		const watched: SetsClient = {
			...client,
			get: async (id: string) => {
				asked.push(id);
				return COMPLETE;
			},
		};
		expect(await journeySetView({ id: COMPLETE.setId, json: false, client: watched })).toBe(
			EXIT.OK,
		);
		calls.push(...asked.map((id) => ({ op: "get", arg: id })));
		expect(calls).toEqual([{ op: "get", arg: COMPLETE.setId }]);
		expect(stdout).toContain(`Next: ${COMPLETE.next.line}`);
	});

	it("view of a set that is still going points back at view, and needs an id", async () => {
		const { client } = fakeClient({ get: async () => RUNNING });
		expect(await journeySetView({ id: RUNNING.setId, json: false, client })).toBe(EXIT.OK);
		expect(stdout).toContain(`Next: ax journey view ${RUNNING.setId}`);
		expect(await journeySetView({ id: undefined, json: false, client })).toBe(EXIT.USAGE);
	});

	it("an unknown set id is a usage error with the platform's body under --json", async () => {
		const body = { error: "Not Found", code: "SET_NOT_FOUND", message: "No such set." };
		const { client } = fakeClient({
			get: async () => {
				throw new PlatformApiError(body.message, { status: 404, payload: body });
			},
		});
		expect(await journeySetView({ id: "nope", json: true, client })).toBe(EXIT.USAGE);
		expect(JSON.parse(stdout)).toEqual(body);
	});

	it("list prints the sets as served, and under --json the served document", async () => {
		const { client } = fakeClient();
		expect(await journeySetList({ json: false, client })).toBe(EXIT.OK);
		expect(stdout).toContain((list as SetList).sets[0].setId);
		stdout = "";
		expect(await journeySetList({ json: true, client })).toBe(EXIT.OK);
		expect(JSON.parse(stdout)).toEqual(list);
	});

	it("a list the platform refuses for a reason other than the key points back at the list, not at a key", async () => {
		const refused = new PlatformApiError("This organization does not have the product.", {
			status: 403,
			payload: { code: "PRODUCT_REQUIRED" },
		});
		const { client } = fakeClient({ list: () => Promise.reject(refused) });
		expect(await journeySetList({ json: false, client })).toBe(EXIT.USAGE);
		expect(stderr).toContain("Next: ax journey list");
		expect(stderr).not.toContain("ORA_API_KEY");
	});

	it("a sign-in ora no longer accepts sends the person to ax login, and is ora's refusal (exit 3)", async () => {
		const ended = new SignInEndedError("Your ax sign-in has ended.");
		const { client } = fakeClient({ list: () => Promise.reject(ended) });
		expect(await journeySetList({ json: false, client })).toBe(EXIT.API);
		expect(stderr).toContain("Your ax sign-in has ended.");
		expect(stderr).toContain("Next: ax login");
	});

	it("a platform key ora rejects is the caller's to fix (exit 2), in the key's own words", async () => {
		const rejected = new KeyRejectedError("ora did not accept your credential: check ORA_API_KEY.");
		const { client } = fakeClient({ list: () => Promise.reject(rejected) });
		expect(await journeySetList({ json: false, client })).toBe(EXIT.USAGE);
		expect(stderr).toContain("check ORA_API_KEY");
		expect(stderr).not.toContain("could not be reached");
	});

	it("cancel asks the platform to stop the set and prints its answer unchanged under --json", async () => {
		const { client, calls } = fakeClient();
		expect(await journeySetCancel({ id: "set-1", json: true, client })).toBe(EXIT.OK);
		expect(calls).toEqual([{ op: "cancel", arg: "set-1" }]);
		expect(JSON.parse(stdout)).toEqual({ setId: "set-1", cancelled: true });
		expect(await journeySetCancel({ id: undefined, json: false, client })).toBe(EXIT.USAGE);
	});

	it("cancel of a set that is already over is not a failure: ora's own sentence, a pointer at view, exit 0", async () => {
		// The body ora's set API gives for a finished set, 2026-11-22.
		const body = {
			error: "Set engine",
			code: "SET_ALREADY_OVER",
			message: "This set is complete: nothing is left to stop.",
		};
		const { client } = fakeClient({
			cancel: async () => {
				throw new PlatformApiError(body.message, { status: 409, payload: body });
			},
		});
		expect(await journeySetCancel({ id: "set-1", json: false, client })).toBe(EXIT.OK);
		expect(stdout).toContain("This set is complete: nothing is left to stop.");
		expect(stdout).toContain("Next: ax journey view set-1");
		expect(stderr).toBe("");
		stdout = "";
		expect(await journeySetCancel({ id: "set-1", json: true, client })).toBe(EXIT.OK);
		expect(JSON.parse(stdout)).toEqual(body);
	});

	it("any other refusal of a cancel is still a failure", async () => {
		const body = {
			error: "Set engine",
			code: "SET_CONFLICT",
			message: "The set is not in a state that allows this.",
		};
		const { client } = fakeClient({
			cancel: async () => {
				throw new PlatformApiError(body.message, { status: 409, payload: body });
			},
		});
		expect(await journeySetCancel({ id: "set-1", json: false, client })).not.toBe(EXIT.OK);
		expect(stderr).toContain("The set is not in a state that allows this.");
	});
});

describe("--watch: a set followed over the platform's live stream", () => {
	const run = (client: SetsClient) =>
		journeySetRun({
			goals: ["Find the API docs", "Find the pricing"],
			flags: { domain: "linear.app", levels: false },
			yes: true,
			watch: true,
			json: false,
			client,
			sleep: async () => {},
		});

	it("prints what moves as the platform sends it, reads nothing in between, and reports the set it ended on", async () => {
		const { client, calls } = fakeClient({
			follow: async (_id, onSet) => {
				onSet(RUNNING);
				onSet(COMPLETE);
			},
		});
		expect(await run(client)).toBe(EXIT.OK);
		expect(calls.map((call) => call.op)).not.toContain("get");
		expect(stderr).toContain(
			`${RUNNING.state}: ${RUNNING.runs.started} of ${RUNNING.runs.planned} runs started`,
		);
		expect(stdout).toContain(`set ${COMPLETE.setId}`);
	});

	it("reads the set instead, and says so, when the live stream cannot be opened", async () => {
		const { client, calls } = fakeClient();
		expect(await run(client)).toBe(EXIT.OK);
		expect(calls.map((call) => call.op)).toEqual(expect.arrayContaining(["follow", "get"]));
		expect(stderr).toContain("Live updates are not available right now");
		expect(stdout).toContain(`set ${COMPLETE.setId}`);
	});

	it("goes on reading when the stream closes before the set is over", async () => {
		const { client, calls } = fakeClient({ follow: async (_id, onSet) => onSet(RUNNING) });
		expect(await run(client)).toBe(EXIT.OK);
		expect(calls.map((call) => call.op)).toContain("get");
	});
});

describe("progressLines", () => {
	it("says the state once, and a cell only when its counts moved", () => {
		const first = progressLines(null, RUNNING);
		expect(first[0]).toBe(
			`${RUNNING.state}: ${RUNNING.runs.started} of ${RUNNING.runs.planned} runs started`,
		);
		// The same document again: nothing moved, nothing is said.
		expect(progressLines(RUNNING, RUNNING)).toEqual([]);
		// One cell gains a graded run: that cell's line alone, with its level's label and its agent.
		const [cell] = RUNNING.cells;
		if (!cell) throw new Error("the running fixture has no cell");
		const moved = {
			...RUNNING,
			cells: [
				{ ...cell, graded: cell.graded + 1, passed: (cell.passed ?? 0) + 1 },
				...RUNNING.cells.slice(1),
			],
		};
		const lines = progressLines(RUNNING, moved);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(cell.agent);
		expect(lines[0]).toContain(`${(cell.passed ?? 0) + 1} of ${cell.graded + 1} graded`);
	});
});

describe("with no credential at all", () => {
	// A store of its own, empty, and no key in the environment: whatever this machine holds never reaches the test.
	const none = () =>
		platformCredentials({
			store: new SessionStore(mkdtempSync(join(tmpdir(), "ax-sets-"))),
			env: {},
		});

	it("a set command is a usage error that names both ways in and the scopes a set needs, before any call", async () => {
		expect(await journeySetList({ json: false, credentials: none() })).toBe(EXIT.USAGE);
		expect(stderr).toContain("ax login");
		expect(stderr).toContain("ORA_API_KEY");
		expect(stderr).toContain("ax.sets:read + ax.sets:write");
	});

	it("so is starting a set: nothing is previewed", async () => {
		const exit = await journeySetRun({
			goals: ["Find the API docs", "Find the pricing"],
			flags: { domain: "linear.app", levels: false },
			yes: true,
			json: true,
			credentials: none(),
		});
		expect(exit).toBe(EXIT.USAGE);
		expect(JSON.parse(stdout)).toMatchObject({ error: { code: "MISSING_API_KEY" } });
	});
});
