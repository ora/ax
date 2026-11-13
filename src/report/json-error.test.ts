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
		reportError(ERROR, { json: false, display: "Audit failed: bad target" });
		expect(process.stdout.write).not.toHaveBeenCalled();
		expect(console.log).not.toHaveBeenCalled();
		expect(vi.mocked(console.error).mock.calls).toEqual([
			["Audit failed: bad target"],
			["Next: ax audit <domain>  # a public URL or domain"],
		]);
	});
});
