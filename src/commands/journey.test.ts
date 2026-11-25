import { afterEach, describe, expect, it, vi } from "vitest";
import { journeyCommand, viewRun } from "./journey";

const goal = "Find the API endpoint for creating an issue";
const input = { intent: goal, harness: "codex", json: true };
const reportUrl = "https://app.ora.ai/review/evaluations/runs/run-one";
const created = {
	runId: "run-one",
	goal,
	site: null,
	harness: "codex",
	model: "gpt-5.4-mini",
	state: "pending",
	createdAt: "2026-11-24T12:00:00Z",
	reportUrl,
};
const evidence = {
	...created,
	state: "succeeded",
	outcome: "success",
	totalTokens: 731,
	costUsd: 0,
	numTurns: 2,
	durationMs: 3000,
	insight: { intent_satisfied: true, summary: "Found the endpoint." },
	trajectory: { steps: [{ id: 0, type: "text", kind: "output", turn: 1, text: "See the docs." }] },
};

function server(refusal?: { status: number; body: { code: string; message: string } }) {
	vi.stubEnv("ORA_PLATFORM_URL", "http://localhost:29123");
	vi.stubEnv("ORA_API_KEY", "ora_sk_local_test");
	const requests: { method: string; path: string; body?: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const path = new URL(url).pathname;
			requests.push({
				path,
				method: init.method ?? "GET",
				body: init.body && JSON.parse(String(init.body)),
			});
			if (path === "/auth/token") return Response.json({ token: "bearer-for-ax" });
			expect(new Headers(init.headers).get("authorization")).toBe("Bearer bearer-for-ax");
			switch (path) {
				case "/ax/v1/runs":
					if (refusal) return Response.json(refusal.body, { status: refusal.status });
					return Response.json(created, { status: 201 });
				case "/ax/v1/sets/run-one":
					return Response.json({ code: "SET_NOT_FOUND" }, { status: 404 });
				case "/ax/v1/runs/run-one/stream":
					return new Response(
						`event: trajectory\ndata: ${JSON.stringify(evidence.trajectory)}\n\n`,
					);
				case "/ax/v1/runs/run-one":
					return Response.json(evidence);
				default:
					throw new Error(`unexpected request: ${path}`);
			}
		}),
	);
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	vi.spyOn(console, "error").mockImplementation(() => {});
	const human = vi.spyOn(console, "log").mockImplementation(() => {});
	return { requests, stdout, human };
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("a standalone Studio journey", () => {
	it("runs a domain-free goal once, follows the real run, and prints native evidence and its Studio report", async () => {
		const { requests, stdout } = server();
		expect(await journeyCommand(input)).toBe(0);
		expect(requests.map((r) => r.path)).toEqual([
			"/auth/token",
			"/ax/v1/runs",
			"/ax/v1/runs/run-one/stream",
			"/ax/v1/runs/run-one",
		]);
		expect(requests[1]).toMatchObject({ method: "POST", body: { goal, agent: "codex" } });
		expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual(evidence);
	});

	it("lets Studio choose a permitted harness when the caller omits it", async () => {
		const { requests } = server();
		await journeyCommand({ intent: goal, json: true });
		expect(requests[1].body).toEqual({ goal });
	});

	it("passes the site and precise model and prints the recorded insight and report in the terminal", async () => {
		const { requests, human } = server();
		expect(
			await journeyCommand({ ...input, domain: "linear.app", model: "gpt-5.4-mini", json: false }),
		).toBe(0);
		expect(requests[1].body).toEqual({
			goal,
			site: "linear.app",
			agent: "codex",
			model: "gpt-5.4-mini",
		});
		const lines = human.mock.calls.flat().join("\n");
		expect(lines).toContain("Found the endpoint.");
		expect(lines).toContain(reportUrl);
	});

	it("opens an existing regular run by ID without launching a new one", async () => {
		const { requests, stdout } = server();
		expect(await viewRun("run-one", true)).toBe(0);
		const result = JSON.parse(String(stdout.mock.calls[0][0]));
		expect(result.runId).toBe("run-one");
		expect(result).not.toHaveProperty("setId");
		expect(requests.filter((r) => r.method === "POST" && r.path.startsWith("/ax/"))).toEqual([]);
	});

	it("returns a Studio refusal without trying another product or creating a second run", async () => {
		const { requests, stdout } = server({
			status: 403,
			body: { code: "PRODUCT_REQUIRED", message: "Studio access required." },
		});
		expect(await journeyCommand(input)).toBe(2);
		expect(requests.map((r) => r.path)).toEqual(["/auth/token", "/ax/v1/runs"]);
		expect(JSON.parse(String(stdout.mock.calls[0][0])).code).toBe("PRODUCT_REQUIRED");
	});

	it("points a quota refusal to the matching Studio Usage page", async () => {
		const body = { code: "LIMIT_EXCEEDED", message: "No runs remain." };
		const { stdout } = server({ status: 402, body });
		vi.stubEnv("ORA_PLATFORM_URL", "http://api.ora.localhost:8081");
		expect(await journeyCommand(input)).toBe(2);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining(
				"http://app.ora.localhost:8081/d?to=%2F%5Borg%5D%2Fsettings%3Ftab%3Dusage",
			),
		);
		expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual(body);
	});
});
