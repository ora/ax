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
// Which <script> elements a browser runs as JavaScript. Shared by the scanner's
// content-no-js shell evidence and the WebMCP static reader, so the two never
// disagree about what code a page executes.

/**
 * The `type` values a browser runs as classic or module JavaScript: absent or
 * empty, `module`, or a JavaScript MIME type essence (the WHATWG MIME Sniffing
 * list). HTML compares the whole trimmed value ASCII case-insensitively, so a
 * value with parameters (`text/javascript; charset=utf-8`) never runs. Anything
 * else (`text/plain`, `application/json`, a template type) is inert text a docs
 * page can fill with WebMCP code samples, so it is never read as a script.
 */
const JAVASCRIPT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

export function isJavaScriptScriptType(type: string | undefined): boolean {
  if (type === undefined) return true;
  const essence = type.trim().toLowerCase();
  return essence === "" || essence === "module" || JAVASCRIPT_MIME_TYPES.has(essence);
}
