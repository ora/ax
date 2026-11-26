import { afterEach, expect, it, vi } from "vitest";
import { cliFetch, withCliUsage } from "./cli-usage";

afterEach(() => vi.unstubAllEnvs());

it("leaves a library caller, an opted-out CLI and custom API destinations alone", () => {
	const request = vi.fn<typeof fetch>();
	expect(cliFetch("https://ora.ai", "agentFiles", request)).toBe(request);
	withCliUsage("1.2.3", ["generate-files", "customer.test"], () => {
		expect(cliFetch("https://ora.ai.example", "agentFiles", request)).toBe(request);
	});
	vi.stubEnv("DO_NOT_TRACK", "1");
	withCliUsage("1.2.3", ["generate-files", "customer.test"], () => {
		expect(cliFetch("https://ora.ai", "agentFiles", request)).toBe(request);
	});
});

it("marks the primary public request and strips the marker and credential on a cross-origin redirect", async () => {
	const remote = "https://elsewhere.test/draft";
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(Response.redirect(remote, 307))
		.mockResolvedValueOnce(new Response());
	await withCliUsage("1.2.3", ["generate-files", "customer.test"], () =>
		cliFetch(
			"https://ora.ai",
			"agentFiles",
			request,
		)("https://ora.ai/api/agent-files/customer.test?include=all", {
			headers: { authorization: "Bearer test" },
		}),
	);
	const [[first, init], [next, redirected]] = request.mock.calls;
	expect(first).toBe("https://ora.ai/api/agent-files/customer.test?include=all&cli=1");
	expect(new Headers(init?.headers).get("x-ora-cli")).toMatch(/ generate-files -$/);
	expect(next).toBe(remote);
	expect(new Headers(redirected?.headers).has("x-ora-cli")).toBe(false);
	expect(new Headers(redirected?.headers).has("authorization")).toBe(false);
});
