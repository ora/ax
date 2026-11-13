import { defineCommand, runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trialRunCommand, trialViewCommand } from "./trial";
import { trial } from "./trial-cli";
import { trialCancelCommand, trialListCommand } from "./trial-records";

// The four command functions are mocked: these tests pin how typed arguments map onto their
// inputs and that each exit code reaches process.exitCode. Arguments go through citty's own
// parser (runCommand), so the subcommand routing and the repeated flag are the real ones.
vi.mock("./trial", () => ({ trialRunCommand: vi.fn(), trialViewCommand: vi.fn() }));
vi.mock("./trial-records", () => ({ trialListCommand: vi.fn(), trialCancelCommand: vi.fn() }));

const runMock = vi.mocked(trialRunCommand);
const viewMock = vi.mocked(trialViewCommand);
const listMock = vi.mocked(trialListCommand);
const cancelMock = vi.mocked(trialCancelCommand);

const savedExitCode = process.exitCode;

beforeEach(() => {
	runMock.mockResolvedValue(0);
	viewMock.mockResolvedValue(0);
	listMock.mockReturnValue(0);
	cancelMock.mockResolvedValue(0);
});

afterEach(() => {
	vi.clearAllMocks();
	process.exitCode = savedExitCode;
});

const argv = (...rawArgs: string[]) => runCommand(trial, { rawArgs });

/** The input `trialRunCommand` was called with. */
const runInput = () => runMock.mock.calls[0][0];

describe("citty and a repeated flag", () => {
	it("keeps only the last value, which is why trial run collects --task itself", async () => {
		let seen: unknown;
		const probe = defineCommand({
			args: { task: { type: "string" } },
			run: ({ args }) => {
				seen = args.task;
			},
		});
		await runCommand(probe, { rawArgs: ["--task", "first", "--task", "second"] });
		expect(seen).toBe("second");
	});
});

describe("trial run", () => {
	it("passes every repeated --task, in the order typed", async () => {
		await argv("run", "linear.app", "--task", "one", "--task", "two words", "--task=three");
		expect(runInput()).toMatchObject({
			site: "linear.app",
			tasks: ["one", "two words", "three"],
		});
	});

	it("takes the next argument as the value even when it starts with a dash", async () => {
		await argv("run", "linear.app", "--task", "-x", "--task", "--yes");
		expect(runInput().tasks).toEqual(["-x", "--yes"]);
		expect(runInput().yes).toBe(false);
	});

	it("does not read the value of another flag as a task", async () => {
		await argv("run", "linear.app", "--brand", "--task", "--task", "real");
		expect(runInput()).toMatchObject({ brand: "--task", tasks: ["real"] });
	});

	it("stops collecting at --", async () => {
		await argv("run", "linear.app", "--task", "before", "--", "--task", "after");
		expect(runInput().tasks).toEqual(["before"]);
	});

	it("collects flags that come before the site", async () => {
		await argv("run", "--task", "a", "linear.app", "--task", "b");
		expect(runInput()).toMatchObject({ site: "linear.app", tasks: ["a", "b"] });
	});

	it("turns a --task with no value into an empty task for the spec check to refuse", async () => {
		await argv("run", "linear.app", "--task");
		expect(runInput().tasks).toEqual([""]);
	});

	it("passes no tasks when there is no --task, for the spec check to refuse", async () => {
		await argv("run", "linear.app");
		expect(runInput().tasks).toEqual([]);
	});

	it("passes --agents exactly as typed", async () => {
		await argv("run", "linear.app", "--task", "x", "--agents", "claude-code/opus, codex,codex");
		expect(runInput().agents).toBe("claude-code/opus, codex,codex");
	});

	it("passes the other values as typed and the booleans as booleans", async () => {
		await argv(
			...["run", "linear.app", "--task", "x", "--brand", "Linear", "--docs", "https://d.example"],
			...["--exact", "https://e.example", "--repeat", "3", "--wait", "15", "--yes", "--json"],
		);
		expect(runInput()).toEqual({
			site: "linear.app",
			tasks: ["x"],
			agents: undefined,
			brand: "Linear",
			docs: "https://d.example",
			exact: "https://e.example",
			repeat: "3",
			wait: "15",
			yes: true,
			json: true,
		});
	});

	it("leaves the optional values undefined and the booleans false when not typed", async () => {
		await argv("run", "linear.app", "--task", "x");
		expect(runInput()).toEqual({
			site: "linear.app",
			tasks: ["x"],
			agents: undefined,
			brand: undefined,
			docs: undefined,
			exact: undefined,
			repeat: undefined,
			wait: undefined,
			yes: false,
			json: false,
		});
	});

	it("passes no test seam to the command", async () => {
		await argv("run", "linear.app", "--task", "x", "--yes");
		for (const seam of ["trialsDir", "client", "now", "sleep", "ask"]) {
			expect(runInput()).not.toHaveProperty(seam);
		}
	});

	it.each([0, 2, 3, 130])("sets process.exitCode to the returned %i", async (code) => {
		runMock.mockResolvedValue(code);
		process.exitCode = undefined;
		await argv("run", "linear.app", "--task", "x");
		expect(process.exitCode).toBe(code);
	});
});

describe("trial view", () => {
	it("passes the id, --wait and --json", async () => {
		await argv("view", "t-0123456789", "--wait", "5", "--json");
		expect(viewMock).toHaveBeenCalledWith({ id: "t-0123456789", wait: "5", json: true });
	});

	it("leaves --wait undefined and --json false when not typed", async () => {
		await argv("view", "t-0123456789");
		expect(viewMock).toHaveBeenCalledWith({ id: "t-0123456789", wait: undefined, json: false });
	});

	it("sets process.exitCode to the returned code", async () => {
		viewMock.mockResolvedValue(130);
		process.exitCode = undefined;
		await argv("view", "t-0123456789");
		expect(process.exitCode).toBe(130);
	});
});

describe("trial list", () => {
	it("passes --json, and sets the exit code from its synchronous return", async () => {
		listMock.mockReturnValue(0);
		process.exitCode = 9;
		await argv("list", "--json");
		expect(listMock).toHaveBeenCalledWith({ json: true });
		expect(process.exitCode).toBe(0);
	});

	it("passes json false by default", async () => {
		await argv("list");
		expect(listMock).toHaveBeenCalledWith({ json: false });
	});
});

describe("trial cancel", () => {
	it("passes the id and --json", async () => {
		await argv("cancel", "t-0123456789", "--json");
		expect(cancelMock).toHaveBeenCalledWith({ id: "t-0123456789", json: true });
	});

	it("sets process.exitCode to the returned code", async () => {
		cancelMock.mockResolvedValue(3);
		process.exitCode = undefined;
		await argv("cancel", "t-0123456789");
		expect(process.exitCode).toBe(3);
	});
});
