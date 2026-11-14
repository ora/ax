import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonErrorEnvelope, reportError } from "./json-error";

const ERROR = {
	code: "INVALID_TARGET",
	message: 'Not a scannable URL or domain: "not-a-domain"',
	next: { call: "ax audit <domain>", why: "a public URL or domain" },
};

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("jsonErrorEnvelope", () => {
	it("carries the code, the message, and the next call without its reason", () => {
		expect(jsonErrorEnvelope(ERROR)).toEqual({
			error: {
				code: "INVALID_TARGET",
				message: 'Not a scannable URL or domain: "not-a-domain"',
				next: "ax audit <domain>",
			},
		});
	});
});

describe("reportError", () => {
	it("under --json writes only the envelope to stdout and the notes to stderr", () => {
		reportError(ERROR, { json: true });
		expect(process.stdout.write).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0][0]))).toEqual(
			jsonErrorEnvelope(ERROR),
		);
		expect(console.log).not.toHaveBeenCalled();
		expect(vi.mocked(console.error).mock.calls).toEqual([
			['Not a scannable URL or domain: "not-a-domain"'],
			["Next: ax audit <domain>  # a public URL or domain"],
		]);
	});

	it("without --json writes nothing to stdout", () => {
		reportError(ERROR, { json: false, display: () => "Audit failed: bad target" });
		expect(process.stdout.write).not.toHaveBeenCalled();
		expect(console.log).not.toHaveBeenCalled();
		expect(vi.mocked(console.error).mock.calls).toEqual([
			["Audit failed: bad target"],
			["Next: ax audit <domain>  # a public URL or domain"],
		]);
	});

	it("under --json passes a served error body through unchanged instead of the envelope", () => {
		const served = {
			error: "invalid_domain",
			message: "not a public domain",
			next_action: { call: "ax audit <domain>" },
		};
		reportError(ERROR, { json: true, served });
		expect(process.stdout.write).toHaveBeenCalledTimes(1);
		expect(process.stdout.write).toHaveBeenCalledWith(`${JSON.stringify(served, null, 2)}\n`);
		expect(console.log).not.toHaveBeenCalled();
		expect(vi.mocked(console.error).mock.calls).toEqual([
			['Not a scannable URL or domain: "not-a-domain"'],
			["Next: ax audit <domain>  # a public URL or domain"],
		]);
	});

	it("under --json falls back to the envelope when the served body is null", () => {
		reportError(ERROR, { json: true, served: null });
		expect(JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0][0]))).toEqual(
			jsonErrorEnvelope(ERROR),
		);
	});

	it("without --json ignores a served body", () => {
		reportError(ERROR, { json: false, served: { error: "invalid_domain" } });
		expect(process.stdout.write).not.toHaveBeenCalled();
	});

	// A message can carry text the server wrote. On a terminal, an escape sequence in it would
	// run (clear the screen, set the clipboard) instead of being read.
	it("drops terminal control bytes from the message and keeps its line breaks", () => {
		const message = "bad\u001b]52;c;cGF5bG9hZA==\u0007 target\r\n  second line";
		reportError({ ...ERROR, message }, { json: false });
		const printed = String(vi.mocked(console.error).mock.calls[0][0]);
		for (const control of ["\u001b", "\u0007", "\r"]) expect(printed).not.toContain(control);
		expect(printed).toContain("\n  second line");
	});

	it("hands display the cleaned message, so the caller's colour survives and the server's does not", () => {
		const message = "bad\u001b[2J target";
		reportError(
			{ ...ERROR, message },
			{ json: false, display: (m) => `\u001b[31mfailed: ${m}\u001b[39m` },
		);
		const printed = String(vi.mocked(console.error).mock.calls[0][0]);
		expect(printed.startsWith("\u001b[31mfailed: bad")).toBe(true);
		expect(printed.endsWith("\u001b[39m")).toBe(true);
		expect(printed).not.toContain("\u001b[2J");
	});
});
