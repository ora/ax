import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestOf, fetchSkill, fetchSkillIndex, SkillApiError, skillSection } from "./skills";

// The first 62 lines of ora's published skill
// (/.well-known/agent-skills/ora/SKILL.md) verbatim, with a Workflows section
// added before "Discovering Products": ora's skill does not carry one yet.
const ORA_SKILL = readFileSync(
	new URL("./__fixtures__/ora-skill-with-workflows.md", import.meta.url),
	"utf8",
);

// Index shape mirrors ora's real /.well-known/agent-skills/index.json
// (agentskills.io discovery 0.2.0): name, type, description, url, digest.
const SKILL_BYTES = new TextEncoder().encode("---\nname: agent-ready-website\n---\n\n# Skill\n");
const DIGEST = `sha256:${createHash("sha256").update(SKILL_BYTES).digest("hex")}`;

const INDEX = {
	$schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
	skills: [
		{
			name: "agent-ready-website",
			type: "skill-md",
			description: "Build or improve websites to be agent-ready.",
			url: "/.well-known/agent-skills/agent-ready-website/SKILL.md",
			digest: DIGEST,
		},
	],
};

const route = (index: unknown, bytes: Uint8Array) =>
	vi.fn(async (url: string | URL) => {
		if (String(url).endsWith("index.json")) {
			return new Response(JSON.stringify(index), { status: 200 });
		}
		return new Response(bytes, { status: 200 });
	});

describe("skill registry client", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("lists the registry index", async () => {
		vi.stubGlobal("fetch", route(INDEX, SKILL_BYTES));
		const skills = await fetchSkillIndex();
		expect(skills.map((s) => s.name)).toEqual(["agent-ready-website"]);
	});

	it("fetches a skill and verifies its digest", async () => {
		const fetchMock = route(INDEX, SKILL_BYTES);
		vi.stubGlobal("fetch", fetchMock);
		const { entry, bytes } = await fetchSkill("agent-ready-website");
		expect(entry.digest).toBe(DIGEST);
		expect(digestOf(bytes)).toBe(DIGEST);
		// The relative index URL is resolved against the base.
		const skillUrl = String(fetchMock.mock.calls[1][0]);
		expect(skillUrl).toBe("https://ora.ai/.well-known/agent-skills/agent-ready-website/SKILL.md");
	});

	it("refuses bytes whose digest does not match the index", async () => {
		vi.stubGlobal("fetch", route(INDEX, new TextEncoder().encode("tampered content")));
		await expect(fetchSkill("agent-ready-website")).rejects.toThrow(/digest mismatch/);
		await expect(fetchSkill("agent-ready-website")).rejects.toMatchObject({
			code: "DIGEST_MISMATCH",
		});
	});

	it("names the known skills when asked for an unknown one", async () => {
		vi.stubGlobal("fetch", route(INDEX, SKILL_BYTES));
		await expect(fetchSkill("nope")).rejects.toThrow(/unknown skill.*agent-ready-website/);
		await expect(fetchSkill("nope")).rejects.toMatchObject({ code: "UNKNOWN_SKILL" });
	});

	it("wraps network failures as SkillApiError", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("getaddrinfo ENOTFOUND");
			}),
		);
		await expect(fetchSkillIndex()).rejects.toThrow(SkillApiError);
		await expect(fetchSkillIndex()).rejects.toMatchObject({ code: "REGISTRY_UNREACHABLE" });
	});

	it("codes an HTTP failure as REGISTRY_ERROR", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 503 })),
		);
		await expect(fetchSkillIndex()).rejects.toMatchObject({ code: "REGISTRY_ERROR" });
	});
});

describe("skillSection", () => {
	it("returns the section with its subsections, up to the next heading at its level", () => {
		const section = skillSection(ORA_SKILL, "Workflows");
		expect(section?.split("\n")[0]).toBe("## Workflows");
		expect(section).toContain("### Score a site, then send an agent at it");
		expect(section).toContain("4. Read its result: whether the agent finished");
		expect(section).not.toContain("Discovering Products");
	});

	it("reads a # line inside a fenced block as content, not a heading", () => {
		// The fenced example report in "Scanning a Domain" opens with "## ora Score".
		expect(skillSection(ORA_SKILL, "ora Score: {score}/100 (Grade: {grade})")).toBeNull();
		const scanning = skillSection(ORA_SKILL, "Scanning a Domain");
		expect(scanning).toContain("### Failed Checks");
		expect(scanning).toContain("If there are no failed checks");
		expect(scanning).not.toContain("## Workflows");
		expect(skillSection(ORA_SKILL, "Workflows")).toContain(
			"## not a heading: a fenced example inside the section",
		);
	});

	it("matches the title case-insensitively and ignores closing hashes", () => {
		expect(skillSection("# Skill\n\n## workflows ##\n\nsteps\n", "Workflows")).toBe(
			"## workflows ##\n\nsteps",
		);
	});

	it("does not close a fence on a line that opens another with an info string", () => {
		const markdown = ["## Workflows", "", "```", "```bash", "## inside", "```", "", "## Next"].join(
			"\n",
		);
		expect(skillSection(markdown, "Workflows")).toBe(
			["## Workflows", "", "```", "```bash", "## inside", "```"].join("\n"),
		);
	});

	it("is null when the skill has no such section, as ora's does not yet", () => {
		const published = ORA_SKILL.replace(/## Workflows[\s\S]*?(?=## Discovering Products)/, "");
		expect(skillSection(published, "Workflows")).toBeNull();
	});
});
