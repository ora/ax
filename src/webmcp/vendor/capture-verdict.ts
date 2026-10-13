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
 * Pure derivation of a captured page's WebMCP verdict, plus the origin-trial
 * token parsing that feeds it.
 *
 * Everything here takes plain facts and returns plain values so the ladder can
 * be tested without a browser. `capture-server.ts` gathers the facts from the
 * three passes and calls in here; it never inlines a verdict rule.
 */

import type {
  WebmcpAuditStatus,
  WebmcpOriginTrial,
  WebmcpStaticSignals,
  WebmcpTool,
  WebmcpVerdict,
} from "./types";

// ---------------------------------------------------------------------------
// Origin trial tokens
// ---------------------------------------------------------------------------

/**
 * Chrome origin-trial token layout (versions 2 and 3):
 *   byte 0        version
 *   bytes 1..64   Ed25519 signature over the payload
 *   bytes 65..68  payload length, uint32 big-endian
 *   bytes 69..    the JSON payload
 *
 * We do NOT verify the signature: browser observation, not this parser, decides
 * whether the token activated WebMCP. `payloadEligible` means only that the
 * payload is structurally eligible: well-formed, unexpired, for
 * the WebMCP feature, and scoped to this page origin. It must never be used as
 * proof that a browser accepted the token.
 */
const OT_HEADER_BYTES = 69;
const OT_SIGNATURE_BYTES = 64;
const OT_SUPPORTED_VERSIONS = new Set([2, 3]);
/** A real token is a few hundred characters; this bounds every parse step. */
const MAX_OT_TOKEN_CHARS = 8192;
/**
 * Largest `expiry` we will accept, in seconds.
 *
 * A JS `Date` only represents +/-8.64e15 ms around the epoch, and
 * `new Date(x).toISOString()` throws a RangeError outside it. `expiry` comes
 * from a token an audited page controls, so an unbounded value is a hostile
 * page's way of throwing inside our capture. Bounding it here - at the parse
 * boundary, where the untrusted number enters - means no downstream caller has
 * to remember that `toISOString()` can throw.
 */
const MAX_OT_EXPIRY_SECONDS = 8_640_000_000_000;

export interface ParsedOriginTrialToken {
  origin: string;
  feature: string;
  /** Unix seconds, as the token spells it. */
  expiry: number;
  isSubdomain: boolean;
  isThirdParty: boolean;
}

/** Decode one origin-trial token, or `null` when it is not a well-formed one. */
export function parseOriginTrialToken(raw: string): ParsedOriginTrialToken | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  if (token.length === 0 || token.length > MAX_OT_TOKEN_CHARS) return null;

  let buf: Buffer;
  try {
    buf = Buffer.from(token, "base64");
  } catch {
    // Buffer.from is lenient rather than throwing, but a hostile input class
    // we have not seen must not take the capture down.
    return null;
  }
  if (buf.length <= OT_HEADER_BYTES) return null;
  if (!OT_SUPPORTED_VERSIONS.has(buf[0])) return null;

  const payloadLength = buf.readUInt32BE(1 + OT_SIGNATURE_BYTES);
  // Exact-length match, the same rule Chrome applies. It also means the slice
  // below is bounded by the token we already length-capped.
  if (payloadLength !== buf.length - OT_HEADER_BYTES) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(buf.subarray(OT_HEADER_BYTES).toString("utf8"));
  } catch {
    // Not a JSON payload: not a token we can read anything from.
    return null;
  }
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  const origin = record.origin;
  const feature = record.feature;
  const expiry = record.expiry;
  if (typeof origin !== "string" || typeof feature !== "string") return null;
  if (typeof expiry !== "number" || !Number.isFinite(expiry)) return null;
  if (expiry < 0 || expiry > MAX_OT_EXPIRY_SECONDS) return null;

  return {
    origin,
    feature,
    expiry,
    isSubdomain: record.isSubdomain === true,
    isThirdParty: record.isThirdParty === true,
  };
}

/**
 * Does this trial's feature name grant the WebMCP surface?
 *
 * Chrome's current trial uses `WebMCP`; older trial material used names with a
 * `modelcontext` stem. Both are browser deployment identifiers rather than
 * names defined by the WebMCP specification, so the observed spelling is kept
 * in `WebmcpOriginTrial.feature`.
 */
export function isWebmcpTrialFeature(feature: string): boolean {
  const normalized = feature.toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "webmcp" || normalized.includes("modelcontext");
}

/** Does a token issued for `tokenOrigin` cover a page served from `pageOrigin`? */
function originCovers(tokenOrigin: string, pageOrigin: string, isSubdomain: boolean): boolean {
  let token: URL;
  let page: URL;
  try {
    token = new URL(tokenOrigin);
    page = new URL(pageOrigin);
  } catch {
    return false;
  }
  if (token.protocol !== page.protocol || token.port !== page.port) return false;
  const tokenHost = token.hostname.toLowerCase();
  const pageHost = page.hostname.toLowerCase();
  if (tokenHost === pageHost) return true;
  return isSubdomain && pageHost.endsWith(`.${tokenHost}`);
}

/**
 * Fold every origin-trial token found on the page into the one
 * `WebmcpOriginTrial` the contract carries.
 *
 * `present` is the literal fact that the page ships a trial token at all.
 * `payloadEligible` checks the unsigned payload's structure, expiry, feature,
 * and origin. Browser observation separately proves whether Chrome accepted
 * the signature and exposed the API.
 */
export function evaluateOriginTrial(
  tokens: string[],
  pageOrigin: string,
  now: Date,
): WebmcpOriginTrial | null {
  const candidates = tokens.map((t) => t.trim()).filter((t) => t.length > 0);
  if (candidates.length === 0) return null;

  let best: { parsed: ParsedOriginTrialToken; eligible: boolean; rank: number } | null = null;
  for (const candidate of candidates) {
    const parsed = parseOriginTrialToken(candidate);
    if (!parsed) continue;
    const webmcp = isWebmcpTrialFeature(parsed.feature);
    const unexpired = parsed.expiry * 1000 > now.getTime();
    const covers = originCovers(parsed.origin, pageOrigin, parsed.isSubdomain);
    const eligible = webmcp && unexpired && covers;
    // Rank so the reported token is the most relevant one on the page: a token
    // that actually grants WebMCP beats a WebMCP token that does not, which
    // beats an unrelated trial.
    const rank = eligible ? 3 : webmcp ? 2 : 1;
    if (!best || rank > best.rank) best = { parsed, eligible, rank };
  }

  if (!best) return { present: true, payloadEligible: false };

  return {
    present: true,
    payloadEligible: best.eligible,
    origin: best.parsed.origin,
    feature: best.parsed.feature,
    expiresAt: new Date(best.parsed.expiry * 1000).toISOString(),
  };
}

/**
 * Extract every origin-trial token a response advertises. Chrome accepts the
 * header once per token and also accepts several tokens in one comma-separated
 * value; base64 never contains a comma, so splitting is safe.
 */
export function parseOriginTrialHeader(headerValue: string | undefined | null): string[] {
  if (!headerValue) return [];
  return headerValue
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Verdict ladder
// ---------------------------------------------------------------------------

/**
 * Prefix on the `apiSurface.registrationErrors` entry that records the capture
 * shim losing an entry point to the page.
 *
 * It rides in `registrationErrors` because that is the only string list the
 * contract gives the API surface, but it is NOT a site defect: a page shipping
 * its own `modelContext` polyfill is doing something legitimate. Consumers
 * scoring stability (the `registration-errors` check) must filter entries
 * carrying this prefix out before counting.
 */
export const CAPTURE_INCOMPLETE_PREFIX = "capture-incomplete:";

/** The facts the three passes produce, reduced to what the verdict turns on. */
export interface WebmcpPageFacts {
  /** Non-null when navigation itself failed (timeout, DNS, refused, aborted). */
  loadError: string | null;
  /** Pass A response looked like a bot wall or WAF challenge. */
  blocked: boolean;
  /** Pass A (no shim) saw a real `modelContext` on `document` or its legacy
   * `navigator` fallback. */
  nativeApi: boolean;
  /** Number of tools the native getTools() surface returned. `null` means the
   * API could not enumerate tools, which is unverified rather than empty. */
  nativeToolCount: number | null;
  /** Declarative `[toolname]` tools found in the DOM. */
  declarativeToolCount: number;
  /** Live tools in the capture, declarative and imperative together. */
  toolCount: number;
  /** The page redefined `modelContext` over the shim on some entry point, so
   * an empty imperative capture is not evidence of absence. */
  shimTakenOver: boolean;
  /** Pass C evidence from the page's own HTML and scripts. */
  staticSignals: WebmcpStaticSignals;
}

/** Does pass C show the page reaching for WebMCP at all? */
export function hasStaticEvidence(signals: WebmcpStaticSignals): boolean {
  return signals.imperative !== null || signals.polyfillPackages.length > 0;
}

/**
 * The verdict ladder, most specific first.
 *
 * `blocked` and `load-error` come first because neither says anything about
 * the site's WebMCP support - they say the capture never got to look. Below
 * them the ladder splits on whether tools were captured, and then on whether a
 * real browser would ever see them.
 */
export function deriveVerdict(facts: WebmcpPageFacts): WebmcpVerdict {
  if (facts.blocked) return "blocked";
  if (facts.loadError) return "load-error";

  if (facts.nativeToolCount !== null && facts.nativeToolCount > 0) return "active";

  if (facts.toolCount > 0) return "testing-only";

  // A native API that registered nothing is a different failure from a site
  // that never had one.
  if (facts.nativeToolCount === 0) return "api-empty";

  // API existence with an unavailable/rejected getTools() result is not proof
  // that the page registered zero tools. Keep it in the declared bucket rather
  // than converting an instrument limitation into a site failure.
  if (facts.nativeApi) return "declared-inactive";

  // A takeover means the page ships its own `modelContext` implementation.
  // That is a declaration of WebMCP usage even though our capture came back
  // empty, and reporting `absent` there would be a false negative.
  if (facts.shimTakenOver) return "declared-inactive";

  if (hasStaticEvidence(facts.staticSignals)) return "declared-inactive";

  return "absent";
}

/**
 * Page-level status for a verdict. Exported so the audit engine maps the
 * audit-level status from the same table instead of restating it.
 *
 * `stub-only` outranks `ok`: a page whose imperative tools all lack an
 * `execute` handler has registered a facade, and calling that "ok" would hide
 * the whole point of the audit. Declarative tools do not participate - their
 * execution is the browser submitting the form, so there is no stub axis.
 */
export function deriveStatus(verdict: WebmcpVerdict, tools: WebmcpTool[]): WebmcpAuditStatus {
  switch (verdict) {
    case "blocked":
      return "waf-blocked";
    case "load-error":
      return "unreachable";
    case "active":
    case "testing-only": {
      const imperative = tools.filter((tool) => tool.via === "imperative");
      if (imperative.length > 0 && imperative.every((tool) => !tool.hasExecute)) {
        return "stub-only";
      }
      return "ok";
    }
    case "api-empty":
    case "declared-inactive":
    case "absent":
      return "no-tools";
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}
