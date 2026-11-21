import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "./exit-codes";
import { learnCommand } from "./learn";

// ora's published skill with a Workflows section added (see skills.test.ts).
const WITH_WORKFLOWS = readFileSync(
	new URL("../api/__fixtures__/ora-skill-with-workflows.md", import.meta.url),
	"utf8",
);
const PUBLISHED = WITH_WORKFLOWS.replace(/## Workflows[\s\S]*?(?=## Discovering Products)/, "");

/** ora's registry serving `markdown` as the ora skill, with the matching digest. */
function registry(markdown: string) {
	const bytes = new TextEncoder().encode(markdown);
	const index = {
		$schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
		skills: [
			{
				name: "ora",
				type: "skill-md",
				description: "Discover agent-ready products, check scores, and share feedback using ora.",
				url: "/.well-known/agent-skills/ora/SKILL.md",
				digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
			},
		],
	};
	return vi.fn(async (url: string | URL) =>
		String(url).endsWith("index.json")
			? new Response(JSON.stringify(index), { status: 200 })
			: new Response(bytes, { status: 200 }),
	);
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const NEXT = "Next: ax audit <domain>  # step one: score the site";

describe("learnCommand", () => {
	it("prints the skill's Workflows section on stdout and the Next line on stderr", async () => {
		vi.stubGlobal("fetch", registry(WITH_WORKFLOWS));
		expect(await learnCommand()).toBe(EXIT.OK);
		const printed = String(vi.mocked(process.stdout.write).mock.calls[0][0]);
		expect(printed.startsWith("## Workflows\n")).toBe(true);
		expect(printed).toContain("3. `ax deep-journey {domain}` sends a real agent");
		expect(printed).not.toContain("Discovering Products");
		expect(console.error).toHaveBeenCalledWith(NEXT);
	});

	it("names the docs URL and exits 0 when the skill has no Workflows section", async () => {
		vi.stubGlobal("fetch", registry(PUBLISHED));
		expect(await learnCommand({ baseUrl: "http://ora.localhost:1355" })).toBe(EXIT.OK);
		expect(console.log).toHaveBeenCalledWith(
			"The ora skill has no Workflows section yet. The ax workflow is in the CLI guide: http://ora.localhost:1355/docs/cli",
		);
		expect(process.stdout.write).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(NEXT);
	});

	it("fetches from ORA_API_URL", async () => {
		vi.stubEnv("ORA_API_URL", "http://ora.localhost:1355");
		const fetchMock = registry(WITH_WORKFLOWS);
		vi.stubGlobal("fetch", fetchMock);
		expect(await learnCommand()).toBe(EXIT.OK);
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			"http://ora.localhost:1355/.well-known/agent-skills/index.json",
		);
	});

	it("exits 3 with a retry when the registry cannot be reached", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("getaddrinfo ENOTFOUND");
			}),
		);
		expect(await learnCommand()).toBe(EXIT.API);
		expect(process.stdout.write).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			"Next: ax learn  # retry, or read https://ora.ai/docs/cli",
		);
	});
});
