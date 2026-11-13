import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import agentsFixture from "../api/__fixtures__/studio/agents.json";
import quota402 from "../api/__fixtures__/studio/error-402-quota.json";
import missingScope403 from "../api/__fixtures__/studio/error-403-missing-scope.json";
import created from "../api/__fixtures__/studio/journey-create.json";
import createdPartial from "../api/__fixtures__/studio/journey-create-partial.json";
import detailFinal from "../api/__fixtures__/studio/journey-detail-final.json";
import detailRunning from "../api/__fixtures__/studio/journey-detail-running.json";
import trajectory from "../api/__fixtures__/studio/trajectory.json";
import usageFixture from "../api/__fixtures__/studio/usage.json";
import { createStudioClient } from "../api/studio";
import { STUDIO_SCOPES } from "../api/studio-types";
import { listRecords, readRecord, type TrialRecord } from "../trial/record";
import { confirmPrompt, GET_A_KEY, PRODUCT_NOT_GRANTED_MESSAGE } from "../trial/render-preview";
import { NEED_LEVEL_NOTE } from "../trial/render-report";
import { parseTrialSpec } from "../trial/spec";
import { EXIT } from "./audit";
import {
	type TrialRunInput,
	type TrialViewInput,
	trialRunCommand,
	trialViewCommand,
} from "./trial";

// Every case drives the command through a real createStudioClient over a mocked fetch that answers
// from src/api/__fixtures__/studio/ (provenance in src/api/studio.test.ts), the key exchange
// included, and writes real records to a temp dir. The clock and the sleep are injected, so no
// case waits. Bodies with no fixture file are the named deltas below.

const BASE = "https://platform.test";
const KEY = "ora_sk_local";
const SITE = "linear.app";
/** Names neither the domain nor the brand, so the need level runs: 2 levels x 2 agents, 4 runs. */
const TASK = "Find how to create an issue from the API";
/** The two agents agents.json offers, the pair journey-create.json answers for. */
const AGENTS = "claude-code/claude-haiku-4-5-20251001,claude-code/claude-sonnet-5-5";
const RUN_CALL = `ax trial run linear.app --task '${TASK}' --agents ${AGENTS}`;
const JOURNEY = created.data.journeyId;

const asJson = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A token shaped like the key exchange mints for an ora_sk_ key, as studio.test.ts builds it. */
function jwt(claims: Record<string, unknown>): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return [part({ alg: "RS256", typ: "JWT" }), part(claims), "signature"].join(".");
}

type Reply = () => Response | Promise<Response>;

const grantOf =
	(scopes: readonly string[]): Reply =>
	() =>
		asJson({ token: jwt({ type: "api_key", sub: "key:k1", scopes }), expiresIn: 900 });

/** The nth create of a trial: journey-create.json with its journey and run ids made unique. */
function createdN(n: number) {
	const runIds = created.data.runIds.map((id) => `${id}-${n}`);
	return { ...created, data: { ...created.data, journeyId: `${JOURNEY}-${n}`, runIds } };
}

/** A read of one of those journeys: the detail fixture under that create's ids. */
function readOf<D extends { data: { agents: { runId: string }[] } }>(detail: D, id: string) {
	const suffix = id.slice(JOURNEY.length);
	const agents = detail.data.agents.map((run) => ({ ...run, runId: `${run.runId}${suffix}` }));
	return asJson({ ...detail, data: { ...detail.data, id, agents } });
}

const ok =
	(n: number): Reply =>
	() =>
		asJson(createdN(n), 201);
// Studio's own 502 on create, nothing started: launch.test.ts's delta on journey-create-partial.json.
const NONE_STARTED_502 = {
	...createdPartial,
	success: false,
	data: {
		...createdPartial.data,
		runIds: [],
		streamUrls: [],
		failed: [
			{ ...createdPartial.data.failed[0], model: "claude-haiku-4-5-20251001" },
			createdPartial.data.failed[0],
		],
	},
};
const studio502: Reply = () => asJson(NONE_STARTED_502, 502);
const gateway502: Reply = () => new Response("<html>bad gateway</html>", { status: 502 });
const quota: Reply = () => asJson(quota402, 402);
// A plain Studio error body, and the 403 with its code swapped, as trial-records.test.ts has them.
const SERVER_500 = { error: "boom", code: "internal" };
const PRODUCT_403 = { error: "Forbidden", code: "PRODUCT_NOT_GRANTED" };

interface Platform {
	/** The key exchange; a token with every scope a trial needs by default. */
	grant?: Reply;
	agents?: Reply;
	usage?: Reply;
	/** One reply per create, in turn; by default the nth create answers createdN(n). */
	creates?: Reply[];
	/** The nth read (from 1) of one journey; the final detail by default. */
	journey?: (id: string, n: number) => Response;
	/** Every run's trajectory read; the recorded trajectory by default. */
	trajectory?: Reply;
}

function platform(script: Platform = {}) {
	const calls: string[] = [];
	const creates: Array<Record<string, unknown>> = [];
	const reads = new Map<string, number>();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init: RequestInit = {}) => {
			const method = init.method ?? "GET";
			const path = String(url).slice(BASE.length).split("?")[0];
			calls.push(`${method} ${path}`);
			if (path === "/auth/token") return (script.grant ?? grantOf(STUDIO_SCOPES))();
			if (path === "/studio/v1/agents") return (script.agents ?? (() => asJson(agentsFixture)))();
			if (path === "/studio/v1/usage") return (script.usage ?? (() => asJson(usageFixture)))();
			if (method === "POST" && path === "/studio/v1/journeys") {
				creates.push(JSON.parse(String(init.body)));
				const n = creates.length;
				const reply = script.creates ? script.creates[n - 1] : ok(n);
				if (!reply) throw new Error(`create ${n} is past the script`);
				return reply();
			}
			const journey = /^\/studio\/v1\/journeys\/([^/]+)$/.exec(path);
			if (journey) {
				const id = decodeURIComponent(journey[1]);
				const n = (reads.get(id) ?? 0) + 1;
				reads.set(id, n);
				return (script.journey ?? ((at: string) => readOf(detailFinal, at)))(id, n);
			}
			if (/^\/studio\/v1\/runs\/[^/]+\/trajectory$/.test(path)) {
				return (script.trajectory ?? (() => asJson(trajectory)))();
			}
			throw new Error(`unrouted ${method} ${path}`);
		}),
	);
	const journeyReads = () => calls.filter((call) => call.startsWith("GET /studio/v1/journeys/"));
	return { calls, creates, journeyReads };
}

const client = () => createStudioClient({ apiKey: KEY, baseUrl: BASE });
let clock = 0;
const now = () => clock;
const sleep = async (ms: number) => {
	clock += ms;
};

let dir: string;
let listeners: number;
const tty = {
	stdin: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
	stderr: Object.getOwnPropertyDescriptor(process.stderr, "isTTY"),
};

function setTerminal(value: boolean) {
	Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
	Object.defineProperty(process.stderr, "isTTY", { value, configurable: true });
}

function restore(stream: NodeJS.ReadStream | NodeJS.WriteStream, prior?: PropertyDescriptor) {
	if (prior) Object.defineProperty(stream, "isTTY", prior);
	else Reflect.deleteProperty(stream, "isTTY");
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ax-trial-"));
	clock = Date.parse("2026-11-13T14:00:00.000Z");
	listeners = process.listenerCount("SIGINT");
	setTerminal(false);
	vi.stubEnv("ORA_API_KEY", KEY);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	expect(process.listenerCount("SIGINT")).toBe(listeners);
	process.exitCode = undefined;
	restore(process.stdin, tty.stdin);
	restore(process.stderr, tty.stderr);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the color codes picocolors may add
const COLOR = /\u001b\[[0-9;]*m/g;
const text = (calls: unknown[][]) => calls.map((call) => String(call[0]).replace(COLOR, ""));
/** One entry per printed line: a message of several lines is printed as one call. */
const printed = (calls: unknown[][]) => text(calls).flatMap((call) => call.split("\n"));
/** stdout as written: console.log lines, then raw writes (the --json document). */
const stdout = () => [
	...printed(vi.mocked(console.log).mock.calls),
	...text(vi.mocked(process.stdout.write).mock.calls),
];
/** stderr as written: console.error lines, then raw writes (the live status line). */
const stderr = () => [
	...printed(vi.mocked(console.error).mock.calls),
	...text(vi.mocked(process.stderr.write).mock.calls),
];
/** The one --json document; fails when anything else reached stdout. */
function jsonDocument(): Record<string, unknown> {
	expect(console.log).not.toHaveBeenCalled();
	expect(process.stdout.write).toHaveBeenCalledTimes(1);
	return JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0][0]));
}

const nextLine = (call: string, why: string) => `Next: ${call}  # ${why}`;
const keyed = (call: string) =>
	nextLine(`ORA_API_KEY=<Front API key> ${call}`, "a Front API key with the scopes a trial needs");
const viewLine = (id: string, json = "") =>
	nextLine(`ax trial view ${id}${json}`, "picks the trial up and prints its report");
const cancelLine = (id: string) => nextLine(`ax trial cancel ${id}`, "stops the runs that started");
const auditLine = (json = "") =>
	nextLine(
		`ax audit linear.app${json}`,
		"the readiness audit: which checks explain what the agents hit",
	);

const run = (input: Partial<TrialRunInput> = {}) =>
	trialRunCommand({
		...{ site: SITE, tasks: [TASK], agents: AGENTS, yes: true, json: false },
		...{ trialsDir: dir, client, now, sleep },
		...input,
	});
const view = (id: string, input: Partial<TrialViewInput> = {}) =>
	trialViewCommand({ id, json: false, trialsDir: dir, client, now, sleep, ...input });

async function exits(command: Promise<number>, code: number) {
	expect(await command).toBe(code);
}

/** The one record the run wrote, read back from disk. */
function theRecord(): TrialRecord {
	const { records } = listRecords(dir);
	expect(records).toHaveLength(1);
	const record = readRecord(records[0].id, dir);
	if (!record) throw new Error("the record is gone");
	return record;
}

const noRecord = () => expect(listRecords(dir)).toEqual({ records: [], skipped: [] });

describe("ax trial run, before anything launches", () => {
	it("refuses a spec with no task, exit 2, before any call", async () => {
		const mock = platform();
		const parsed = parseTrialSpec({ site: SITE, tasks: [] });
		if (parsed.ok) throw new Error("an empty task list parsed");

		await exits(run({ tasks: [] }), EXIT.USAGE);

		expect(mock.calls).toEqual([]);
		expect(stdout()).toEqual([]);
		expect(stderr()).toEqual([
			parsed.error,
			nextLine("ax trial run <site> --task <task>", "with the value named above fixed"),
		]);
	});

	it("without ORA_API_KEY prints the key copy and the same call keyed, exit 2", async () => {
		const mock = platform();
		vi.stubEnv("ORA_API_KEY", "");

		await exits(run(), EXIT.USAGE);

		expect(mock.calls).toEqual([]);
		expect(stdout()).toEqual([]);
		expect(stderr()).toEqual([GET_A_KEY, keyed(`${RUN_CALL} --yes`)]);
	});

	it("refuses a key whose token lacks scopes without reading the catalog, exit 2", async () => {
		const mock = platform({ grant: grantOf(["journeys:read", "runs:read", "intents:read"]) });

		await exits(run(), EXIT.USAGE);

		expect(mock.calls).toEqual(["POST /auth/token"]);
		expect(stdout()).toEqual([]);
		expect(stderr()).toEqual([
			"Your API key is missing these scopes: journeys:write, runs:write.",
			GET_A_KEY,
			keyed(`${RUN_CALL} --yes`),
		]);
		noRecord();
	});

	it("names the scope a 403 on the catalog read says is missing, exit 2", async () => {
		platform({ agents: () => asJson(missingScope403, 403) });

		await exits(run(), EXIT.USAGE);

		expect(stderr()).toEqual([
			"Your API key is missing these scopes: journeys:write.",
			GET_A_KEY,
			keyed(`${RUN_CALL} --yes`),
		]);
		noRecord();
	});

	it("passes a PRODUCT_NOT_GRANTED body through under --json, exit 2", async () => {
		platform({ agents: () => asJson(PRODUCT_403, 403) });

		await exits(run({ json: true }), EXIT.USAGE);

		expect(jsonDocument()).toEqual(PRODUCT_403);
		expect(stderr()).toEqual([PRODUCT_NOT_GRANTED_MESSAGE, keyed(`${RUN_CALL} --yes --json`)]);
	});

	it("a 500 on the usage read exits 3 with the same call to retry", async () => {
		platform({ usage: () => asJson(SERVER_500, 500) });

		await exits(run(), EXIT.API);

		expect(stdout()).toEqual([]);
		expect(stderr()).toEqual([
			"ora request failed (500 internal): boom",
			nextLine(`${RUN_CALL} --yes`, "retry"),
		]);
		noRecord();
	});

	it("a key exchange that cannot connect exits 3 with the envelope under --json", async () => {
		platform({
			grant: () => {
				throw new TypeError("fetch failed");
			},
		});

		await exits(run({ json: true }), EXIT.API);

		const message = "could not reach ora at https://platform.test: fetch failed";
		const call = `${RUN_CALL} --yes --json`;
		expect(jsonDocument()).toEqual({ error: { code: "API_UNREACHABLE", message, next: call } });
		expect(stderr()).toEqual([message, nextLine(call, "retry")]);
		noRecord();
	});

	it("a key the exchange rejects exits 3 and names the key", async () => {
		platform({ grant: () => asJson({}, 401) });

		await exits(run(), EXIT.API);

		expect(stderr()).toEqual([
			"ora rejected the API key (401). Check ORA_API_KEY.",
			keyed(`${RUN_CALL} --yes`),
		]);
	});

	it("over the allowance, the Next line carries the repeat that fits, exit 2", async () => {
		const mock = platform();

		await exits(run({ repeat: "10" }), EXIT.USAGE);

		expect(stderr()).toEqual([
			"This trial needs 40 runs and your plan has 38 runs left this month (resets Dec 1).",
			"9 repeats fit: 36 runs. Try --repeat 9.",
			nextLine(
				`${RUN_CALL} --repeat 9 --yes`,
				"the largest repeat that fits what your plan has left",
			),
		]);
		expect(mock.creates).toEqual([]);
		noRecord();
	});

	it("with no terminal and no --yes, prints the preview and refuses, exit 2", async () => {
		const mock = platform();

		await exits(run({ yes: false }), EXIT.USAGE);

		const lines = stderr();
		expect(lines[0]).toBe("This trial uses 4 runs (1 task x 2 levels x 2 agents x 1 repeat).");
		expect(lines).toContain("Your plan has 38 runs left this month (resets Dec 1).");
		expect(lines.slice(-2)).toEqual([
			"There is no terminal to confirm the launch in. Nothing was launched.",
			nextLine(`${RUN_CALL} --yes`, "launches without asking"),
		]);
		expect(stdout()).toEqual([]);
		expect(mock.creates).toEqual([]);
		noRecord();
	});

	it("a no at the prompt launches nothing and writes no record, exit 0", async () => {
		const mock = platform();
		setTerminal(true);
		const ask = vi.fn(async () => "n");

		await exits(run({ yes: false, ask }), EXIT.OK);

		expect(ask).toHaveBeenCalledWith(confirmPrompt(4));
		expect(stderr().slice(-2)).toEqual([
			"Nothing was launched.",
			nextLine(RUN_CALL, "the same trial, when you want to launch it"),
		]);
		expect(stdout()).toEqual([]);
		expect(mock.creates).toEqual([]);
		noRecord();
	});

	it("Ctrl-C at the prompt launches nothing, exit 130", async () => {
		const mock = platform();
		setTerminal(true);

		await exits(run({ yes: false, ask: async () => null }), 130);

		expect(stderr().slice(-2)[0]).toBe("Nothing was launched.");
		expect(mock.creates).toEqual([]);
		noRecord();
	});
});

describe("ax trial run, launched", () => {
	it("writes the record, launches, follows and prints the report, exit 0", async () => {
		let recordsAtFirstCreate: unknown;
		const mock = platform({
			creates: [
				() => {
					recordsAtFirstCreate = listRecords(dir).records.length;
					return ok(1)();
				},
				ok(2),
			],
		});
		setTerminal(true);

		await exits(run({ yes: false, ask: async () => "y" }), EXIT.OK);

		expect(recordsAtFirstCreate).toBe(1);
		const record = theRecord();
		expect(record.journeys.map((journey) => journey.journeyId)).toEqual([
			`${JOURNEY}-1`,
			`${JOURNEY}-2`,
		]);
		expect(mock.creates.map((body) => body.goal)).toEqual([TASK, `${TASK}. Use Linear.`]);
		expect(mock.creates[0]).toMatchObject({ targetDomain: SITE });

		const out = stdout();
		expect(out[0]).toContain(`linear.app  trial ${record.id}`);
		expect(out).toContain(NEED_LEVEL_NOTE);
		expect(out.join("\n")).not.toContain("This report is not complete");
		expect(out.at(-1)).toBe(auditLine());

		const err = stderr();
		expect(err).toContain(
			`You can close the terminal; \`ax trial view ${record.id}\` picks it up.`,
		);
		expect(err.join("")).toContain("2 of 2 journeys created");
		expect(err.join("")).toContain("0 queued, 0 running, 4 finished");
	});

	it("says on stderr when steps could not be read, since those runs carry no flags", async () => {
		platform({ trajectory: () => asJson(SERVER_500, 500) });

		await exits(run(), EXIT.OK);

		expect(stderr()).toContain(
			"The steps of 4 runs could not be read, so the report does not flag them as blocked or never visited.",
		);
		expect(stdout().at(-1)).toBe(auditLine());
	});

	it("under --json, stdout carries the one report document", async () => {
		platform();

		await exits(run({ json: true }), EXIT.OK);

		const record = theRecord();
		const document = jsonDocument();
		expect(document).toMatchObject({ trialId: record.id, site: SITE, complete: true });
		expect(document.ended).toBe("settled");
		expect(stderr().at(-1)).toBe(auditLine(" --json"));
	});

	it("after a 402 mid-launch, follows what started and reports it incomplete, exit 0", async () => {
		platform({ creates: [ok(1), quota] });

		await exits(run({ json: true }), EXIT.OK);

		expect(jsonDocument()).toMatchObject({
			complete: false,
			stoppedReason: "quota",
			notLaunched: 2,
		});
		const err = stderr();
		expect(err).toContain(
			"Your plan's run limit was reached, so launching stopped. 2 runs were not launched.",
		);
		expect(err).toContain("Following the 2 runs that started.");
		expect(err.at(-1)).toBe(auditLine(" --json"));
	});

	it("a gateway 502 stops launching: exit 3, the view and cancel lines, no following", async () => {
		const mock = platform({ creates: [ok(1), gateway502] });

		await exits(run(), EXIT.API);

		const { id } = theRecord();
		expect(mock.journeyReads()).toEqual([]);
		expect(stdout()).toEqual([]);
		expect(stderr().slice(-4)).toEqual([
			"The platform is likely down, so launching stopped. Runs that started keep running.",
			"The last journey may have started its runs anyway; they will show in your account's journeys list.",
			viewLine(id),
			cancelLine(id),
		]);
	});

	it("three Studio 502s in a row stop launching with only the view line, exit 3", async () => {
		const mock = platform({ creates: [studio502, studio502, studio502] });

		await exits(run({ repeat: "2" }), EXIT.API);

		const record = theRecord();
		expect(record.stoppedReason).toBe("platform_down");
		expect(mock.journeyReads()).toEqual([]);
		expect(stderr().slice(-2)).toEqual([
			"The platform is likely down, so launching stopped. Runs that started keep running.",
			viewLine(record.id),
		]);
	});

	it("an error answer stops launching: exit 3, the error quoted, view and cancel", async () => {
		const mock = platform({ creates: [ok(1), () => asJson(SERVER_500, 500)] });

		await exits(run(), EXIT.API);

		const { id } = theRecord();
		expect(mock.journeyReads()).toEqual([]);
		expect(stderr().slice(-4)).toEqual([
			"The platform answered with an error, so launching stopped: ora request failed (500 internal): boom",
			"2 runs were not launched. Runs that started keep running.",
			viewLine(id),
			cancelLine(id),
		]);
	});

	it("Ctrl-C while launching: exit 130 with the view and cancel lines", async () => {
		const mock = platform({
			creates: [
				() => {
					process.emit("SIGINT");
					return ok(1)();
				},
			],
		});

		await exits(run(), 130);

		const record = theRecord();
		expect(record.stoppedReason).toBe("interrupted");
		expect(mock.journeyReads()).toEqual([]);
		expect(stdout()).toEqual([]);
		expect(stderr().slice(-3)).toEqual([
			"Launching stopped. 2 runs were not launched. Runs that started keep running.",
			viewLine(record.id),
			cancelLine(record.id),
		]);
	});
});

describe("ax trial run, following", () => {
	it("Ctrl-C while following: exit 130, the view line, no report", async () => {
		const mock = platform({
			journey: (id) => {
				process.emit("SIGINT");
				return readOf(detailRunning, id);
			},
		});

		await exits(run(), 130);

		const { id } = theRecord();
		expect(mock.calls.some((call) => call.endsWith("/trajectory"))).toBe(false);
		expect(stdout()).toEqual([]);
		expect(stderr().slice(-2)).toEqual([
			"Stopped following. Runs that started keep running.",
			viewLine(id),
		]);
	});

	it("Ctrl-C in the round that settles every journey still prints the report, exit 0", async () => {
		platform({
			journey: (id) => {
				if (id.endsWith("-2")) process.emit("SIGINT");
				return readOf(detailFinal, id);
			},
		});

		await exits(run(), EXIT.OK);

		expect(stdout().join("\n")).not.toContain("This report is not complete");
		expect(stdout().at(-1)).toBe(auditLine());
	});

	it("the wait limit ends following: the report says so, Next is view, exit 0", async () => {
		platform({ journey: (id) => readOf(detailRunning, id) });

		await exits(run({ wait: "1" }), EXIT.OK);

		const { id } = theRecord();
		const out = stdout();
		expect(out).toContain(
			"This report is not complete: the wait limit ran out with 4 runs still going.",
		);
		expect(out.at(-1)).toBe(viewLine(id));
		expect(stderr().join("")).toContain("2 queued, 2 running, 0 finished");
	});

	it("reads failing after a good round: the last error, then the report, exit 0", async () => {
		platform({
			journey: (id, n) => (n === 1 ? readOf(detailRunning, id) : asJson(SERVER_500, 500)),
		});

		await exits(run(), EXIT.OK);

		const { id } = theRecord();
		expect(stderr()).toContain("Reading from the platform kept failing.");
		expect(stderr()).toContain("The last error: ora request failed (500 internal): boom");
		const out = stdout();
		expect(out).toContain(
			"This report is not complete: the platform could not be read, so some runs may be missing.",
		);
		expect(out.at(-1)).toBe(viewLine(id));
	});

	it("reads failing from the first round: exit 3 with the view line and no report", async () => {
		platform({ journey: () => asJson(SERVER_500, 500) });

		await exits(run({ json: true }), EXIT.API);

		const { id } = theRecord();
		const message = [
			"Reading from the platform kept failing.",
			"The last error: ora request failed (500 internal): boom",
		].join("\n");
		const call = `ax trial view ${id} --json`;
		expect(jsonDocument()).toEqual({ error: { code: "internal", message, next: call } });
		expect(stderr().slice(-3)).toEqual([...message.split("\n"), viewLine(id, " --json")]);
	});
});

describe("ax trial view", () => {
	it("picks a recorded trial up and prints the same document the run printed, exit 0", async () => {
		platform();
		await run({ json: true });
		const fromRun = jsonDocument();
		vi.mocked(process.stdout.write).mockClear();
		vi.mocked(console.error).mockClear();
		const mock = platform();

		await exits(view(String(fromRun.trialId), { json: true }), EXIT.OK);

		expect(jsonDocument()).toEqual(fromRun);
		expect(mock.creates).toEqual([]);
		expect(stderr().at(-1)).toBe(auditLine(" --json"));
	});

	it("refuses an id that is not a trial id without reading anything, exit 2", async () => {
		const mock = platform();

		await exits(view("../etc/passwd"), EXIT.USAGE);

		expect(mock.calls).toEqual([]);
		expect(stderr()).toEqual([
			'"../etc/passwd" is not a trial id. Ids look like t-0123456789.',
			nextLine("ax trial list", "see the trials recorded on this machine"),
		]);
	});

	it("refuses an id with no record on this machine, exit 2", async () => {
		platform();

		await exits(view("t-0000000000", { json: true }), EXIT.USAGE);

		const message = "No trial t-0000000000 on this machine.";
		expect(jsonDocument()).toEqual({
			error: { code: "UNKNOWN_TRIAL", message, next: "ax trial list" },
		});
		expect(stderr()[0]).toBe(message);
	});

	it("names a damaged record and where it is, exit 2", async () => {
		platform();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "t-abcdef0123.json"), "{ not json");

		await exits(view("t-abcdef0123"), EXIT.USAGE);

		const where = join(dir, "t-abcdef0123.json");
		expect(stderr()[0]).toBe(
			`The record t-abcdef0123.json is damaged, so ax cannot read it. It is at ${where}.`,
		);
	});

	it("refuses a --wait that is not a whole number of minutes, exit 2", async () => {
		platform();
		await run();
		const { id } = theRecord();
		vi.mocked(console.error).mockClear();

		await exits(view(id, { wait: "soon" }), EXIT.USAGE);

		expect(stderr().at(-1)).toBe(
			nextLine(`ax trial view ${id} --wait <minutes>`, "a whole number of minutes"),
		);
	});

	it("without ORA_API_KEY prints the key copy and the view call keyed, exit 2", async () => {
		platform();
		await run();
		const { id } = theRecord();
		vi.mocked(console.error).mockClear();
		vi.stubEnv("ORA_API_KEY", "");

		await exits(view(id, { wait: "5" }), EXIT.USAGE);

		expect(stderr()).toEqual([GET_A_KEY, keyed(`ax trial view ${id} --wait 5`)]);
	});
});
