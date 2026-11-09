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
import {
  WEBMCP_MAX_DECLARATIVE_FIELDS,
  WEBMCP_MAX_DECLARATIVE_FORMS,
  WEBMCP_MAX_DECLARATIVE_PAGE_FIELDS,
  WEBMCP_MAX_DECLARATIVE_PAGE_OPTIONS,
  WEBMCP_MAX_DECLARATIVE_TEXT,
  WEBMCP_MAX_SCHEMA_CHARS,
  type WebmcpShimDeclarativeField,
  type WebmcpShimDeclarativeForm,
} from "./shim";

type JsonSchema = Record<string, unknown>;
type PendingPatterns = Array<[JsonSchema, string]>;

const EXCLUDED_INPUT_TYPES = new Set(["hidden", "file", "submit", "image", "reset", "button"]);
const PATTERN_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password"]);
const DATE_HINT = "Dates MUST be provided in 'YYYY-MM-DD' format.";
// Chrome 151 puts these regexes under `format`, not `pattern`; copied verbatim from its getTools() output.
const FORMAT_BY_INPUT_TYPE = new Map([
  ["time", "^([01][0-9]|2[0-3]):[0-5][0-9]$"],
  ["month", "^[0-9]{4}-(0[1-9]|1[0-2])$"],
  ["week", "^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$"],
  ["datetime-local", "^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$"],
  ["color", "^#[0-9a-zA-Z]{6}$"],
]);
const HTML_FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const STEP_TOLERANCE = 1e-9;
const PATTERN_KEY_CHARS = ',"pattern":'.length;
// Costliest shape measured: (?i:\p{RGI_Emoji}...) at about 100 ms per 1,000 characters (bare plus anchored), so this
// holds a page to about 0.6 s of synchronous compile on the shared capture worker; real pages carry under 50.
export const WEBMCP_MAX_PAGE_PATTERN_CHARS = 6_000;

interface PatternBudget {
  charsLeft: number;
}

/** The HTML "valid floating-point number" grammar, which is what Chrome accepts for min, max, step and value. */
export function parseHtmlFloat(value: string | null): number | null {
  if (value === null || !HTML_FLOAT.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One schema per form, with the scan's form, field and option caps applied again here: page scripts can
 * override the built-ins the in-page caps rely on. */
export function declarativeInputSchemas(forms: readonly WebmcpShimDeclarativeForm[]): JsonSchema[] {
  let fieldsLeft = WEBMCP_MAX_DECLARATIVE_PAGE_FIELDS;
  let optionsLeft = WEBMCP_MAX_DECLARATIVE_PAGE_OPTIONS;
  const patterns: PatternBudget = { charsLeft: WEBMCP_MAX_PAGE_PATTERN_CHARS };
  return forms.slice(0, WEBMCP_MAX_DECLARATIVE_FORMS).map((form) => {
    const fields: unknown[] = Array.isArray(form.fields) ? form.fields : [];
    const options = fields.reduce<number>(
      (sum, field) => sum + (isRecord(field) && Array.isArray(field.options) ? field.options.length : 0),
      0,
    );
    const withinCaps =
      fields.length <= WEBMCP_MAX_DECLARATIVE_FIELDS && fields.length <= fieldsLeft && options <= optionsLeft;
    fieldsLeft -= Math.min(fields.length, fieldsLeft);
    optionsLeft -= Math.min(options, optionsLeft);
    return withinCaps ? declarativeInputSchema(form, patterns) : { __truncated: true };
  });
}

/** The input schema Chrome 151 synthesizes from a declarative `[toolname]` form, a Chrome preview the WebMCP spec does
 * not define. A form the scan could not read in full is `{ __truncated: true }`. */
export function declarativeInputSchema(
  form: Pick<WebmcpShimDeclarativeForm, "fields" | "fieldsTruncated">,
  patterns: PatternBudget,
): JsonSchema {
  if (!Array.isArray(form.fields) || form.fieldsTruncated !== false) return { __truncated: true };

  const groups = new Map<string, WebmcpShimDeclarativeField[]>();
  for (const field of form.fields) {
    if (!isFieldRecord(field) || !isAgentFillable(field)) continue;
    const group = groups.get(field.name);
    if (group) group.push(field);
    else groups.set(field.name, [field]);
  }

  const properties: Array<[string, JsonSchema]> = [];
  const required: string[] = [];
  const pendingPatterns: PendingPatterns = [];
  for (const [name, group] of groups) {
    const schema = groupSchema(group, pendingPatterns);
    if (!schema) continue;
    properties.push([name, schema]);
    if (group.some((field) => field.required === true)) required.push(name);
  }

  const schema = { type: "object", properties: Object.fromEntries(properties), required };
  const withEveryPattern = pendingPatterns.reduce(
    (size, [, pattern]) => size + PATTERN_KEY_CHARS + JSON.stringify(pattern).length,
    JSON.stringify(schema).length,
  );
  if (withEveryPattern > WEBMCP_MAX_SCHEMA_CHARS) return { __truncated: true };
  const compiled = pendingPatterns.filter(([, pattern]) => pattern.length <= WEBMCP_MAX_DECLARATIVE_TEXT);
  const compileChars = compiled.reduce((sum, [, pattern]) => sum + pattern.length, 0);
  if (compileChars > patterns.charsLeft) return { __truncated: true };
  patterns.charsLeft -= compileChars;
  for (const [property, pattern] of compiled) {
    if (compilesAsHtmlPattern(pattern)) property.pattern = pattern;
  }
  return schema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldRecord(value: unknown): value is WebmcpShimDeclarativeField {
  return (
    isRecord(value) &&
    (value.tag === "input" || value.tag === "select" || value.tag === "textarea") &&
    typeof value.type === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.labels) &&
    Array.isArray(value.options)
  );
}

function isAgentFillable(field: WebmcpShimDeclarativeField): boolean {
  if (field.disabled === true || field.readOnly === true) return false;
  return field.tag !== "input" || !EXCLUDED_INPUT_TYPES.has(field.type);
}

/** Radios and checkboxes sharing a name become one choice; any other shared name is dropped, as Chrome drops it. */
function groupSchema(group: WebmcpShimDeclarativeField[], pendingPatterns: PendingPatterns): JsonSchema | null {
  const ofInputType = (type: string) => group.every((field) => field.tag === "input" && field.type === type);
  if (ofInputType("radio")) return choiceSchema(group);
  if (ofInputType("checkbox")) {
    return group.length === 1
      ? describe({ type: "boolean" }, group[0])
      : { type: "array", items: choiceSchema(group), uniqueItems: true };
  }
  return group.length === 1 ? controlSchema(group[0], pendingPatterns) : null;
}

function choiceSchema(group: WebmcpShimDeclarativeField[]): JsonSchema {
  const values = group.map((field) => text(field.checkedValue) ?? "on");
  return {
    type: "string",
    anyOf: group.map((field, index) => {
      const title = labelText(field);
      return title ? { type: "string", const: values[index], title } : { type: "string", const: values[index] };
    }),
    enum: values,
  };
}

function controlSchema(field: WebmcpShimDeclarativeField, pendingPatterns: PendingPatterns): JsonSchema {
  if (field.tag === "select") {
    const options = field.options.filter(
      (option) => typeof option?.value === "string" && typeof option?.text === "string",
    );
    const choice = {
      type: "string",
      anyOf: options.map((option) => ({ type: "string", const: option.value, title: option.text })),
      enum: options.map((option) => option.value),
    };
    return describe(field.multiple === true ? { type: "array", items: choice, uniqueItems: true } : choice, field);
  }
  if (field.tag === "textarea") return describe({ type: "string" }, field);
  if (field.type === "number" || field.type === "range") {
    return describe(numberSchema(field, field.type === "range"), field);
  }
  if (field.type === "date") {
    const own = description(field);
    return { type: "string", format: "date", description: own ? `${own} (${DATE_HINT})` : DATE_HINT };
  }
  const format = FORMAT_BY_INPUT_TYPE.get(field.type);
  if (format) return describe({ type: "string", format }, field);
  const schema = describe({ type: "string" }, field);
  const pattern = PATTERN_INPUT_TYPES.has(field.type) ? text(field.pattern) : null;
  if (pattern !== null) pendingPatterns.push([schema, pattern]);
  return schema;
}

/** HTML compiles `pattern` with the v flag, bare and anchored; one that fails either is ignored by the browser. */
function compilesAsHtmlPattern(pattern: string): boolean {
  if (pattern.length > WEBMCP_MAX_DECLARATIVE_TEXT) return false;
  try {
    RegExp(pattern, "v");
    RegExp(`^(?:${pattern})$`, "v");
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function numberSchema(field: WebmcpShimDeclarativeField, range: boolean): JsonSchema {
  const min = parseHtmlFloat(text(field.min));
  const max = parseHtmlFloat(text(field.max));
  const minimum = range ? (min ?? 0) : min;
  const maximum = range ? Math.max(max ?? 100, minimum ?? 0) : max;
  const schema: JsonSchema = { type: "number" };
  if (minimum !== null) schema.minimum = minimum;
  if (maximum !== null) schema.maximum = maximum;
  const step = allowedStep(text(field.step), range);
  const stepBase = min ?? parseHtmlFloat(text(field.value)) ?? 0;
  if (step !== null && isMultipleOf(stepBase, step)) schema.multipleOf = step;
  return schema;
}

function allowedStep(step: string | null, range: boolean): number | null {
  if (step !== null && step.toLowerCase() === "any") return range ? 1 : null;
  const parsed = parseHtmlFloat(step);
  return parsed !== null && parsed > 0 ? parsed : 1;
}

function isMultipleOf(value: number, step: number): boolean {
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) < STEP_TOLERANCE;
}

function describe(schema: JsonSchema, field: WebmcpShimDeclarativeField): JsonSchema {
  const own = description(field);
  return own === null ? schema : { ...schema, description: own };
}

/** toolparamdescription, else the associated label text, else aria-description: the order Chrome documents. */
function description(field: WebmcpShimDeclarativeField): string | null {
  return text(field.paramDescription) || labelText(field) || text(field.ariaDescription) || null;
}

function labelText(field: WebmcpShimDeclarativeField): string {
  return field.labels.filter((label) => typeof label === "string" && label !== "").join("; ");
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
