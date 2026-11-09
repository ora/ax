// Copied from ora's WebMCP audit engine. DO NOT EDIT BY HAND.
//
// `ax webmcp-audit` captures a page here and ora scores it there. Both sides
// have to measure the same thing or a developer gets one answer locally and a
// different one from the published audit, so this file is a COPY of the
// engine's own code rather than a reimplementation of it.
//
// What pins the two together is the capture shim version - `WEBMCP_SHIM_VERSION`
// in ./checks.ts. The ingest endpoint refuses a capture taken by any other
// version. Note what that does NOT catch: the engine can change this code
// without changing the version, and it has. Re-copy the whole directory
// whenever the engine moves; do not trust the version check to notice.
//
// To update: re-copy from the engine and rewrite the import paths. Never patch
// it here - a change that belongs in the engine has to be made there first, or
// the two stop agreeing.
//
// One thing the re-copy must redo: the engine's comments cite its own source
// paths, and those are rewritten to point at files in THIS directory. Nothing
// executable differs.
//
// Verbatim: no edits beyond import paths.
//
import type { WebmcpCategory, WebmcpCheckId } from "./types";

/**
 * Check id registry for the WebMCP audit. Every check id, its title, and its
 * category are fixed here - checks.ts is pure data + tiny helpers, no
 * behaviour, so the capture/scoring engine and the report UI both import it
 * as the single source of truth.
 *
 * `WebmcpCheckId` itself is defined in `types.ts` (so `WebmcpFinding.checkId`
 * can be typed against it without a types.ts <-> checks.ts import cycle) and
 * re-exported here so existing `import { type WebmcpCheckId } from "./checks"`
 * call sites keep working.
 */
export type { WebmcpCheckId };

export interface WebmcpCheckDefinition {
  title: string;
  category: WebmcpCategory;
  /** Points this check is worth within its category. Per-category weights
   * sum to `WEBMCP_CATEGORY_WEIGHTS[category]` - see `checks.spec.ts`. */
  weight: number;
  docSlug: string;
}

/**
 * Pillar weights, out of 100. Availability is deliberately NOT a pillar:
 * whether an agent can use the page today is browser-rollout information
 * (`deriveAvailability`, in the engine's scoring module, published
 * beside the score), never something averaged into a number.
 */
export const WEBMCP_CATEGORY_WEIGHTS: Record<WebmcpCategory, number> = {
  "shared-experience": 30,
  "task-completion": 25,
  "tool-quality": 25,
  trust: 20,
};

export const WEBMCP_CHECKS: Record<WebmcpCheckId, WebmcpCheckDefinition> = {
  // Shared experience (30) - people and agents share this page.
  //
  // page-experience carries the most: it grades the page a person actually
  // sees (from the no-shim screenshot), and a site must not score well by
  // serving agents and no one else. human-parity reads whether the person
  // co-browsing can see and use what the agent acts on. visible-effect is the
  // actuation half of the same question (Stage 2a, 2026-09): when the audit
  // invoked a read-only tool, did the page the person is looking at move.
  // The 2a rebalance scaled the two siblings (20 -> 16, 10 -> 8) to make room
  // for it. A title-present check (the spec's top-level `title`) joins in
  // Stage 2b once the shim records the spec field - see the note on
  // `WebmcpCheckId`.
  "page-experience": {
    title: "Page experience",
    category: "shared-experience",
    weight: 16,
    docSlug: "page-experience",
  },
  "human-parity": {
    title: "Human parity",
    category: "shared-experience",
    weight: 8,
    docSlug: "human-parity",
  },
  "visible-effect": {
    title: "Visible effect",
    category: "shared-experience",
    weight: 6,
    docSlug: "visible-effect",
  },

  // Task completion (25), labelled "Tool selection" on every surface - can an
  // agent pick the right tool here. Nothing is executed, so the pillar
  // measures selection, not completion; the id stays for the wire.
  //
  // tool-selection carries the most: it is the closest thing this audit has to
  // watching a real agent try, and it is exactly Chrome's "call accuracy" eval
  // shape (pick the right tool with the right arguments for an intent).
  // invoke-success-rate (Stage 2a) is the other half: of the read-only tools
  // the audit actually called, how many answered. The 2a rebalance scaled the
  // two siblings (15 -> 12, 10 -> 7) to make room for it.
  "tool-selection": {
    title: "Tool selection",
    category: "task-completion",
    weight: 12,
    docSlug: "tool-selection",
  },
  "coverage-vs-site-type": {
    title: "Coverage vs. site type",
    category: "task-completion",
    weight: 7,
    docSlug: "coverage-vs-site-type",
  },
  "invoke-success-rate": {
    title: "Invoke success rate",
    category: "task-completion",
    weight: 6,
    docSlug: "invoke-success-rate",
  },

  // Tool quality (25) - are the tool contracts built right.
  //
  // The schema/description/handler checks lead because a tool an agent cannot
  // parse or run has no working contract. naming-quality rests on a verb list
  // that can never be complete, so it warns rather than fails and carries
  // little; registration-timing is a note-weight check printed in whole ms.
  // The "execute missing its signal param" spec-completeness note joins in
  // Stage 2 - the Stage 1 capture only records that execute exists, and a
  // permanently unmeasured check would drag every audit's evidence coverage.
  "schema-validity": {
    title: "Schema validity",
    category: "tool-quality",
    weight: 4,
    docSlug: "schema-validity",
  },
  "schema-quality": {
    title: "Schema quality",
    category: "tool-quality",
    weight: 4,
    docSlug: "schema-quality",
  },
  "description-quality": {
    title: "Description quality",
    category: "tool-quality",
    weight: 5,
    docSlug: "description-quality",
  },
  "stub-detection": {
    title: "Stub detection",
    category: "tool-quality",
    weight: 4,
    docSlug: "stub-detection",
  },
  "canonical-entry-point": {
    title: "Canonical entry point",
    category: "tool-quality",
    weight: 3,
    docSlug: "canonical-entry-point",
  },
  "naming-quality": {
    title: "Naming quality",
    category: "tool-quality",
    weight: 2,
    docSlug: "naming-quality",
  },
  "registration-errors": {
    title: "Registration errors",
    category: "tool-quality",
    weight: 2,
    docSlug: "registration-errors",
  },
  "registration-timing": {
    title: "Registration timing",
    category: "tool-quality",
    weight: 1,
    docSlug: "registration-timing",
  },

  // Trust (20) - can an agent trust what the tools declare.
  //
  // The two annotation checks split the pillar's lead: an information-carrying
  // readOnlyHint is what lets an agent relax confirmation on reads, and a hint
  // the tool's own name or description contradicts poisons every hint in the
  // set. injection-surface reviews the METADATA an agent ingests (names,
  // descriptions, titles, schema descriptions) for instruction-override
  // patterns - a free-text parameter is never flagged; a search tool takes a
  // query. hint-vs-observed (Stage 2a) is the one check that compares a hint
  // against observed behaviour: a read-only tool the audit called that sent
  // non-GET traffic (after the GraphQL and baseline-noise filters) gets a
  // warning, never a fail - an HTTP method is not a write. The 2a rebalance
  // scaled the four siblings (6/6/4/4 -> 5/5/3/3) to make room for it.
  //
  // consequential-hint (2026-10-19) scores WebMCP's consequentialHint on tools
  // whose names read like significant or irreversible actions - the spec's
  // own mitigation for misrepresented intent (6.4.5), the sibling of
  // untrusted-content-hint (6.4.4), so it takes the same 3. The two annotation
  // checks (5/5 -> 4/4) and hint-vs-observed (4 -> 3) made room.
  "annotations-present": {
    title: "Annotations present",
    category: "trust",
    weight: 4,
    docSlug: "annotations-present",
  },
  "annotation-mismatch": {
    title: "Annotation mismatch",
    category: "trust",
    weight: 4,
    docSlug: "annotation-mismatch",
  },
  "injection-surface": {
    title: "Injection surface",
    category: "trust",
    weight: 3,
    docSlug: "injection-surface",
  },
  "untrusted-content-hint": {
    title: "Untrusted content hint",
    category: "trust",
    weight: 3,
    docSlug: "untrusted-content-hint",
  },
  "hint-vs-observed": {
    title: "Hint vs. observed",
    category: "trust",
    weight: 3,
    docSlug: "hint-vs-observed",
  },
  "consequential-hint": {
    title: "Consequential hint",
    category: "trust",
    weight: 3,
    docSlug: "consequential-hint",
  },
};

// The WORKER's capture stamp: `capture-server.ts` (deployed separately, on
// Fly) reports it and the engine stores what the worker reported, so bumping
// it here without a worker redeploy only manufactures skew (shim_skew warns on
// every capture, and version-keyed staleness marks fresh audits stale).
// App-side vocabulary changes (e.g. the 2026-08-31 unmeasured/coverage split)
// do NOT move this number - forced re-audits are explicit
// (`scripts/webmcp-seed.ts --ignore-freshness`), and the 7-day fresh window
// plus the ranking's coverage gate handle organic healing.
//
// "1" -> "2" (2026-09-01): the shim gained getTools() on the modelContext
// delegate. Before it, a page whose polyfill stood down and then awaited
// getTools() before registering (Google's bistro demo) threw and registered
// nothing, so every audit of such a page measured the shim's gap rather than
// the site - stored rows from shim 1 are honestly stale for those pages, and
// the version-keyed freshness miss is the point. Both deploys ride the same
// merge: the deploy-worker workflow's path filter covers this file, so the
// skew window is the minutes between the Vercel and Fly rollouts.
//
// "2" -> "3" (2026-09-03): the capture verdict stopped treating API
// existence as tool acceptance. Pass A now calls the native getTools() surface,
// and the registration wait gives late hydration an initial arrival window
// before applying the quiet timer. Stored v2 captures cannot answer either
// question, so they are deliberately incompatible rather than merely old.
//
// Not bumped on 2026-10-19, deliberately: the capture shim began recording the
// spec's top-level `title`, the invoke shim began firing toolchange /
// toolactivated / toolcancel, and declarative forms stopped counting as tools.
// All of it is additive or re-derived app-side - an older capture simply
// lacks `title` (read as "not recorded", never "not declared"), the events
// only affect invoking captures, and the forms change is applied when a
// capture is scored: the worker's verdict is worker-side, so the engine
// re-derives it (`verdictWithoutForms`) instead of trusting an older worker
// that still called a forms-only page `active` or `testing-only`. A v3
// capture from before the change therefore still answers the questions v3
// asks.
// Bumping would have discarded every stored audit for no measurement gain.
export const WEBMCP_SHIM_VERSION = "3";
// The date the pinned spec read was actually taken (see the protocol-webmcp
// skill, which pins the same 2026-11-04 review); moves only when the read
// date moves.
export const WEBMCP_SPEC_SNAPSHOT = "2026-11-04";

/**
 * Every spec snapshot whose stored audits still measure what the scanner's
 * `webmcp` check reads from them (`webmcpRuntimeEvidence` in
 * the scanner's own layer: the verdict and the tool count).
 * Moving `WEBMCP_SPEC_SNAPSHOT` alone would refuse every stored audit as
 * runtime evidence until each domain was re-audited, dropping the whole
 * corpus to the static ladder for up to the 7-day fresh window. A snapshot
 * belongs here only when the delta leaves the capture contract alone:
 *
 * - 2026-08-26 -> 2026-10-16: new annotation keys (consequentialHint,
 *   debugging), specified toolactivated / toolcancel events, specific
 *   DOMException names in place of the old catch-all, the origin-keyed agent
 *   cluster requirement dropped, and the declarative section removed. None
 *   of it changes which tools register or how the verdict is reached.
 * - 2026-10-16 -> 2026-11-04: the optional outputSchema tool member and
 *   security notes on cross-origin exposure. Neither changes registration
 *   or the verdict.
 *
 * A delta that does change it (a new registration path, a renamed entry
 * point) leaves the old snapshot out, and those audits age out on purpose.
 *
 * Verdict and tool count only: 2026-08-26 captures went through the old
 * annotation normalizer, which dropped consequentialHint and debugging, so
 * this set must never back a consumer that reads annotations.
 */
export const WEBMCP_RUNTIME_COMPATIBLE_SPEC_SNAPSHOTS: ReadonlySet<string> = new Set([
  "2026-08-26",
  "2026-10-16",
  WEBMCP_SPEC_SNAPSHOT,
]);

/**
 * Git blob SHA of the normative spec source (index.bs in
 * webmachinelearning/webmcp) as reviewed for the protocol-webmcp skill. A
 * blob SHA rather than a repo commit so unrelated repo commits (explainer
 * edits, CI) never alert; the spec-drift-watch workflow compares the live
 * blob SHA against this pin, replacing the old date-cutoff signal (which
 * silently treated every commit on the snapshot date as reviewed). On
 * drift, re-verify and advance this pin together with the skill.
 */
export const WEBMCP_SPEC_SOURCE_SHA = "847677e03d3e61aaddf65ad328147129083168c0";

/** Grade bands for the WebMCP audit score. Deliberately NOT the scanner's
 * `GRADE_THRESHOLDS` (`src/config/scoring.ts`) - this is its own domain even
 * though the band style matches. */
const WEBMCP_GRADE_THRESHOLDS = {
  "A+": 95,
  A: 85,
  B: 70,
  C: 50,
  D: 30,
  F: 0,
} as const;

export function webmcpGrade(score: number): string {
  if (score >= WEBMCP_GRADE_THRESHOLDS["A+"]) return "A+";
  if (score >= WEBMCP_GRADE_THRESHOLDS.A) return "A";
  if (score >= WEBMCP_GRADE_THRESHOLDS.B) return "B";
  if (score >= WEBMCP_GRADE_THRESHOLDS.C) return "C";
  if (score >= WEBMCP_GRADE_THRESHOLDS.D) return "D";
  return "F";
}

/**
 * Short, copy-pastable JS fix snippet for a failing check, or `null` when
 * the check names a behavioural/measurement gap rather than a one-line code
 * fix (e.g. `tool-selection` is an outcome of description/schema quality,
 * not its own fixable call site). `tool` is the tool name to interpolate
 * when the snippet targets a specific tool; omit for site-wide checks.
 */
export function fixSnippetFor(
  checkId: WebmcpCheckId,
  tool?: string | null,
): string | null {
  const name = tool || "your_tool_name";
  switch (checkId) {
    case "canonical-entry-point":
      return `// document.modelContext is the canonical entry point - the navigator.modelContext alias is deprecated.\ndocument.modelContext.registerTool({ /* ... */ });`;
    case "registration-timing":
      return `// Register tools as soon as they're ready, not behind a deferred/async chunk.\ndocument.modelContext.registerTool({ /* ... */ });`;
    case "schema-validity":
      return `{\n  name: "${name}",\n  inputSchema: { type: "object", properties: { /* ... */ }, required: [] }\n}`;
    case "schema-quality":
      return `{\n  name: "${name}",\n  inputSchema: {\n    type: "object",\n    properties: {\n      query: { type: "string", description: "What to search for" }\n    },\n    required: ["query"]\n  }\n}`;
    case "description-quality":
      return `{\n  name: "${name}",\n  description: "Describe what this tool does, when to use it, and what it returns."\n}`;
    case "naming-quality":
      return `{ name: "${name.toLowerCase().replace(/\s+/g, "_")}" /* short, unique, verb-based */ }`;
    case "stub-detection":
      return `{\n  name: "${name}",\n  execute: async (args, { signal }) => {\n    // Perform the real action here - return live data, not a static placeholder.\n    // Pass signal to any fetch so cancellation propagates.\n    return result;\n  }\n}`;
    case "annotations-present":
      return `{\n  name: "${name}",\n  // Declare readOnlyHint: true on tools that truly have no side effects -\n  // that is the claim that lets an agent relax confirmation on reads.\n  // (false is the default, so declaring it adds no information.)\n  annotations: { readOnlyHint: true }\n}`;
    case "annotation-mismatch":
      return `// readOnlyHint must match what the tool actually does - drop it (or set false) on a tool that writes,\n// and never pair readOnlyHint: true with consequentialHint: true. If the write is significant or\n// hard to undo (a purchase, a booking, a payment), declare consequentialHint: true so the agent\n// confirms with the person first.\n{ name: "${name}", annotations: { readOnlyHint: false } }`;
    case "injection-surface":
      return `{\n  name: "${name}",\n  // Metadata DESCRIBES the tool - it never addresses the agent reading it.\n  // Rewrite any name, description, title, or schema field description that\n  // instructs the agent (which tool to prefer, what to output, rules to\n  // ignore) so it states what the tool does and what it returns instead.\n  description: "Searches the catalog and returns matching items with prices."\n}`;
    case "untrusted-content-hint":
      return `{ name: "${name}", annotations: { untrustedContentHint: true } }`;
    case "consequential-hint":
      return `// consequentialHint: true marks a significant or irreversible action (a purchase,\n// a booking, a payment) so the agent confirms with the person before running it.\n{ name: "${name}", annotations: { consequentialHint: true } }`;
    case "human-parity":
      return `// Make the tool's effect visible on the page the person is looking at:\n// update the same UI your existing human flow uses when ${name.toLowerCase().replace(/\s+/g, "_")} runs,\n// so the person co-browsing sees what the agent just did.\nexecute: async (args, { signal }) => {\n  const result = await performAction(args, signal);\n  renderResultInPage(result); // the human-visible half of the same action\n  return result;\n}`;
    case "registration-errors":
      return `document.modelContext.registerTool({ /* ... */ }).catch(function (err) {\n  console.error("WebMCP registration failed", err);\n});`;
    case "visible-effect":
      return `// A read-only tool should still show its answer on the page: render what\n// ${name.toLowerCase().replace(/\s+/g, "_")} returns where the person co-browsing can see it, and return\n// the same data to the agent.\nexecute: async (args, { signal }) => {\n  const result = await fetchResult(args, signal);\n  renderResultInPage(result);\n  return result;\n}`;
    case "invoke-success-rate":
      return `{\n  name: "${name}",\n  execute: async (args, { signal }) => {\n    // Settle promptly and never throw: a rejection reaches the agent as an\n    // opaque OperationError with your message dropped, so put recovery hints\n    // in a successful return.\n    try {\n      return await doWork(args, signal);\n    } catch (err) {\n      return { error: "could not complete", hint: String(err && err.message) };\n    }\n  }\n}`;
    case "hint-vs-observed":
      return `// readOnlyHint: true is a promise that calling the tool changes nothing.\n// Keep it on tools that only read; drop it (or set false) on one that writes.\n{ name: "${name}", annotations: { readOnlyHint: true } }`;
    case "tool-selection":
    case "coverage-vs-site-type":
    case "page-experience":
      return null;
    default: {
      const _exhaustive: never = checkId;
      return _exhaustive;
    }
  }
}
