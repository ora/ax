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
// One deviation, marked inline: `collectStaticSignals` takes its inline JS
// as a parameter instead of parsing HTML, and the helpers that need an HTML
// parser (cheerio or htmlparser2), none of which the capture path calls, are
// removed along with the private state only they use.
//
import type { WebmcpStaticSignals } from "./types";

// ---------------------------------------------------------------------------
// WebMCP static-evidence helpers, shared by the scanner's `webmcp` check
// (the scanner's own layer) and the WebMCP audit capture
// service. Pure text/HTML analysis only - no network I/O.
// ---------------------------------------------------------------------------

/**
 * An imperative WebMCP usage marker found in JS source.
 *
 * `deprecatedAliasOnly` is true when the source only reaches the API through
 * `navigator.modelContext` - the pre-May-2026 alias that Chrome 150+
 * deprecates in favour of `document.modelContext`. It still earns the pass
 * (the API works), but the details carry a migration note.
 */
export interface WebmcpScriptSignal {
  marker: string;
  deprecatedAliasOnly: boolean;
  removedApiOnly: boolean;
}

export const WEBMCP_POLYFILL_PACKAGES = ["@mcp-b/global", "@mcp-b/react-webmcp", "usewebmcp"];

/**
 * Scans JS source (inline script bodies or fetched bundles) for imperative
 * WebMCP usage: the `document.modelContext` entry point, the deprecated
 * `navigator.modelContext` alias, a bare `modelContext.registerTool()` call
 * shape (minifiers often hoist the entry point into a variable), a
 * `.modelContext` read plus a `.registerTool(` call (a helper that is passed
 * `document` or `navigator`), the removed `provideContext()` API, or an MCP-B
 * polyfill package signature.
 */
export function findWebmcpScriptSignal(source: string): WebmcpScriptSignal | null {
  const lower = source.toLowerCase();
  const hasDocumentEntry = /document\.modelcontext\b/.test(lower);
  const hasNavigatorEntry = /navigator\.modelcontext\b/.test(lower);
  const hasRegisterCall =
    /modelcontext\??\.registertool/.test(lower) ||
    ((hasDocumentEntry || hasNavigatorEntry || /\.modelcontext\b/.test(lower)) && /\.registertool\s*\(/.test(lower));
  const hasProvideContextCall = /modelcontext\??\.providecontext/.test(lower);
  const polyfill = WEBMCP_POLYFILL_PACKAGES.find((pkg) => lower.includes(pkg));
  if (!hasRegisterCall && !hasProvideContextCall && !polyfill) return null;
  const marker = hasRegisterCall
    ? hasDocumentEntry
      ? "document.modelContext.registerTool"
      : hasNavigatorEntry
        ? "navigator.modelContext.registerTool"
        : "modelContext.registerTool"
    : hasProvideContextCall
      ? "modelContext.provideContext"
      : `${polyfill} package`;
  return {
    marker,
    deprecatedAliasOnly: hasRegisterCall && hasNavigatorEntry && !hasDocumentEntry,
    removedApiOnly: !hasRegisterCall && hasProvideContextCall,
  };
}

// shortcut: the audit precheck samples the first 8 bundles and treats a partial read as inconclusive;
// the scanner check passes its own larger cap (the engine's script-bundles module) because it may not call a partial read absent.
const MAX_WEBMCP_SCRIPT_FETCHES = 8;

export interface SameOriginScriptUrls {
  urls: string[];
  /** How many distinct same-origin bundles the HTML links to, before the cap. */
  totalCount: number;
  /** Counting stopped one past the cap, so `totalCount` is a floor rather than the exact count. */
  countIsFloor?: boolean;
}

export interface WebmcpScriptSource {
  readonly url: string;
  readonly body: string;
}

// No real bundle URL comes near this; a longer src would be fetched, logged and echoed into check details.
const MAX_SCRIPT_SRC_CHARS = 2_048;

function sameOriginScriptTarget(src: string, base: URL): URL | null {
  if (src.length > MAX_SCRIPT_SRC_CHARS) return null;
  let resolved: URL;
  try {
    resolved = new URL(src, base);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  const fetchable = resolved.protocol === "https:" || resolved.protocol === "http:";
  return fetchable && resolved.host === base.host ? resolved : null;
}

// REMOVED IN THE ax COPY: `sameOriginScriptUrl`, `sameOriginScriptUrls`,
// `webmcpPageFromDom`, `scanWebmcpPage` (with `WebmcpPageEvidence` and the
// `RAW_TEXT_ENDS` / `KEPT_ATTRIBUTES` / `rawTextEnd` reader state it alone
// uses) and `countDeclarativeToolForms`. Each one reads HTML through cheerio or
// htmlparser2, or exists only to serve one that does, and none is on the
// capture path - ora calls them from surfaces this CLI does not run. Dropping
// them is what keeps an HTML parser out of a zero-dependency binary. Nothing
// else in this file differs except `collectStaticSignals`' second parameter.

// One-hop only: this closes the code-split registration gap without turning
// static detection into a general dependency-graph crawler over hostile JS.
const MAX_WEBMCP_DYNAMIC_SCRIPT_FETCHES = 4;
const QUOTED_SCRIPT_REFERENCE = /(["'`])([^"'`\r\n]{1,1024})\1/g;

// A raw reference can only resolve to a kept chunk if it names webmcp and a .js or .mjs file; only those are parsed,
// at most this many per call, since the function keeps five.
export const MAX_REFERENCE_PARSES = 4_096;
const SCRIPT_REFERENCE_SUFFIX = /\.m?js(?:[?#]|\s*$)/i;

/** Stops one reference past the cap: the caller only needs to know that more existed than it will read. */
export function sameOriginWebmcpChunkUrls(
  sources: readonly WebmcpScriptSource[],
  alreadySeenUrls: readonly string[] = [],
): SameOriginScriptUrls {
  const seen = new Set(alreadySeenUrls);
  const urls: string[] = [];
  let parsesLeft = MAX_REFERENCE_PARSES;
  let unparsed = false;
  const collect = (): void => {
    for (const source of sources) {
      let base: URL;
      try {
        base = new URL(source.url);
      } catch (error) {
        if (error instanceof TypeError) continue;
        throw error;
      }
      const parsed = new Set<string>();
      for (const match of source.body.matchAll(QUOTED_SCRIPT_REFERENCE)) {
        const reference = match[2];
        if (!reference || parsed.has(reference) || reference.includes("${")) continue;
        if (!reference.toLowerCase().includes("webmcp") || !SCRIPT_REFERENCE_SUFFIX.test(reference)) continue;
        if (parsesLeft === 0) {
          unparsed = true;
          return;
        }
        parsesLeft--;
        parsed.add(reference);
        const resolved = sameOriginScriptTarget(reference, base);
        if (!resolved || resolved.origin !== base.origin || !isWebmcpScriptPath(resolved.pathname)) continue;
        const url = resolved.toString();
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
        if (urls.length > MAX_WEBMCP_DYNAMIC_SCRIPT_FETCHES) return;
      }
    }
  };
  collect();
  const overflow = unparsed || urls.length > MAX_WEBMCP_DYNAMIC_SCRIPT_FETCHES;
  return {
    urls: urls.slice(0, MAX_WEBMCP_DYNAMIC_SCRIPT_FETCHES),
    totalCount: unparsed ? Math.min(urls.length, MAX_WEBMCP_DYNAMIC_SCRIPT_FETCHES) + 1 : urls.length,
    countIsFloor: overflow,
  };
}

function isWebmcpScriptPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return lower.includes("webmcp") && /\.m?js$/.test(lower);
}

export { isJavaScriptScriptType } from "./script-type";

// (See REMOVED IN THE ax COPY above.)

// An inline script that mentions modelContext and adds a script by URL
// (`s.src = "..."`, `import("...")`): follow it, whatever its extension.
const MAX_WEBMCP_LOADER_SCRIPT_FETCHES = 4;
const LOADER_SCRIPT_REFERENCE = /(?:\.src\s*=\s*|import\(\s*)(["'`])([^"'`\r\n]{1,1024})\1/g;

export function sameOriginLoaderScriptUrls(
  inlineScripts: readonly string[],
  pageUrl: string,
  alreadySeenUrls: readonly string[] = [],
): SameOriginScriptUrls {
  const base = new URL(pageUrl);
  const seen = new Set(alreadySeenUrls);
  const urls: string[] = [];
  for (const script of inlineScripts) {
    if (!/modelcontext/i.test(script)) continue;
    for (const match of script.matchAll(LOADER_SCRIPT_REFERENCE)) {
      const reference = match[2].replace(/\\\//g, "/");
      if (reference.includes("${") || !URL.canParse(reference, base)) continue;
      const resolved = new URL(reference, base);
      const isPlainHttp = (resolved.protocol === "https:" || resolved.protocol === "http:") && !resolved.username && !resolved.password;
      if (!isPlainHttp || resolved.origin !== base.origin || seen.has(resolved.toString())) continue;
      seen.add(resolved.toString());
      urls.push(resolved.toString());
    }
  }
  return {
    urls: urls.slice(0, MAX_WEBMCP_LOADER_SCRIPT_FETCHES),
    totalCount: urls.length,
  };
}

// (See REMOVED IN THE ax COPY above.)

const WEBMCP_KEYWORD_PATTERNS = ["webmcp", "web model context protocol"];

/** Does `text` mention WebMCP by name, without necessarily implementing it. */
function mentionsWebmcpKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return WEBMCP_KEYWORD_PATTERNS.some((kw) => lower.includes(kw));
}

/**
 * Composes the static-evidence helpers above into one `WebmcpStaticSignals`
 * result: the strongest imperative-usage marker found across the homepage's
 * inline scripts and any already-fetched same-origin script bundles, every
 * polyfill package signature seen, and whether WebMCP is mentioned by name
 * anywhere in the homepage HTML or those scripts.
 *
 * DEVIATION FROM ora'S COPY: ora derives `inlineJs` here, loading `html` into an
 * HTML parser and reading `script:not([src])` filtered by
 * `isJavaScriptScriptType` on each element's `type`. This copy takes it as a
 * parameter so the caller can read the same selector off the live DOM over CDP,
 * which is the only reason this file needs no parser. The selector, the
 * `isJavaScriptScriptType` filter (re-exported above for the caller) and the
 * join are identical; the DOM it runs against is the one the browser already
 * parsed, rather than a re-parse of that DOM's serialization. Everything
 * downstream of this line is ora's logic unchanged.
 */
export function collectStaticSignals(
  html: string,
  inlineJs: string,
  sameOriginScripts: readonly WebmcpScriptSource[],
): WebmcpStaticSignals {

  const scriptSources = [inlineJs, ...sameOriginScripts.map((s) => s.body)];

  // The marker is derived over ALL sources at once, not the first source with
  // any signal: an inline legacy snippet reaching navigator.modelContext must
  // not report deprecatedAliasOnly when the main bundle uses the canonical
  // document.modelContext entry point.
  const imperative = findWebmcpScriptSignal(scriptSources.join("\n"));
  const polyfillPackages = new Set<string>();
  for (const source of scriptSources) {
    const lower = source.toLowerCase();
    for (const pkg of WEBMCP_POLYFILL_PACKAGES) {
      if (lower.includes(pkg)) polyfillPackages.add(pkg);
    }
  }

  const keywordMention = mentionsWebmcpKeyword(html) || scriptSources.some(mentionsWebmcpKeyword);

  return {
    imperative,
    polyfillPackages: [...polyfillPackages],
    keywordMention,
  };
}
