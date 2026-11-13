// Copied from ora's journey code. DO NOT EDIT BY HAND.
//
// Source: ora's src/lib/journey/run-flags.spec.ts at commit 075e9fe8f, with
// its fixtures copied byte for byte into ./__fixtures__/run-flags/. These are
// ora's own cases for the rule in ./run-flags.ts, so a re-copy of the rule
// comes with a re-copy of this file. Renamed to .test.ts because ax's vitest
// collects that suffix; the only other deviations are the two source paths in
// the last describe, marked inline. Biome does not format this directory.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeDomain } from "./domain-normalize";
import { deriveRunFlags, isSiteHost, onSiteSteps, raisedFlagReasons, reachedSite, runFlagReason } from "./run-flags";

// Real stored results, trimmed to step id/type/host/status and the answer basis:
// - blocked-first-403: prod run 0cc1a662 (fiverr.com). The first on-site request
//   got a 403; only 1 of its 2 on-site requests with a status was refused.
// - memory-answer: prod run 0201b819 (bino.church). memory_share exactly 0.5, the
//   most common value among flagged runs; three on-site 404s, no refusal.
// - clean-onsite: local.db run d0a55cc0 (linear.app, a mock replay). All on-site
//   requests 200, no run_signals.
// - offsite-only: prod run a7aec281. Asked about linear.com, the agent only ever
//   fetched linear.app.
import blockedFirst403 from "./__fixtures__/run-flags/blocked-first-403.json";
import memoryAnswer from "./__fixtures__/run-flags/memory-answer.json";
import cleanOnsite from "./__fixtures__/run-flags/clean-onsite.json";
import offsiteOnly from "./__fixtures__/run-flags/offsite-only.json";

const NOT_FLAGGED = { flagged: false };

describe("isSiteHost", () => {
  it("matches the site itself and any subdomain of it", () => {
    expect(isSiteHost("fiverr.com", "fiverr.com")).toBe(true);
    expect(isSiteHost("docs.enterprise.fiverr.com", "fiverr.com")).toBe(true);
  });

  it("ignores case on both sides and trims the site", () => {
    expect(isSiteHost("Docs.Linear.App", "  LINEAR.app ")).toBe(true);
  });

  it("rejects lookalikes, parent domains and sibling brands", () => {
    expect(isSiteHost("notfiverr.com", "fiverr.com")).toBe(false);
    expect(isSiteHost("fiverr.com.example.io", "fiverr.com")).toBe(false);
    expect(isSiteHost("poupaonca.com.br", "staging.poupaonca.com.br")).toBe(false);
    expect(isSiteHost("linear.app", "linear.com")).toBe(false);
  });

  it("is false when the host or the site is missing", () => {
    expect(isSiteHost(undefined, "fiverr.com")).toBe(false);
    expect(isSiteHost("fiverr.com", null)).toBe(false);
    expect(isSiteHost("fiverr.com", "   ")).toBe(false);
  });

  it("accepts every host the canonical journey domain normalization produces", () => {
    for (const raw of [" Stripe.COM ", "linear.app", "ＦＩＶＥＲＲ.com"]) {
      expect(isSiteHost(normalizeDomain(raw), raw)).toBe(true);
    }
  });
});

describe("onSiteSteps and reachedSite", () => {
  it("keeps only the steps on the site, in trajectory order", () => {
    expect(onSiteSteps(blockedFirst403, blockedFirst403.domain).map((s) => s.id)).toEqual([0, 1, 3]);
    expect(reachedSite(blockedFirst403, blockedFirst403.domain)).toBe(true);
  });

  it("reports no reach when the agent only fetched another host", () => {
    expect(onSiteSteps(offsiteOnly, offsiteOnly.domain)).toEqual([]);
    expect(reachedSite(offsiteOnly, offsiteOnly.domain)).toBe(false);
  });

  it("reports no reach without a site or a trajectory", () => {
    expect(reachedSite(cleanOnsite, null)).toBe(false);
    expect(reachedSite({}, "linear.app")).toBe(false);
  });
});

describe("deriveRunFlags on real runs", () => {
  it("flags a run whose first on-site request was refused", () => {
    expect(deriveRunFlags(blockedFirst403, blockedFirst403.domain)).toEqual({
      blocked: { flagged: true, reason: "The site refused the agent's first request with HTTP 403" },
      answered_from_memory: NOT_FLAGGED,
    });
  });

  it("flags an answer half drawn from memory, and never counts a 404 as a refusal", () => {
    expect(deriveRunFlags(memoryAnswer, memoryAnswer.domain)).toEqual({
      blocked: NOT_FLAGGED,
      answered_from_memory: {
        flagged: true,
        reason: "Half of this answer came from the model's memory, not from pages it fetched",
      },
    });
  });

  it("flags nothing on a clean on-site run without run signals", () => {
    expect(deriveRunFlags(cleanOnsite, cleanOnsite.domain)).toEqual({
      blocked: NOT_FLAGGED,
      answered_from_memory: NOT_FLAGGED,
    });
  });

  it("flags nothing on a run that never reached the site", () => {
    expect(deriveRunFlags(offsiteOnly, offsiteOnly.domain)).toEqual({
      blocked: NOT_FLAGGED,
      answered_from_memory: NOT_FLAGGED,
    });
  });
});

// Variants of the real fixtures that isolate one rule each; the edit is named
// in every test.
describe("deriveRunFlags rules", () => {
  const steps = blockedFirst403.trajectory.steps;

  it("judges the first request that got a status, skipping steps without one", () => {
    // fiverr.com with its status-less developers.fiverr.com step moved first.
    const reordered = { trajectory: { steps: [steps[1], steps[0], ...steps.slice(2)] } };
    expect(deriveRunFlags(reordered, "fiverr.com").blocked).toEqual({
      flagged: true,
      reason: "The site refused the agent's first request with HTTP 403",
    });
  });

  it("does not flag when the first answered request succeeded and only half were refused", () => {
    // fiverr.com with the 200 from docs.enterprise.fiverr.com moved first.
    const reordered = { trajectory: { steps: [steps[3], steps[0], steps[1]] } };
    expect(deriveRunFlags(reordered, "fiverr.com").blocked).toEqual(NOT_FLAGGED);
  });

  it("flags when more than half of the answered on-site requests were refused", () => {
    // bino.church with its three on-site 404s turned into 403s: 3 of 4 refused.
    const refused = {
      trajectory: {
        steps: memoryAnswer.trajectory.steps.map((s) => ("status" in s && s.status === 404 ? { ...s, status: 403 } : s)),
      },
    };
    expect(deriveRunFlags(refused, "bino.church").blocked).toEqual({
      flagged: true,
      reason: "The site refused 3 of the agent's 4 requests that got a response, with HTTP 403",
    });
  });

  it("never counts a refusal from another host", () => {
    // The linear.com run with every linear.app response turned into a 403.
    const refusedElsewhere = {
      trajectory: {
        steps: offsiteOnly.trajectory.steps.map((s) => ("status" in s ? { ...s, status: 403 } : s)),
      },
    };
    expect(deriveRunFlags(refusedElsewhere, "linear.com").blocked).toEqual(NOT_FLAGGED);
  });

  it("does not flag memory below half", () => {
    expect(blockedFirst403.run_signals.answer_basis.memory_share).toBeLessThan(0.5);
    expect(deriveRunFlags(blockedFirst403, "fiverr.com").answered_from_memory).toEqual(NOT_FLAGGED);
  });
});

describe("raisedFlagReasons", () => {
  it("lists the raised reasons, blocked first, and nothing for a clean run", () => {
    expect(raisedFlagReasons(deriveRunFlags(blockedFirst403, blockedFirst403.domain))).toEqual([
      "The site refused the agent's first request with HTTP 403",
    ]);
    expect(raisedFlagReasons(deriveRunFlags(cleanOnsite, cleanOnsite.domain))).toEqual([]);
    expect(raisedFlagReasons(undefined)).toEqual([]);
  });
});

describe("runFlagReason", () => {
  it("names the status of a refused first request", () => {
    expect(runFlagReason({ flag: "blocked", kind: "first_request", status: 429 })).toBe(
      "The site refused the agent's first request with HTTP 429",
    );
  });

  it("counts the refusals and lists each refusing status once", () => {
    expect(
      runFlagReason({ flag: "blocked", kind: "most_requests", refused: 5, answered: 8, statuses: [401, 403] }),
    ).toBe("The site refused 5 of the agent's 8 requests that got a response, with HTTP 401 and 403");
    expect(
      runFlagReason({ flag: "blocked", kind: "most_requests", refused: 3, answered: 3, statuses: [401, 403, 429] }),
    ).toBe("The site refused 3 of the agent's 3 requests that got a response, with HTTP 401, 403 and 429");
  });

  it("says most only when memory supplied more than half of the answer", () => {
    expect(runFlagReason({ flag: "answered_from_memory", memoryShare: 0.67 })).toBe(
      "Most of this answer came from the model's memory, not from pages it fetched",
    );
    expect(runFlagReason({ flag: "answered_from_memory", memoryShare: 0.5 })).toBe(
      "Half of this answer came from the model's memory, not from pages it fetched",
    );
  });
});

describe("run-flags source", () => {
  // ax deviation: the vendored path, not ora's src/lib/journey/run-flags.ts.
  const source = readFileSync(join(process.cwd(), "src/trial/vendor/run-flags.ts"), "utf8");

  it("computes reach from step hosts, never from the engine's anchor signals", () => {
    expect(source).not.toMatch(/reached_anchor|anchor_relation/);
  });

  it("stays browser safe: type imports, plus only the browser safe domain normalizer", () => {
    const imports = source.split("\n").filter((line) => /^import\s/.test(line));
    const valueImports = imports.filter((line) => !/^import type\s/.test(line));
    expect(valueImports).toEqual(['import { normalizeDomain } from "./domain-normalize";']);
    // ax deviation: the vendored path, not ora's src/lib/journey/domain-normalize.ts.
    const normalizer = readFileSync(join(process.cwd(), "src/trial/vendor/domain-normalize.ts"), "utf8");
    expect(normalizer).not.toMatch(/^import\s/m);
  });
});
