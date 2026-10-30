import type { PilotDeckJsonSchema, PilotDeckToolInputSchema } from "../protocol/schema.js";

/**
 * Some models (notably Qwen-style function calling) emit nested array/object
 * arguments as JSON *strings*. Schema validation then fails with
 * `must be array` even though the payload is otherwise valid.
 *
 * Unwrap those strings when the schema expects array/object, then recurse.
 */
export function coerceJsonEncodedToolInput(input: unknown, schema: PilotDeckToolInputSchema): unknown {
  return coerceValue(input, schema);
}

function coerceValue(value: unknown, schema: PilotDeckJsonSchema | undefined): unknown {
  if (!schema) {
    return value;
  }

  const expected = schemaTypes(schema);
  const unwrapped = unwrapJsonString(value, expected);
  const next = unwrapped.value;

  if (isPlainObject(next) && (expected.has("object") || expected.size === 0 || schema.properties)) {
    return coerceObject(next, schema);
  }

  if (Array.isArray(next) && schema.items && (expected.has("array") || expected.size === 0)) {
    return next.map((item) => coerceValue(item, schema.items));
  }

  return next;
}

function coerceObject(value: Record<string, unknown>, schema: PilotDeckJsonSchema): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const out: Record<string, unknown> = { ...value };
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (key in out) {
      out[key] = coerceValue(out[key], propertySchema);
    }
  }
  return out;
}

function unwrapJsonString(
  value: unknown,
  expected: Set<string>,
): { value: unknown } {
  let current = value;
  for (let depth = 0; depth < 3 && typeof current === "string"; depth += 1) {
    const parsed = tryParseJson(current);
    if (parsed === undefined) {
      break;
    }
    const parsedType = jsonType(parsed);
    if (!parsedType) {
      break;
    }
    const wantsComplex = expected.has("array") || expected.has("object");
    if (!wantsComplex) {
      break;
    }
    if (!expected.has(parsedType) && expected.size > 0) {
      break;
    }
    // Do not turn a JSON string into a string value when the field is already a string.
    if (parsedType === "string" && expected.has("string")) {
      break;
    }
    current = parsed;
  }
  return { value: current };
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[" && trimmed[0] !== '"')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function schemaTypes(schema: PilotDeckJsonSchema): Set<string> {
  if (schema.type === undefined) {
    return new Set();
  }
  return new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
}

function jsonType(value: unknown): string | undefined {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (isPlainObject(value)) {
    return "object";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
