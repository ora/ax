import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "./audit";
import { skillCommand } from "./skill";

const unreachable = () =>
	vi.fn(async () => {
		throw new Error("getaddrinfo ENOTFOUND");
	});

const stdout = () =>
	vi
		.mocked(process.stdout.write)
		.mock.calls.map((c) => String(c[0]))
		.join("");

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("skillCommand Next lines after a failure", () => {
	it("--json keeps --json in the retry when the registry cannot be reached", async () => {
		vi.stubGlobal("fetch", unreachable());
		expect(await skillCommand({ install: false, json: true })).toBe(EXIT.API);
		expect(JSON.parse(stdout()).error).toMatchObject({
			code: "REGISTRY_UNREACHABLE",
			next: "ax skill --json",
		});
		expect(console.error).toHaveBeenLastCalledWith(
			"Next: ax skill --json  # retry; the registry may be briefly unreachable",
		);
	});

	it("--json keeps --json in the retry of a named skill", async () => {
		vi.stubGlobal("fetch", unreachable());
		expect(await skillCommand({ name: "ora", install: false, json: true })).toBe(EXIT.API);
		expect(JSON.parse(stdout()).error.next).toBe("ax skill ora --json");
	});

	it("--json keeps --json in the listing an unknown skill points at", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ skills: [{ name: "ora", url: "/.well-known/agent-skills/ora/SKILL.md" }] }),
			),
		);
		expect(await skillCommand({ name: "nope", install: false, json: true })).toBe(EXIT.USAGE);
		expect(JSON.parse(stdout()).error).toMatchObject({
			code: "UNKNOWN_SKILL",
			next: "ax skill --json",
		});
	});

	it("without --json the retry carries no --json and stdout stays empty", async () => {
		vi.stubGlobal("fetch", unreachable());
		expect(await skillCommand({ install: false, json: false })).toBe(EXIT.API);
		expect(process.stdout.write).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenLastCalledWith(
			"Next: ax skill  # retry; the registry may be briefly unreachable",
		);
	});
});
