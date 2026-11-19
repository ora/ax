import { describe, expect, it } from "vitest";
import { classifyDrift, stripComments } from "./contract-drift-lib.mjs";

// Excerpt of src/contract/types.gen.ts as it was before ora/ax#102 (the
// POST /api/v2/scan error responses), and the same excerpt as production
// served it afterwards: only the @description comments changed.
const BEFORE = `      /** @description Invalid input (schema or domain). */
      400: {
        content: {
          "application/json": components["schemas"]["ErrorResponse"];
        };
      };
      /** @description Domain unreachable or URL-kind classification failed. */
      422: {
        content: {
          "application/json": components["schemas"]["ErrorResponse"];
        };
      };
`;
const AFTER = `      /** @description Invalid input (schema or domain): \`code\` is \`INVALID_INPUT\` or \`INVALID_DOMAIN\`. */
      400: {
        content: {
          "application/json": components["schemas"]["ErrorResponse"];
        };
      };
      /** @description Domain unreachable (a \`DOMAIN_*\` code naming the cause) or URL-kind classification failed (\`INVALID_URL\`, with \`reason\`). Same codes as POST /api/scan. */
      422: {
        content: {
          "application/json": components["schemas"]["ErrorResponse"];
        };
      };
`;

const VERSION = (v) =>
	`/** The ora contract version (spec info.version) these types were generated from. */\nexport const BUILT_AGAINST = "${v}";\n`;

describe("classifyDrift", () => {
	it("reports none when nothing changed", () => {
		expect(classifyDrift([{ committed: BEFORE, generated: BEFORE }])).toBe("none");
	});

	it("reports docs when only descriptions were reworded (the ora/ax#102 case)", () => {
		expect(
			classifyDrift([
				{ committed: BEFORE, generated: AFTER },
				{ committed: VERSION("1.42.0"), generated: VERSION("1.42.0") },
			]),
		).toBe("docs");
	});

	it("reports docs when a multi-line comment is added", () => {
		const generated = BEFORE.replace(
			"      400: {",
			"      /**\n       * New note.\n       */\n      400: {",
		);
		expect(classifyDrift([{ committed: BEFORE, generated }])).toBe("docs");
	});

	it("reports contract when a type changed beside a comment change", () => {
		const generated = AFTER.replace('components["schemas"]["ErrorResponse"]', "unknown");
		expect(classifyDrift([{ committed: BEFORE, generated }])).toBe("contract");
	});

	it("reports contract when a response status is added", () => {
		const generated = `${BEFORE}      429: {\n        content: never;\n      };\n`;
		expect(classifyDrift([{ committed: BEFORE, generated }])).toBe("contract");
	});

	it("reports contract when only the pinned version moved", () => {
		expect(
			classifyDrift([
				{ committed: BEFORE, generated: BEFORE },
				{ committed: VERSION("1.42.0"), generated: VERSION("1.43.0") },
			]),
		).toBe("contract");
	});
});

describe("stripComments", () => {
	it("keeps comment-like text inside string literals", () => {
		const source = `accept: "*/*"; url: "https://ora.ai/api"; /* gone */ q: '//x';`;
		expect(stripComments(source)).toBe(`accept: "*/*"; url: "https://ora.ai/api";  q: '//x';`);
	});

	it("sees a changed string literal next to a comment", () => {
		expect(
			classifyDrift([{ committed: `kind: "a/*b"; /** x */`, generated: `kind: "a/*c"; /** x */` }]),
		).toBe("contract");
	});
});
