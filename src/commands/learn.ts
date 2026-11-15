import { fetchSkill, resolveBase, SkillApiError, skillSection } from "../api/skills";
import { reportError } from "../report/json-error";
import { axCall, placeholder, printNext } from "../report/next-line";
import { EXIT } from "./audit";

// `ax learn`: print the Workflows section of ora's own skill, fetched and
// digest-verified through the registry like `ax skill`, so the CLI teaches the
// same steps the published skill does and never a bundled copy.

export const LEARN_SKILL = "ora";
const SECTION = "Workflows";

export interface LearnCommandInput {
	/** Base URL override; otherwise $ORA_API_URL, otherwise https://ora.ai. */
	baseUrl?: string;
}

const FIRST_STEP = {
	call: axCall(["audit", placeholder("domain")]),
	why: "step one: score the site",
};

export async function learnCommand(input: LearnCommandInput = {}): Promise<number> {
	const docsUrl = `${resolveBase(input.baseUrl)}/docs/cli`;
	let markdown: string;
	try {
		const { bytes } = await fetchSkill(LEARN_SKILL, input.baseUrl);
		markdown = new TextDecoder().decode(bytes);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		reportError(
			{
				code: cause instanceof SkillApiError ? cause.code : "REGISTRY_ERROR",
				message,
				next: { call: axCall(["learn"]), why: `retry, or read ${docsUrl}` },
			},
			{ json: false, display: (cleaned) => `ax learn: ${cleaned}` },
		);
		return EXIT.API;
	}

	const section = skillSection(markdown, SECTION);
	if (!section) {
		console.log(
			`The ${LEARN_SKILL} skill has no ${SECTION} section yet. The ax workflow is in the CLI guide: ${docsUrl}`,
		);
		printNext(FIRST_STEP, { stderr: true });
		return EXIT.OK;
	}
	process.stdout.write(`${section}\n`);
	printNext(FIRST_STEP, { stderr: true });
	return EXIT.OK;
}
