import { runCommand } from "citty";
import { afterEach, expect, it, vi } from "vitest";
import { deepJourneyCommand } from "./deep-journey";
import { journeyCommand } from "./journey";
import { journey, run } from "./journey-cli";
import { journeySetRun } from "./journey-set";

vi.mock("./deep-journey", () => ({ deepJourneyCommand: vi.fn(async () => 0) }));
vi.mock("./journey", () => ({ journeyCommand: vi.fn(async () => 0) }));
vi.mock("./journey-set", () => ({ journeySetRun: vi.fn(async () => 0) }));
const savedExit = process.exitCode;
afterEach(() => {
	process.exitCode = savedExit;
	vi.clearAllMocks();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("keeps the public JSON error code when the domain is missing", async () => {
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	vi.spyOn(console, "error").mockImplementation(() => {});
	await runCommand(journey, { rawArgs: ["--json"] });
	expect(process.exitCode).toBe(2);
	expect(JSON.parse(String(stdout.mock.calls[0]?.[0])).error.code).toBe("INVALID_TARGET");
});

it("keeps a partner task public even when a Studio key is set", async () => {
	vi.stubEnv("ORA_API_KEY", "ora_sk_test");
	await runCommand(journey, {
		rawArgs: ["Find docs", "--domain=example.com", "--api-key", "partner", "--no-stream"],
	});
	expect(deepJourneyCommand).toHaveBeenCalledWith(
		expect.objectContaining({
			url: "example.com",
			task: "Find docs",
			apiKey: "partner",
			noStream: true,
		}),
	);
	expect(journeyCommand).not.toHaveBeenCalled();
});

it("runs one Studio goal even when a partner key is set", async () => {
	vi.stubEnv("ORA_PARTNER_API_KEY", "partner");
	await runCommand(run, { rawArgs: ["Find docs", "--harness", "codex", "--json"] });
	expect(journeyCommand).toHaveBeenCalledWith(
		expect.objectContaining({ intent: "Find docs", harness: "codex", json: true }),
	);
	expect(deepJourneyCommand).not.toHaveBeenCalled();
});

it("takes set goals and repeats through the explicit create command", async () => {
	await runCommand(run, {
		rawArgs: [
			"set",
			"create",
			"Find pricing",
			"Find docs",
			"--domain",
			"example.com",
			"--repeat",
			"2",
			"--yes",
		],
	});
	expect(journeySetRun).toHaveBeenCalledWith(
		expect.objectContaining({
			goals: ["Find pricing", "Find docs"],
			flags: expect.objectContaining({ domain: "example.com", repeat: "2" }),
			yes: true,
		}),
	);
	expect(journeyCommand).not.toHaveBeenCalled();
});

it.each([
	[journey, ["Find docs", "--domain", "example.com", "--harness", "codex"]],
	[run, ["Find docs", "--api-key", "partner"]],
	[run, ["set", "cancel", "id1", "id2"]],
])("rejects incompatible arguments before contacting either API", async (command, rawArgs) => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	await runCommand(command, { rawArgs });
	expect(process.exitCode).toBe(2);
	expect(deepJourneyCommand).not.toHaveBeenCalled();
	expect(journeyCommand).not.toHaveBeenCalled();
	expect(journeySetRun).not.toHaveBeenCalled();
});
