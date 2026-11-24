import { afterEach, describe, expect, it, vi } from "vitest";
import complete from "../journey-set/__fixtures__/set-complete.json";
import created from "../journey-set/__fixtures__/set-created.json";
import { journeyCommand } from "./journey";

const goal = "Find the API endpoint for creating an issue";
const input = { intent: goal, harness: "codex", json: true };
const reportUrl = "https://app.ora.ai/review/evaluations/set-one";
const settled = { ...complete, setId: "set-one", links: { set: reportUrl }, site: null };
const evidence = {
	setId: settled.setId,
	runId: "child-one",
	run: {
		harness: "codex",
		model: "gpt-5.4-mini",
		outcome: "success",
		totalTokens: 731,
		costUsd: 0,
		numTurns: 2,
		durationMs: 3000,
		qualityScore: 80,
		rubricResults: [{ criterion: "Link to the endpoint", passed: true, note: "Linked the docs." }],
		judgeModel: "judge",
	},
	insight: { intent_satisfied: true, summary: "Found the endpoint." },
	trajectory: { steps: [{ id: 0, type: "text", kind: "output", turn: 1, text: "See the docs." }] },
};

function server(refusal?: number) {
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
					if (refusal)
						return Response.json(
							{ code: "PRODUCT_REQUIRED", message: "Studio access required." },
							{ status: refusal },
						);
					return Response.json({ ...created, setId: settled.setId, site: null }, { status: 201 });
				case "/ax/v1/sets/set-one/stream":
					return new Response(`event: set\ndata: ${JSON.stringify(settled)}\n\n`);
				case "/ax/v1/runs/set-one":
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
	it("runs a domain-free goal once, follows grading, and prints child-run evidence and its Studio report", async () => {
		const { requests, stdout } = server();
		expect(await journeyCommand(input)).toBe(0);
		expect(requests.map((r) => r.path)).toEqual([
			"/auth/token",
			"/ax/v1/runs",
			"/ax/v1/sets/set-one/stream",
			"/ax/v1/runs/set-one",
		]);
		expect(requests[1]).toMatchObject({ method: "POST", body: { goal, agent: "codex" } });
		expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
			runId: "child-one",
			setId: "set-one",
			reportUrl,
			totalTokens: 731,
			costUsd: 0,
			intentSatisfied: true,
			qualityScore: 80,
			steps: evidence.trajectory.steps,
			rubricResults: evidence.run.rubricResults,
		});
	});

	it("passes the site and precise model and prints the recorded grade and report in the terminal", async () => {
		const { requests, human } = server();
		expect(
			await journeyCommand({ ...input, domain: "linear.app", model: "gpt-5.4-mini", json: false }),
		).toBe(0);
		expect(requests[1].body).toEqual({ goal, site: "linear.app", agent: "codex/gpt-5.4-mini" });
		const lines = human.mock.calls.flat().join("\n");
		expect(lines).toContain("Linked the docs.");
		expect(lines).toContain(reportUrl);
	});

	it("returns a Studio refusal without trying another product or creating a second run", async () => {
		const { requests, stdout } = server(403);
		expect(await journeyCommand(input)).toBe(2);
		expect(requests.map((r) => r.path)).toEqual(["/auth/token", "/ax/v1/runs"]);
		expect(JSON.parse(String(stdout.mock.calls[0][0])).code).toBe("PRODUCT_REQUIRED");
	});
});
