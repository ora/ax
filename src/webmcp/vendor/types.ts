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
/**
 * Shared contract for the WebMCP audit feature: live quality auditing of
 * `navigator.modelContext` / `document.modelContext` tools exposed by
 * third-party sites. Both the backend capture/check/simulation engine and
 * the frontend report UI import these types - this is the single source of
 * truth for shape; nothing here has behaviour beyond the tiny helpers in
 * `checks.ts`.
 */

/** Overall capability verdict for one captured page. */
export type WebmcpVerdict =
  | "active"
  | "testing-only"
  | "declared-inactive"
  | "api-empty"
  | "blocked"
  | "load-error"
  | "absent";

/** Terminal (and in-flight) status of a whole audit run. */
export type WebmcpAuditStatus =
  | "ok"
  | "no-tools"
  | "unreachable"
  | "waf-blocked"
  | "stub-only"
  | "error"
  | "running";

/**
 * The four pillars a WebMCP audit grades. (Availability - `deriveAvailability`
 * in the engine's scoring module - is an informational verdict beside
 * the score, never a scored category and never a gate on the number.)
 *
 *  - `shared-experience` (30): people and agents share this page - the human
 *    path still works, tools have visible counterparts, and the UI chrome an
 *    agent surface shows the person is filled in.
 *  - `task-completion` (25): can an agent pick the right tool here - given
 *    the tasks a site of this kind exists for, does it select a registered
 *    tool with valid arguments, and does the tool set cover the job. Nothing
 *    is executed, so this measures selection, not completion; the id stays
 *    for the wire, the label reads "Tool selection".
 *  - `tool-quality` (25): are the tool contracts built right - schemas,
 *    descriptions, names, handlers, entry points, registration health.
 *  - `trust` (20): can an agent trust what the tools declare - honest
 *    behaviour hints, no instruction-override surface in the metadata.
 */
export type WebmcpCategory =
  | "shared-experience"
  | "task-completion"
  | "tool-quality"
  | "trust";

/**
 * The informational readiness verdict for one audit, published on the public
 * JSON beside the score (it never gates it). Derived at read time from the
 * capture (never stored): `ready` means an in-browser agent consuming the
 * JavaScript API finds tools it can call today; `not-ready` means it does not,
 * with `reasons` saying why in the report's own words; `unknown` means the
 * capture never got to look (or the row predates this score model).
 */
export type WebmcpAvailabilityStatus = "ready" | "not-ready" | "unknown";

export type WebmcpAvailabilityReasonId =
  | "native-api"
  | "tools-callable"
  | "no-tools"
  | "declarative-only"
  | "stub-tools"
  | "iframe-only"
  | "not-captured"
  | "legacy-model";

export interface WebmcpAvailabilityReason {
  id: WebmcpAvailabilityReasonId;
  /** One reader-facing sentence. */
  detail: string;
}

export interface WebmcpAvailability {
  status: WebmcpAvailabilityStatus;
  reasons: WebmcpAvailabilityReason[];
}

/**
 * One check's verdict. Two of these mean "no score", and the difference is
 * load-bearing:
 *
 *  - `na`: genuinely inapplicable - the surface has nothing for this check to
 *    measure (no imperative tools, no coverage baseline, a clean-by-design
 *    review). The site is not charged and the audit is not incomplete.
 *  - `unmeasured`: applicable but not measured - the model was unconfigured,
 *    a transport failed, no screenshot was taken, or the model output was
 *    unusable. The details string carries the cause. Scoring excludes it like
 *    `na`, but it counts AGAINST evidence coverage (see
 *    `webmcpEvidenceCoverage` in the engine's scoring module).
 */
export type WebmcpCheckStatus = "pass" | "warning" | "fail" | "na" | "unmeasured";

/**
 * The 16 WebMCP audit check ids. Defined here (not in `checks.ts`) so
 * `WebmcpFinding.checkId` below can be typed against it without a
 * types.ts <-> checks.ts import cycle; `checks.ts` re-exports this symbol so
 * `import { type WebmcpCheckId } from "./checks"` keeps working for
 * consumers of the registry.
 *
 * Retired ids still found on stored rows (dropped by every consumer via the
 * registry lookup, and re-audited away by the forced re-seed):
 * `tools-registered` and `real-browser-eligible` became the informational
 * availability verdict (`deriveAvailability`, which no longer gates
 * anything), and `toolchange-coherence` was deleted outright -
 * the shim only ever counted PAGE-dispatched toolchange events, and the spec
 * says the UA fires that event, so the check scored a thing sites must never
 * do.
 *
 * A `title-present` check (the spec's top-level human-readable `title`) is
 * deliberately NOT here yet: the spec defines `title` as a sibling of
 * `annotations` on the tool descriptor, and the Stage 1 shim only records the
 * annotations bag - a check readable today would score spec-compliant sites
 * as untitled. It joins in Stage 2, when the shim (bumped anyway) records the
 * spec field.
 */
export type WebmcpCheckId =
  | "registration-timing"
  | "canonical-entry-point"
  | "schema-validity"
  | "schema-quality"
  | "description-quality"
  | "naming-quality"
  | "stub-detection"
  | "tool-selection"
  | "coverage-vs-site-type"
  | "annotations-present"
  | "annotation-mismatch"
  | "injection-surface"
  | "untrusted-content-hint"
  | "registration-errors"
  | "human-parity"
  | "page-experience"
  // Stage 2a (2026-09): the three checks only an invocation can answer. They
  // read `WebmcpPageCapture.invoke` (pass D) and are `na` with a run-policy
  // cause on every capture that did not invoke - cron and seed rows today.
  | "visible-effect"
  | "invoke-success-rate"
  | "hint-vs-observed";

export interface WebmcpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  untrustedContentHint?: boolean;
  title?: string;
}

/** One tool discovered on a captured page, however it was registered. */
export interface WebmcpTool {
  name: string;
  description: string;
  via: "imperative" | "declarative";
  entryPoint: "navigator" | "document" | "provideContext" | "form";
  /** Page the tool was discovered on (a capture can cover multiple pages). */
  pageUrl: string;
  /** Raw JSON Schema the tool declares for its input - shape is unvalidated
   * here; `schema-validity` / `schema-quality` checks parse it. */
  inputSchema: unknown;
  annotations: WebmcpToolAnnotations;
  hasExecute: boolean;
  /** Time from navigation to this tool appearing in the registry, or `null`
   * when it could not be measured (e.g. present before the shim attached). */
  registrationMs: number | null;
}

export interface WebmcpOriginTrial {
  present: boolean;
  payloadEligible: boolean;
  expiresAt?: string;
  origin?: string;
  feature?: string;
}

/** What a real WebMCP-capable browser would actually see on this page,
 * independent of what the audit's own capture shim reports. */
export interface WebmcpConsumerReality {
  nativeApi: boolean;
  /** Tools returned by the uninstrumented browser's native getTools() call.
   * `null` means enumeration was unavailable or rejected. Optional only for
   * stored captures written before capture contract v3. */
  nativeToolCount?: number | null;
  originTrial: WebmcpOriginTrial | null;
  permissionsPolicy: string | null;
  iframeAllow: boolean | null;
}

/**
 * Static (non-executed) WebMCP evidence pulled from HTML/JS source - mirrors
 * the shape produced by `collectStaticSignals` in
 * ./static-signals.ts (Task 3). Kept as a structural
 * shape here rather than imported so `types.ts` has no dependency on that
 * module; the two are kept in sync by contract, not by import.
 */
export interface WebmcpStaticSignals {
  imperative: {
    marker: string;
    deprecatedAliasOnly: boolean;
    removedApiOnly: boolean;
  } | null;
  polyfillPackages: string[];
  keywordMention: boolean;
}

export interface WebmcpApiSurface {
  toolchangeEvents: number;
  provideContextCalls: number;
  registrationErrors: string[];
}

export interface WebmcpCaptureTiming {
  navMs: number;
  quietMs: number;
  totalMs: number;
}

/**
 * Why the invoke pass (pass D) ran no tool at all. `disabled` is the worker's
 * `WEBMCP_INVOKE_ENABLED` kill switch refusing a request that asked for it;
 * `no-callable-tools` means the gate left nothing to call (every tool declares
 * a write, carries no hint, or has no handler); `pass-failed` means the pass D
 * context itself never got to a call (navigation failed, the shim did not
 * attach); `budget` means the request deadline arrived before the first call.
 */
export type WebmcpInvokeSkipReason =
  | "disabled"
  | "no-callable-tools"
  | "pass-failed"
  | "budget";

/**
 * Network telemetry for one invocation window - TELEMETRY ONLY. An HTTP
 * method is not a write (a GraphQL read is a POST; an analytics beacon is a
 * POST), so nothing here is an input to a fail or a zero anywhere: the
 * `hint-vs-observed` check turns it into a `warning` at most and `visible-
 * effect` never reads it. WebSocket traffic is invisible to this record.
 */
export interface WebmcpInvokeNetworkTelemetry {
  /** Non-GET fetch/XHR/document requests to the audited site's own
   * registrable domain in the window, after the GraphQL and baseline-noise
   * filters below. First-party only: a tool call that fires an analytics
   * beacon to a third party did not write to the site. */
  writes: number;
  /** Distinct hosts behind `writes`, capped. */
  writeHosts: string[];
  /** GET requests in the window. */
  reads: number;
  /** Non-GET requests that were GraphQL-shaped (`application/graphql`, or a
   * JSON body whose `query` starts with `query` or `{`) - counted here and
   * EXCLUDED from `writes`. */
  graphql: number;
  /** Non-GET requests to hosts that were already sending non-GET traffic
   * before the first call - counted here and EXCLUDED from `writes`. */
  noisy: number;
  /** Non-GET requests to hosts outside the audited site's registrable domain
   * (analytics, telemetry, third-party APIs) - counted here and EXCLUDED
   * from `writes`. */
  thirdParty: number;
}

/**
 * What each evidence channel saw across one invocation. `null` on a boolean
 * channel means the channel was volatile at baseline (it changed between two
 * idle reads before any call) or could not be read, so it reports nothing
 * rather than a diff that would be noise.
 */
export interface WebmcpInvokeChannels {
  /** `document.body.innerText` changed. */
  text: boolean | null;
  /** The accessibility-tree snapshot changed. */
  aria: boolean | null;
  /** The viewport screenshot (animations disabled) changed. */
  screenshot: boolean | null;
  /** The page URL changed, or the call destroyed the JS context. */
  navigated: boolean;
  /** Result-vs-page: how many string/number leaves of a JSON result were
   * found in the page text afterwards. `null` when the result had no leaves. */
  resultInPage: { leafCount: number; leavesFound: number } | null;
}

/** One tool the invoke pass looked at - called or deliberately not. */
export interface WebmcpInvocationRecord {
  toolName: string;
  /** `ok`: the handler settled with a value. `navigated`: the call tore down
   * the page's JS context (a navigation), so no result could be read back -
   * the navigation itself is the effect. `error`: it threw or rejected, or
   * the shim could not call it. `timeout`: it did not settle within the
   * per-tool budget (aborted via its signal). `not-attempted`: the gate or
   * the run policy left it alone - `skipReason` says which. */
  outcome: "ok" | "navigated" | "error" | "timeout" | "not-attempted";
  skipReason: string | null;
  /** The arguments sent, synthesized from the schema alone (never from the
   * tool's name or description - see `synthesizeHarmlessArgs`). */
  args: unknown;
  result: {
    /** The real shape of what `execute` resolved with. */
    kind: "undefined" | "null" | "value";
    /** Bounded JSON preview of the value, or `null`. */
    preview: string | null;
    /** The handler returned without a promise. */
    sync: boolean;
    /** The value could not be JSON-copied; `preview` is its string form. */
    unserializable: boolean;
  } | null;
  error: string | null;
  durationMs: number | null;
  channels: WebmcpInvokeChannels | null;
  network: WebmcpInvokeNetworkTelemetry | null;
}

/**
 * The invoke pass (pass D) of one page capture. ABSENT from a capture that did
 * not ask for it - every cron and seed capture today - and present, with
 * `skipped` set, on one that asked and ran nothing. Stored inside
 * `capture_json` with the rest of the page; no column of its own.
 *
 * A row carrying this never takes `is_current` during Stage 2a (see
 * `completeWebmcpAudit` in both adapter families): the public directory,
 * leaderboard, badge and OG card keep reading non-invoking rows, and the live
 * report reads invoking rows through `getLatestWebmcpInvokingAudit`.
 */
export interface WebmcpInvokePass {
  skipped: WebmcpInvokeSkipReason | null;
  /** The pass-level failure, when `skipped` is `pass-failed`. */
  error: string | null;
  /** Tools actually called (any outcome but `not-attempted`). */
  attempted: number;
  /** Channels that changed between two idle reads before any call. A volatile
   * channel reports `null` on every record of this pass. */
  volatile: { text: boolean; aria: boolean; screenshot: boolean };
  /** Hosts that sent non-GET traffic during the idle baseline window. */
  baselineNoisyHosts: string[];
  records: WebmcpInvocationRecord[];
  durationMs: number;
}

/** Capture result for a single page visited during an audit. */
export interface WebmcpPageCapture {
  url: string;
  finalUrl: string;
  verdict: WebmcpVerdict;
  status: WebmcpAuditStatus;
  tools: WebmcpTool[];
  declarativeFormCount: number;
  consumer: WebmcpConsumerReality;
  staticSignals: WebmcpStaticSignals;
  apiSurface: WebmcpApiSurface;
  timing: WebmcpCaptureTiming;
  error: string | null;
  /** Pass D, when this capture asked for it. Optional: rows written before
   * Stage 2a and every non-invoking capture do not carry it. */
  invoke?: WebmcpInvokePass | null;
}

/**
 * A viewport screenshot of the entry page, taken during the no-shim pass so it
 * shows what a person actually sees. It feeds the `page-experience` check and
 * then PERSISTS with the capture (owner call, 2026-08-29; it was stripped
 * before): the report's run panel shows it as the idle image when the domain
 * has no recorded agent run, and the comparison page's four viewports show
 * it while they have no frame of their own (`GET /api/webmcp/compare/site`
 * returns its bytes and type, nothing else). Those two pages are its only
 * wires - the public REST/MCP projection (`projectCapture`) rebuilds field by
 * field and does not carry it, and list surfaces read the blob-free summary.
 */
export interface WebmcpScreenshot {
  /** Base64-encoded image bytes (no data-URL prefix). */
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}

/** Whole-run capture output: one or more pages captured under one browser
 * session. */
export interface WebmcpCaptureResult {
  url: string;
  pages: WebmcpPageCapture[];
  chromeVersion: string;
  shimVersion: string;
  capturedAt: string;
  durationMs: number;
  /** Entry-page screenshot, when the capture managed to take one. Absent on
   * pre-screenshot captures and on blocked/failed pages. */
  screenshot?: WebmcpScreenshot | null;
}

/** One check's verdict against a capture. `score` is a 0..1 fraction of the
 * check's registry weight earned - multiply by `WEBMCP_CHECKS[checkId].weight`
 * to get points, never re-derive the weight elsewhere. */
export interface WebmcpFinding {
  checkId: WebmcpCheckId;
  category: WebmcpCategory;
  status: WebmcpCheckStatus;
  score: number;
  details: string;
  toolName: string | null;
  evidence: string | null;
}

export type WebmcpCategoryScores = Record<WebmcpCategory, number>;

/** One simulated "would an agent actually call the right tool" step. */
export interface WebmcpSimulationStep {
  intent: string;
  expectedKind: string;
  chosenTool: string | null;
  args: unknown;
  toolExists: boolean;
  argsValid: boolean;
  /**
   * Does the chosen tool look like the kind of tool the intent needs, judged
   * in code against the expected capability's word-bounded terms? `null` when
   * there is nothing to judge - no oracle exists for the intent (generic
   * category), or no registered tool was chosen. Optional because steps stored
   * before this field existed do not carry it; absent means the same as `null`.
   */
  kindMatched?: boolean | null;
  ok: boolean;
}

export interface WebmcpSimulation {
  steps: WebmcpSimulationStep[];
  accuracy: number;
  model: string;
  skipped: boolean;
  skipReason: string | null;
}

/** The full stored/streamed audit record. */
export interface WebmcpAudit {
  id: string;
  domain: string;
  url: string;
  /**
   * The normalized page key when this run audited ONE page rather than the
   * domain's entry page, `null` otherwise. `normalizeWebmcpPageUrl` in
   * the engine's page-url module is the only thing that produces it.
   *
   * A non-null value also declares that the row never takes `is_current`:
   * every domain-keyed surface (leaderboard, directory, badge, OG card,
   * sitemap, scanner audit context) filters on that flag, so page rows stay
   * out of all of them and are read by their own latest-by-url lookup.
   * `url` still carries the URL actually captured, which for a page audit is
   * the key itself.
   */
  pageUrl: string | null;
  status: WebmcpAuditStatus;
  verdict: WebmcpVerdict;
  score: number | null;
  grade: string | null;
  categoryScores: WebmcpCategoryScores;
  /**
   * 0..100: how much of the applicable check weight was actually measured
   * (`webmcpEvidenceCoverage` over the findings at completion time), persisted
   * so the blob-free list surfaces (ranking, badge, OG card) can apply the
   * grade-withholding gate without loading `checks_json`. `null` on rows
   * written before this column existed AND before the backfill classified
   * them - a null keeps ranking until the backfill closes that window.
   */
  evidenceCoverage: number | null;
  /**
   * How many captured tools registered through the JavaScript API
   * (`via === "imperative"`) across the run's observed pages, persisted so the
   * blob-free headline surfaces (ranking SQL, badge, OG card, directory
   * projection) can tell a declarative-only page apart without loading
   * `capture_json`. Such a page (`toolCount > 0`, `imperativeToolCount === 0`)
   * keeps its pillar scores and has the headline score, grade, badge and rank
   * withheld (`webmcpAuditIncomplete`). `null` on rows written before this
   * column existed and not yet reached by
   * `scripts/webmcp-backfill-imperative-count.ts`; a null keeps ranking.
   */
  imperativeToolCount: number | null;
  findings: WebmcpFinding[];
  capture: WebmcpCaptureResult | null;
  simulation: WebmcpSimulation | null;
  toolCount: number;
  pageCount: number;
  mode: "fast" | "deep";
  /**
   * What caused this run. `"local"` is the one member that never reaches a
   * database row: it marks an audit whose capture was produced on a
   * developer's own machine and posted to `POST /api/webmcp/audit/ingest`,
   * which is scored and returned but never persisted. It exists so a response
   * from that path can never be mistaken for a published measurement - see
   * docs/api.md, WebMCP audit surface.
   */
  source: "user" | "seed" | "cron" | "local";
  chromeVersion: string;
  shimVersion: string;
  specSnapshot: string;
  /** `null` while `status === "running"` - a duration only exists once the
   * run has stopped (successfully or not). */
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * SSE event union for a live audit stream. Naming/shape follows the scan
 * stream's discriminated-union-on-`type` idiom (see
 * `src/hooks/live-scan-stream/sse-event-handlers.ts`), narrowed to the events
 * this feature actually emits.
 */
/** The phases the engine announces, in the order it announces them. `invoke`
 * appears only on a run that asked for pass D, between `capture` and
 * `checks`. */
export type WebmcpAuditPhase = "capture" | "invoke" | "checks" | "simulation" | "persist";

export type WebmcpAuditEvent =
  | { type: "phase"; phase: WebmcpAuditPhase }
  /** One tool the invoke pass finished with, streamed as pass D runs. */
  | { type: "invocation"; record: WebmcpInvocationRecord }
  | {
      type: "page-captured";
      path: string;
      toolCount: number;
      verdict: WebmcpVerdict;
    }
  | { type: "tool-discovered"; tool: WebmcpTool }
  | { type: "finding"; finding: WebmcpFinding }
  | { type: "simulation-step"; step: WebmcpSimulationStep }
  | { type: "done"; audit: WebmcpAudit }
  | { type: "error"; message: string; status: WebmcpAuditStatus };
