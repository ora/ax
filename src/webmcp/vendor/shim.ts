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
import { WEBMCP_SHIM_VERSION } from "./checks";

/**
 * The WebMCP capture shim: a string of browser JavaScript injected as a
 * Playwright init script (`context.addInitScript({ content })`) so it runs
 * before any page script.
 *
 * It exists because sites feature-detect. A site only registers its WebMCP
 * tools when `navigator.modelContext` / `document.modelContext` already exist,
 * so a plain headless Chromium sees an empty page. The shim defines both entry
 * points ahead of the page, records every registration that flows through
 * them, and exposes the result at `window.__oraWebmcpCapture.snapshot()`.
 *
 * What the shim produces is a RAW, page-shaped record. Mapping it onto the
 * contract's `WebmcpTool` (see ./types.ts) is the capture service's
 * job - in particular `entryPoint` here is only ever `"navigator"` or
 * `"document"` (which global the page reached for), while `source` says
 * whether the tool arrived via `registerTool` or `provideContext`; the
 * contract's four-value `entryPoint` is derived from the pair.
 */

/** Tool entries stored per page. Registrations past this are counted in
 * `extraToolCount` but not stored. */
export const WEBMCP_MAX_TOOLS = 100;
/** Descriptions longer than this are stored truncated with
 * `descriptionTruncated: true`. */
export const WEBMCP_MAX_DESCRIPTION_CHARS = 4096;
/** A tool's `inputSchema` (or `annotations`) whose JSON form exceeds this is
 * stored as `{ __truncated: true }` instead. */
export const WEBMCP_MAX_SCHEMA_CHARS = 32768;
/** Cap on recorded registration errors, so a page looping on a bad
 * registration cannot grow the capture payload without bound. */
export const WEBMCP_MAX_REGISTRATION_ERRORS = 50;
/** Cap on `[toolname]` elements reported by `DECLARATIVE_SCAN_SNIPPET`. */
export const WEBMCP_MAX_DECLARATIVE_FORMS = 200;

/** Global the shim installs its results on, inside the captured page. */
export const WEBMCP_CAPTURE_GLOBAL = "__oraWebmcpCapture";

/** One tool as the shim records it, before the capture service maps it onto
 * the contract's `WebmcpTool`. */
export interface WebmcpShimToolRecord {
  name: string;
  description: string;
  descriptionTruncated: boolean;
  /** JSON-safe deep copy, or `{ __truncated: true }` past the size cap, or
   * `{ __unserializable: true }` when the page's value could not be copied. */
  inputSchema: unknown;
  annotations: unknown;
  hasExecute: boolean;
  entryPoint: "navigator" | "document";
  source: "registerTool" | "provideContext";
  registrationMs: number;
  /** Unregistered tools are marked, never removed - a tool that appeared and
   * then went away is evidence, not noise. */
  unregistered: boolean;
  unregisteredMs: number | null;
}

/** Return shape of `window.__oraWebmcpCapture.snapshot()`. */
export interface WebmcpShimSnapshot {
  shimVersion: string;
  tools: WebmcpShimToolRecord[];
  provideContextCalls: number;
  toolchangeEvents: number;
  registrationErrors: string[];
  /** Registration ATTEMPTS dropped once `WEBMCP_MAX_TOOLS` distinct tools were
   * stored - NOT a count of distinct tools we missed. One page loop can
   * re-register the same overflowing tool many times, so this must never be
   * rendered as "N tools missed"; treat any value above zero only as "the page
   * exceeded the capture cap". */
  extraToolCount: number;
  /** Entry points whose `modelContext` is no longer the shim's, either because
   * the page redefined the property or because installing it failed. A
   * non-empty value means the capture is INCOMPLETE for those entry points and
   * an empty `tools` list is not evidence of absence. Deliberately not a
   * `registrationErrors` entry: a page shipping its own polyfill is not a
   * stability defect. */
  takenOver: Array<"navigator" | "document">;
}

/** One declarative `[toolname]` element as `DECLARATIVE_SCAN_SNIPPET` reports it. */
export interface WebmcpShimDeclarativeForm {
  toolName: string;
  toolDescription: string;
  action: string;
  method: string;
  fieldCount: number;
}

export interface WebmcpShimDeclarativeScan {
  forms: WebmcpShimDeclarativeForm[];
}

/**
 * Injected before any page script. Written as ES5-in-a-string on purpose: it
 * runs in whatever Chromium the worker ships and must never be transpiled or
 * bundled. Keep it free of backticks and `${` so the template literal below
 * stays literal.
 */
export const WEBMCP_CAPTURE_SHIM = `(function () {
  "use strict";
  try {
    var W = typeof globalThis !== "undefined" ? globalThis : window;
    if (W.${WEBMCP_CAPTURE_GLOBAL}) return;

    var SHIM_VERSION = ${JSON.stringify(WEBMCP_SHIM_VERSION)};
    var MAX_TOOLS = ${WEBMCP_MAX_TOOLS};
    var MAX_DESCRIPTION_CHARS = ${WEBMCP_MAX_DESCRIPTION_CHARS};
    var MAX_SCHEMA_CHARS = ${WEBMCP_MAX_SCHEMA_CHARS};
    var MAX_ERRORS = ${WEBMCP_MAX_REGISTRATION_ERRORS};
    // Internal bound only: a page looping on addEventListener must not grow
    // the shim's retained set without limit.
    var MAX_LISTENERS = 50;

    // Natives are pinned at install time, while they are still pristine: this
    // script runs before any page script, so everything captured here is the
    // real implementation. Resolving them at call time instead would let a page
    // swap performance.now (forging registrationMs, which feeds the
    // registration-timing check), JSON (forging schemas), Array.isArray
    // (steering provideContext), or Object.getOwnPropertyDescriptor (hiding a
    // takeover) after the fact.
    var nativeDefineProperty = Object.defineProperty;
    var nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    var nativeObjectCreate = Object.create;
    var nativeIsArray = Array.isArray;
    var nativeStringify = JSON.stringify;
    var nativeParse = JSON.parse;
    var nativeString = String;
    var nativeTypeError = TypeError;
    var nativeDateNow = Date.now;
    var nativePromise = typeof Promise === "function" ? Promise : null;
    var nativePerformanceNow = null;
    try {
      if (W.performance && typeof W.performance.now === "function") {
        nativePerformanceNow = W.performance.now.bind(W.performance);
      }
    } catch (e) {
      // A hostile performance getter cannot be pinned; the Date fallback holds.
    }
    // The serialized origin getTools() reports on every RegisteredTool.
    // Pinned at install like the natives: location is unforgeable in a
    // browser and this script runs before any page script, so the value read
    // here is the document's real origin. Empty on any failure (the vm test
    // sandbox has no location; an exotic environment may throw) - a degraded
    // origin must never break the page.
    var pinnedOrigin = "";
    try {
      if (W.location && typeof W.location.origin === "string") {
        pinnedOrigin = W.location.origin;
      }
    } catch (e) {
      // Expected: an exotic location getter. The "" default stands.
    }

    var entries = [];
    var byKey = nativeObjectCreate(null);
    var listenersByType = nativeObjectCreate(null);
    var errors = [];
    var provideContextCalls = 0;
    var toolchangeEvents = 0;
    var extraToolCount = 0;
    var nextRegId = 1;

    function now() {
      if (nativePerformanceNow) return nativePerformanceNow();
      return nativeDateNow();
    }

    // Never throws, whatever the page put in the value: a description, an
    // error message, or an event type can all carry a throwing toString.
    function safeText(value, fallback) {
      try {
        return nativeString(value);
      } catch (e) {
        return fallback;
      }
    }

    function describeError(value) {
      var message;
      try {
        message = value ? value.message : undefined;
      } catch (e) {
        // A thrown object with a throwing message getter.
        message = undefined;
      }
      if (message !== undefined && message !== null) {
        return safeText(message, "unreadable error message");
      }
      return safeText(value, "unreadable error");
    }

    function recordError(message) {
      if (errors.length >= MAX_ERRORS) return;
      errors.push(
        safeText(message, "unstringifiable registration error").slice(0, 500)
      );
    }

    // Cycle-safe: tracks the ANCESTOR chain (via the replacer's holder), not
    // every object seen, so a schema that reuses one sub-schema in two places
    // still serializes both copies instead of reporting a false cycle.
    function cycleSafeStringify(value) {
      var stack = [];
      return nativeStringify(value, function (key, val) {
        if (typeof val === "function") return undefined;
        if (val && typeof val === "object") {
          while (stack.length > 0 && stack[stack.length - 1] !== this) stack.pop();
          if (stack.indexOf(val) !== -1) return "[Circular]";
          stack.push(val);
        }
        return val;
      });
    }

    function safeCopy(value, maxChars) {
      if (value === undefined || value === null) return null;
      var json;
      try {
        json = cycleSafeStringify(value);
      } catch (e) {
        // Throwing getters, BigInt, or a structure too deep for JSON.stringify.
        return { __unserializable: true };
      }
      if (typeof json !== "string") return null;
      if (json.length > maxChars) return { __truncated: true };
      try {
        return nativeParse(json);
      } catch (e) {
        // Should not happen: nativeParse is the pinned native, and its input is
        // this shim's own output. Kept so a copy failure never breaks a page.
        return { __unserializable: true };
      }
    }

    function readProp(source, key) {
      try {
        return source[key];
      } catch (e) {
        // Property access on a page object can throw from a getter.
        return undefined;
      }
    }

    function hasExecute(tool) {
      return (
        typeof readProp(tool, "execute") === "function" ||
        typeof readProp(tool, "callback") === "function"
      );
    }

    function markUnregistered(record, regId) {
      if (!record || record.regId !== regId || record.unregistered) return;
      record.unregistered = true;
      record.unregisteredMs = now();
    }

    // Registers or refreshes ONE tool. Entries are keyed by source + name, so
    // a re-registration updates in place and keeps its first registrationMs -
    // the timing checks want when the tool first appeared, and a page that
    // re-provides its set on every state change must not exhaust MAX_TOOLS.
    function upsert(tool, source, entryPoint) {
      var name = readProp(tool, "name");
      if (typeof name !== "string" || name.trim() === "") {
        var error = new nativeTypeError(
          "WebMCP registration rejected: tool name must be a non-empty string"
        );
        recordError(error.message);
        throw error;
      }

      // A name collision is a name collision whatever registered it: two live
      // tools called "search" are ambiguous to an agent even when one came
      // from registerTool and the other from provideContext. Both entries are
      // kept; the warning is the evidence.
      for (var d = 0; d < entries.length; d++) {
        if (entries[d].name === name && !entries[d].unregistered) {
          recordError("duplicate tool name registered: " + name);
          break;
        }
      }

      // A throwing toString must not drop the tool: record the defect and keep
      // the registration, since an unreadable description is exactly what the
      // description-quality check exists to see.
      var description = "";
      var rawDescription = readProp(tool, "description");
      if (rawDescription !== undefined && rawDescription !== null) {
        if (typeof rawDescription === "string") {
          description = rawDescription;
        } else {
          try {
            description = nativeString(rawDescription);
          } catch (e) {
            recordError(
              "tool " + name + " has a description that could not be read as text"
            );
          }
        }
      }
      var descriptionTruncated = description.length > MAX_DESCRIPTION_CHARS;
      if (descriptionTruncated) description = description.slice(0, MAX_DESCRIPTION_CHARS);

      var record = byKey[source + ":" + name];
      if (!record) {
        if (entries.length >= MAX_TOOLS) {
          extraToolCount++;
          return null;
        }
        record = { name: name, registrationMs: now() };
        entries.push(record);
        byKey[source + ":" + name] = record;
      }

      record.description = description;
      record.descriptionTruncated = descriptionTruncated;
      record.inputSchema = safeCopy(readProp(tool, "inputSchema"), MAX_SCHEMA_CHARS);
      record.annotations = safeCopy(readProp(tool, "annotations"), MAX_SCHEMA_CHARS);
      record.hasExecute = hasExecute(tool);
      record.entryPoint = entryPoint;
      record.source = source;
      record.unregistered = false;
      record.unregisteredMs = null;
      record.regId = nextRegId++;
      return record;
    }

    // The spec's unregistration path is the AbortSignal in options; the
    // tool-carried fallback observes pages that put the signal on the tool
    // object instead.
    function resolveSignal(tool, options) {
      var signal = readProp(options, "signal");
      if (!signal) signal = readProp(tool, "signal");
      return signal || null;
    }

    // Callers with an already-aborted signal never reach here: registerTool
    // rejects those before any record exists.
    function wireAbort(signal, record, regId) {
      if (!signal || typeof readProp(signal, "addEventListener") !== "function") return;
      try {
        signal.addEventListener("abort", function () {
          markUnregistered(record, regId);
        });
      } catch (e) {
        // A signal-like object that is not a real AbortSignal: capture is
        // best-effort here and must never break the page's registration.
      }
    }

    // The draft's registerTool returns a Promise, and legacy pages hold the
    // return value for its unregister method - so the shim returns a settled
    // promise CARRYING unregister, serving both shapes at once (the agent
    // invoke shim does the same). The internal catch marks the rejected path
    // handled, so a page that ignores the return value produces no unhandled
    // rejection from our shim.
    function registration(settledPromise, unregister) {
      settledPromise.catch(function () {});
      settledPromise.unregister = unregister;
      return settledPromise;
    }

    function noop() {}

    function registerTool(tool, options, entryPoint) {
      var signal = resolveSignal(tool, options);
      if (signal && readProp(signal, "aborted") === true) {
        // Already aborted at register time: the registration never lands, and
        // per the draft the promise rejects with the abort reason.
        var reason = readProp(signal, "reason");
        if (!nativePromise) return { unregister: noop };
        return registration(
          nativePromise.reject(
            reason === undefined
              ? new nativeTypeError("registration signal already aborted")
              : reason
          ),
          noop
        );
      }
      var record = upsert(tool, "registerTool", entryPoint);
      var regId = record ? record.regId : -1;
      wireAbort(signal, record, regId);
      // A capped registration (record null) still resolves: the page did
      // nothing wrong, the shim just stopped recording past MAX_TOOLS.
      var unregister = record
        ? function () { markUnregistered(record, regId); }
        : noop;
      if (!nativePromise) return { unregister: unregister };
      return registration(nativePromise.resolve(undefined), unregister);
    }

    function provideContext(context, entryPoint) {
      provideContextCalls++;
      var tools = readProp(context, "tools");
      if (tools === undefined || tools === null) tools = [];
      if (!nativeIsArray(tools)) {
        recordError("provideContext called with a non-array tools value");
        tools = [];
      }

      // Replacement semantics apply to the provideContext-sourced set only:
      // mark it superseded BEFORE the new set lands, so re-providing a tool
      // reactivates its entry instead of reading as a duplicate registration,
      // and registerTool-sourced tools are left alone.
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].source === "provideContext") {
          markUnregistered(entries[i], entries[i].regId);
        }
      }

      for (var j = 0; j < tools.length; j++) {
        var errorsBefore = errors.length;
        try {
          upsert(tools[j], "provideContext", entryPoint);
        } catch (e) {
          // One invalid tool must not drop the rest of the provided set, but
          // it must never vanish silently either: upsert records the reason
          // for the failures it raises itself, and anything else that escaped
          // (a throwing getter on the tool object) is recorded here.
          if (errors.length === errorsBefore) {
            recordError(
              "provideContext tool at index " + j + " failed to register: " +
                describeError(e)
            );
          }
        }
      }
      return nativePromise ? nativePromise.resolve() : undefined;
    }

    // A stored inputSchema/annotations value as getTools() may hand it to
    // page code. Absence is undefined (the draft: "undefined if none was
    // registered"), and so are this shim's own {__truncated} and
    // {__unserializable} markers - they are instrument internals, and handing
    // a page an object it never wrote would leak how the capture works. A
    // real stored value is re-copied on EVERY call: snapshot() shares the
    // stored references, so returning them here would let the page mutate the
    // registry record and rewrite what a later snapshot reports.
    function projectStoredValue(value) {
      if (value === null || value === undefined) return undefined;
      if (value.__truncated === true || value.__unserializable === true) {
        return undefined;
      }
      return safeCopy(value, MAX_SCHEMA_CHARS);
    }

    // The draft's RegisteredTool list (section 4.5): the CURRENT tool map,
    // sorted ascending by name in code-unit order. Unregistered records are
    // audit evidence, not live tools, so they are filtered; a name live under
    // both sources is returned twice rather than deduped (the real map could
    // never hold both, but picking a winner here would invent one). title
    // is "" because the shim does not record it yet (Stage 2, with the
    // title-present check) and "" is what Chrome currently reports for a
    // missing title (spec issue 224 is unresolved).
    function getToolsList() {
      var list = [];
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.unregistered) continue;
        list.push({
          name: entry.name,
          title: "",
          description: entry.description,
          inputSchema: projectStoredValue(entry.inputSchema),
          annotations: projectStoredValue(entry.annotations),
          window: W,
          origin: pinnedOrigin
        });
      }
      // String < / > IS code-unit comparison, which is the draft's order.
      // sort is deliberately not pinned: pinning protects capture integrity,
      // and a page sabotaging its own getTools() result harms only itself -
      // the same reasoning as the unpinned push/indexOf/splice above.
      list.sort(function (a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
      return list;
    }

    // The read half of the draft's API, and the reason it exists here is a
    // bug this shim caused: a page's own polyfill correctly stands down when
    // document.modelContext already exists (this shim IS that object), and a
    // page that then awaits getTools() before registering threw on the
    // missing method, killing its whole registration path while the audit
    // blamed the site. Observed on the Le Petit Bistro demo in Google's
    // webmcp-tools repo: its DEFAULT surface is the declarative form, and its
    // imperative path (behind the imperative query param) awaits
    // document.modelContext.getTools() before registerTool - the shape that
    // died under capture.
    //
    // Divergences from the draft, each deliberate: options.fromOrigins is
    // accepted and ignored (this registry only ever holds same-document
    // tools, so the cross-origin filter has nothing to do), and none of the
    // draft's error conditions (InvalidStateError, NotAllowedError,
    // SecurityError) are raised - the shim cannot evaluate permissions
    // policy, and its prime directive is to never break the page, so this
    // function must never throw.
    function getTools() {
      var list;
      try {
        list = getToolsList();
      } catch (e) {
        list = [];
      }
      // The provideContext fallback convention, not registerTool's: that
      // bare-object shape exists to carry .unregister, and getTools carries
      // nothing. A page that awaits necessarily runs where Promise existed
      // at install, so the sync-array arm only ever serves callers that
      // treat the return value as data.
      return nativePromise ? nativePromise.resolve(list) : list;
    }

    function addEventListener(type, listener) {
      if (typeof listener !== "function") return;
      var key = safeText(type, "");
      var list = listenersByType[key];
      if (!list) {
        list = [];
        listenersByType[key] = list;
      }
      if (list.length < MAX_LISTENERS) list.push(listener);
    }

    function removeEventListener(type, listener) {
      var list = listenersByType[safeText(type, "")];
      if (!list) return;
      var index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    }

    function dispatchEvent(event) {
      var rawType = readProp(event, "type");
      var type = safeText(
        rawType === undefined || rawType === null ? event : rawType,
        ""
      );
      if (type === "toolchange") toolchangeEvents++;

      var list = listenersByType[type];
      if (list) {
        for (var i = 0; i < list.length; i++) {
          try {
            list[i](event);
          } catch (e) {
            recordError("listener for " + type + " threw: " + describeError(e));
          }
        }
      }
      return true;
    }

    // Two distinct delegate objects over one registry, so we can tell which
    // global the page reached for.
    function createDelegate(entryPoint) {
      // executeTool is deliberately ABSENT, not stubbed: the live tool
      // objects and their execute handlers are structurally dropped (the
      // audit's no-invoke property), so any stub would be a permanent
      // rejector - and a page feature-detecting executeTool would then build
      // its agent path on infrastructure that always fails, which is worse
      // than honest absence. Stage 2's invoke work owns the real thing.
      // Stage 2 also: count getTools calls as an in-page-agent signal (needs
      // snapshot-shape, capture-server and consumer updates).
      return {
        registerTool: function (tool, options) {
          return registerTool(tool, options, entryPoint);
        },
        provideContext: function (context) {
          return provideContext(context, entryPoint);
        },
        getTools: getTools,
        addEventListener: addEventListener,
        removeEventListener: removeEventListener,
        dispatchEvent: dispatchEvent
      };
    }

    // Every entry point we installed on, so snapshot() can prove the shim is
    // still the one answering. The getter is null when the install itself failed.
    var installs = [];

    function install(target, delegate, label) {
      if (!target) return;
      var getter = function () {
        return delegate;
      };
      try {
        nativeDefineProperty(target, "modelContext", {
          // Deliberately configurable: making it non-configurable would give a
          // legitimate polyfill a page-visible TypeError. A page CAN therefore
          // redefine the property and take the entry point away from us, which
          // is what detectTakeovers reports.
          configurable: true,
          enumerable: true,
          get: getter,
          set: function () {
            // A page polyfill assigning its own implementation over the shim
            // would blind the capture and produce a false "absent" verdict.
            // The assignment is accepted silently and ignored: feature
            // detection still passes and registrations through the global
            // still land here.
          }
        });
        installs.push({ target: target, getter: getter, label: label });
      } catch (e) {
        recordError("could not install shim on " + label + ": " + describeError(e));
        installs.push({ target: target, getter: null, label: label });
      }
    }

    // Rechecked at snapshot time, not at install time: a page script can
    // redefine the property at any point after we run, and an empty tools list
    // must not be reported as absence when that happened.
    function detectTakeovers() {
      var taken = [];
      for (var i = 0; i < installs.length; i++) {
        var descriptor;
        try {
          descriptor = nativeGetOwnPropertyDescriptor(
            installs[i].target,
            "modelContext"
          );
        } catch (e) {
          // An exotic target that refuses introspection counts as taken over.
          descriptor = undefined;
        }
        if (!descriptor || descriptor.get !== installs[i].getter) {
          taken.push(installs[i].label);
        }
      }
      return taken;
    }

    install(W.navigator, createDelegate("navigator"), "navigator");
    install(W.document, createDelegate("document"), "document");

    function snapshot() {
      var tools = [];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        tools.push({
          name: e.name,
          description: e.description,
          descriptionTruncated: e.descriptionTruncated,
          inputSchema: e.inputSchema,
          annotations: e.annotations,
          hasExecute: e.hasExecute,
          entryPoint: e.entryPoint,
          source: e.source,
          registrationMs: e.registrationMs,
          unregistered: e.unregistered,
          unregisteredMs: e.unregisteredMs
        });
      }
      return {
        shimVersion: SHIM_VERSION,
        tools: tools,
        provideContextCalls: provideContextCalls,
        toolchangeEvents: toolchangeEvents,
        registrationErrors: errors.slice(),
        extraToolCount: extraToolCount,
        takenOver: detectTakeovers()
      };
    }

    // Non-writable and non-configurable: the capture payload is the audit's
    // evidence, so a page must not be able to replace snapshot() and report
    // whatever tools it wishes it had.
    nativeDefineProperty(W, ${JSON.stringify(WEBMCP_CAPTURE_GLOBAL)}, {
      value: {
        shimVersion: SHIM_VERSION,
        installedAt: now(),
        snapshot: snapshot
      },
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (installError) {
    try {
      console.warn("[ora-webmcp-shim] install failed", installError);
    } catch (loggingError) {
      // Nothing left to report to; never let the shim break the page.
    }
  }
})();`;

/**
 * Evaluated by the capture service after load (`page.evaluate(SNIPPET)`), not
 * injected. Reports the declarative WebMCP surface: elements carrying a
 * `toolname` attribute, which is how a page declares a tool without touching
 * the imperative API.
 *
 * Kept as a bare expression with no trailing semicolon so it evaluates the
 * same whether the caller `eval`s it or wraps it in parentheses.
 */
export const DECLARATIVE_SCAN_SNIPPET = `(function () {
  var MAX_FORMS = ${WEBMCP_MAX_DECLARATIVE_FORMS};
  var MAX_DESCRIPTION_CHARS = ${WEBMCP_MAX_DESCRIPTION_CHARS};
  var forms = [];
  var nodes = document.querySelectorAll("form[toolname]");
  for (var i = 0; i < nodes.length && forms.length < MAX_FORMS; i++) {
    var node = nodes[i];
    var description = node.getAttribute("tooldescription") || "";
    var toolName = node.getAttribute("toolname") || "";
    if (!toolName.trim()) continue;
    forms.push({
      toolName: toolName,
      toolDescription: description.slice(0, MAX_DESCRIPTION_CHARS),
      action: node.getAttribute("action") || "",
      method: (node.getAttribute("method") || "get").toLowerCase(),
      fieldCount: node.querySelectorAll("input, select, textarea").length
    });
  }
  return { forms: forms };
})()`;

export { WEBMCP_SHIM_VERSION };
