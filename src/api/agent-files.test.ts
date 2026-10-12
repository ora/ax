import { afterEach, describe, expect, it, vi } from "vitest";
import invalidDomain from "./__fixtures__/agent-files-invalid.json";
import realBundle from "./__fixtures__/agent-files-unscanned.json";
import {
	AgentFilesApiError,
	type AgentFilesBundle,
	fetchAgentFiles,
	isSafeAgentFilePath,
	normalizeDomainInput,
} from "./agent-files";

// Both fixtures are real responses from ora's GET /api/agent-files/{domain}.
const BUNDLE = realBundle as AgentFilesBundle;

function respond(body: unknown, status = 200) {
	const fetchMock = vi.fn().mockResolvedValue(
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchAgentFiles", () => {
	it("asks ora for the bare domain and returns the bundle untouched", async () => {
		const fetchMock = respond(BUNDLE);
		const bundle = await fetchAgentFiles("https://stripe.com/", { baseUrl: "https://ora.test/" });
		expect(fetchMock.mock.calls[0][0]).toBe("https://ora.test/api/agent-files/stripe.com");
		expect(bundle).toEqual(BUNDLE);
	});

	it("carries ora's status and error body on a refusal", async () => {
		respond(invalidDomain, 400);
		const error = await fetchAgentFiles("localhost", { baseUrl: "https://ora.test" }).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(AgentFilesApiError);
		expect(error.status).toBe(400);
		expect(error.message).toBe(invalidDomain.message);
		expect(error.payload).toEqual(invalidDomain);
	});

	it("refuses a bundle naming a path outside /.well-known/", async () => {
		const hostile = {
			...BUNDLE,
			files: [{ ...BUNDLE.files[0], path: "/.well-known/../../.bashrc" }],
		};
		respond(hostile);
		await expect(fetchAgentFiles("stripe.com", { baseUrl: "https://ora.test" })).rejects.toThrow(
			/will not write/,
		);
	});
});

describe("isSafeAgentFilePath", () => {
	it("accepts the well-known JSON files ora drafts", () => {
		for (const file of BUNDLE.files) expect(isSafeAgentFilePath(file.path)).toBe(true);
	});

	it("rejects traversal, nesting and other directories", () => {
		for (const path of [
			"/.well-known/../x.json",
			"/.well-known/a/b.json",
			"/etc/passwd",
			".well-known/ard.json",
			"/.well-known/ard.txt",
			"/.well-known/.json",
		]) {
			expect(isSafeAgentFilePath(path)).toBe(false);
		}
	});
});

describe("normalizeDomainInput", () => {
	it("strips a scheme and trailing slashes", () => {
		expect(normalizeDomainInput(" https://Example.com// ")).toBe("Example.com");
		expect(normalizeDomainInput("example.com")).toBe("example.com");
	});

	it("handles a long run of slashes in linear time", () => {
		const hostile = `${"/".repeat(200_000)}x`;
		const started = performance.now();
		expect(normalizeDomainInput(hostile)).toBe(hostile);
		expect(normalizeDomainInput(`a${"/".repeat(200_000)}`)).toBe("a");
		expect(performance.now() - started).toBeLessThan(1_000);
	});
});
