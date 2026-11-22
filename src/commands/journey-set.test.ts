import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformApiError } from "../api/platform";
import type { SetDocument, SetList, SetPreview, SetRequest, SetsClient } from "../api/sets";
import list from "../journey-set/__fixtures__/list.json";
import preview from "../journey-set/__fixtures__/preview.json";
import complete from "../journey-set/__fixtures__/set-complete.json";
import created from "../journey-set/__fixtures__/set-created.json";
import running from "../journey-set/__fixtures__/set-running.json";
import { EXIT } from "./audit";
import {
	INTERRUPTED,
	journeySetCancel,
	journeySetList,
	journeySetRun,
	journeySetView,
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

	it("a list the platform refuses with 401 points at the key", async () => {
		const refused = new PlatformApiError("ora rejected the API key (401).", {
			status: 401,
			payload: null,
		});
		const { client } = fakeClient({ list: () => Promise.reject(refused) });
		expect(await journeySetList({ json: false, client })).toBe(EXIT.USAGE);
		expect(stderr).toContain("ORA_API_KEY=<platform key>");
	});

	it("cancel asks the platform to stop the set and prints its answer unchanged under --json", async () => {
		const { client, calls } = fakeClient();
		expect(await journeySetCancel({ id: "set-1", json: true, client })).toBe(EXIT.OK);
		expect(calls).toEqual([{ op: "cancel", arg: "set-1" }]);
		expect(JSON.parse(stdout)).toEqual({ setId: "set-1", cancelled: true });
		expect(await journeySetCancel({ id: undefined, json: false, client })).toBe(EXIT.USAGE);
	});
});

describe("the key", () => {
	it("a set command with no ORA_API_KEY is a usage error that names it, before any call", async () => {
		vi.stubEnv("ORA_API_KEY", "");
		expect(await journeySetList({ json: false })).toBe(EXIT.USAGE);
		expect(stderr).toContain("ORA_API_KEY");
		vi.unstubAllEnvs();
	});
});
