import { describe, expect, it } from "vitest";
import {
	brandPrompt,
	DOCS_SKIP_NOTE,
	defaultBrand,
	docsPrompt,
	EXACT_SKIP_NOTE,
	exactPrompt,
	LEVEL_LABELS,
	LEVELS,
	namesSite,
	needPrompt,
	needSkipNote,
	siteTermIn,
} from "./levels";

describe("the ladder", () => {
	it("runs from the least help to the most", () => {
		expect(LEVELS).toEqual(["need", "brand", "docs", "exact"]);
	});

	it("labels every level", () => {
		expect(LEVELS.map((level) => LEVEL_LABELS[level])).toEqual([
			"Need only",
			"Brand named",
			"Docs linked",
			"Exact target",
		]);
	});
});

describe("defaultBrand", () => {
	it("is the domain's name label with its first letter uppercased", () => {
		expect(defaultBrand("linear.app")).toBe("Linear");
		expect(defaultBrand("stripe.com")).toBe("Stripe");
		expect(defaultBrand("x.ai")).toBe("X");
	});

	it("skips a leading www and any subdomain", () => {
		expect(defaultBrand("www.linear.app")).toBe("Linear");
		expect(defaultBrand("docs.stripe.com")).toBe("Stripe");
		expect(defaultBrand("api.eu.example.com")).toBe("Example");
	});

	it("treats a generic second level label before a two letter country code as part of the suffix", () => {
		expect(defaultBrand("bbc.co.uk")).toBe("Bbc");
		expect(defaultBrand("www.bbc.co.uk")).toBe("Bbc");
		expect(defaultBrand("shop.example.com.au")).toBe("Example");
		expect(defaultBrand("example.io")).toBe("Example");
	});

	it("keeps a short brand under a two letter ending as the brand, not a suffix", () => {
		expect(defaultBrand("docs.ora.ai")).toBe("Ora");
		expect(defaultBrand("api.x.ai")).toBe("X");
		expect(defaultBrand("app.ora.ai")).toBe("Ora");
	});
});

describe("prompt templates", () => {
	const TASK = "Find how to create an issue from the API";

	it("asks the need level with the task as written", () => {
		expect(needPrompt(TASK)).toBe(TASK);
		expect(needPrompt(`  ${TASK}  `)).toBe(TASK);
	});

	it("names the brand after the task", () => {
		expect(brandPrompt(TASK, "Linear")).toBe(
			"Find how to create an issue from the API. Use Linear.",
		);
	});

	it("names the brand and its documentation after the task", () => {
		expect(docsPrompt(TASK, "Linear", "https://linear.app/docs")).toBe(
			"Find how to create an issue from the API. Use Linear. Its documentation is at https://linear.app/docs.",
		);
	});

	it("gives the exact starting point after the task", () => {
		expect(exactPrompt(TASK, "https://linear.app/developers")).toBe(
			"Find how to create an issue from the API. Start at https://linear.app/developers.",
		);
	});

	it("adds a period only when the task does not already end a sentence", () => {
		expect(brandPrompt("Find the pricing page.", "Linear")).toBe(
			"Find the pricing page. Use Linear.",
		);
		expect(brandPrompt("Where is the pricing page?", "Linear")).toBe(
			"Where is the pricing page? Use Linear.",
		);
		expect(exactPrompt("Book a demo!", "https://linear.app/contact")).toBe(
			"Book a demo! Start at https://linear.app/contact.",
		);
		expect(docsPrompt("Find the rate limits", "Linear", "https://linear.app/docs")).toBe(
			"Find the rate limits. Use Linear. Its documentation is at https://linear.app/docs.",
		);
	});

	it("trims the task before deciding on the period", () => {
		expect(brandPrompt("  Find the pricing page.  ", "Linear")).toBe(
			"Find the pricing page. Use Linear.",
		);
		expect(brandPrompt("Find the pricing page   ", "Linear")).toBe(
			"Find the pricing page. Use Linear.",
		);
	});
});

describe("namesSite (the need-level leak check)", () => {
	it("is true when the task contains the site's domain", () => {
		expect(namesSite("Open linear.app and find the pricing", "linear.app", "Acme")).toBe(true);
		expect(namesSite("See https://linear.app/docs for the API", "linear.app", "Acme")).toBe(true);
	});

	it("is true when the task names the brand as a whole word", () => {
		expect(namesSite("Find the Linear API docs", "linear.app", "Linear")).toBe(true);
		expect(namesSite("Linear's pricing for teams", "linear.app", "Linear")).toBe(true);
		expect(namesSite("Compare plans (Linear)", "linear.app", "Linear")).toBe(true);
	});

	it("is false when the brand only appears inside another word", () => {
		expect(namesSite("Explain nonlinear regression", "linear.app", "Linear")).toBe(false);
		expect(namesSite("Grow linearly with the team", "linear.app", "Linear")).toBe(false);
		expect(namesSite("Use a linear_model in sklearn", "linear.app", "Linear")).toBe(false);
	});

	it("ignores case on both the domain and the brand", () => {
		expect(namesSite("find the LINEAR api", "linear.app", "Linear")).toBe(true);
		expect(namesSite("Open LINEAR.APP", "linear.app", "Acme")).toBe(true);
		expect(namesSite("find the Linear api", "linear.app", "linear")).toBe(true);
	});

	it("matches a fullwidth spelling of the brand", () => {
		expect(namesSite("Use ＬＩＮＥＡＲ for this", "linear.app", "Linear")).toBe(true);
	});

	it("matches a brand whose ends are not letters", () => {
		expect(namesSite("Write C++ bindings for the API", "isocpp.org", "C++")).toBe(true);
		expect(namesSite("Write C bindings for the API", "isocpp.org", "C++")).toBe(false);
	});

	it("is false when the task names neither", () => {
		expect(namesSite("Find how to create an issue from the API", "linear.app", "Linear")).toBe(
			false,
		);
	});
});

describe("siteTermIn", () => {
	it("names the brand when the brand matched, even when the domain did too", () => {
		expect(siteTermIn("Find the Linear API docs", "linear.app", "Linear")).toBe("Linear");
		expect(siteTermIn("Open linear.app", "linear.app", "Linear")).toBe("Linear");
	});

	it("names the domain when only the domain matched", () => {
		expect(siteTermIn("Open linear.app", "linear.app", "Acme")).toBe("linear.app");
	});

	it("keeps the brand as configured, not as the task spelled it", () => {
		expect(siteTermIn("find the LINEAR api", "linear.app", "Linear")).toBe("Linear");
	});

	it("is null when nothing in the task names the site", () => {
		expect(siteTermIn("Find a project tracker", "linear.app", "Linear")).toBeNull();
	});
});

describe("skip notes", () => {
	it("says why the need level is skipped, naming what matched", () => {
		expect(needSkipNote("Linear")).toBe(
			"The task names Linear, so the need level is skipped. Write the task without it to include that level.",
		);
		expect(needSkipNote("linear.app")).toBe(
			"The task names linear.app, so the need level is skipped. Write the task without it to include that level.",
		);
	});

	it("says how to include the docs level", () => {
		expect(DOCS_SKIP_NOTE).toBe(
			"No --docs URL, so the docs level is skipped. Add --docs <url> to include it.",
		);
	});

	it("says how to include the exact level", () => {
		expect(EXACT_SKIP_NOTE).toBe(
			"No --exact URL, so the exact level is skipped. Add --exact <url> to include it.",
		);
	});
});
