/**
 * Hard guards against agent "empty spinning" (C): tool-call budgets and
 * skill-source inspection streaks (grep/read_file/glob under skills/.../scripts).
 */

export const DEFAULT_MAX_TOOL_CALLS = 20;
export const DEFAULT_MAX_TURNS = 25;

/** Consecutive model steps whose tools are only skill-source inspection. */
export const SKILL_SOURCE_GRACE_AFTER_TURNS = 4;
export const SKILL_SOURCE_STOP_AFTER_TURNS = 6;

export const SKILL_SOURCE_GRACE_PROMPT = [
  "You appear to be repeatedly inspecting skill script source code (grep/read_file/glob under skills/*/scripts) to discover undocumented capabilities.",
  "Stop reading skill implementation source now.",
  "If the skill does not support what the user asked for (for example: PDF make cannot embed user photos in the document body), reply to the user in clear natural language:",
  "state the limitation briefly, offer a practical alternative (plain-text PDF, Word/PPT with images, etc.), and do not call more tools.",
].join(" ");

export const MAX_TOOL_CALLS_GRACE_PROMPT = [
  "You are approaching the tool-call budget for this turn.",
  "Stop calling tools. Reply to the user in clear natural language with the current result or an honest limitation, and any next-step suggestion.",
].join(" ");

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

/** Paths / patterns that mean "digging into skill implementation", not using the skill. */
export function isSkillSourceInspectionCall(name: string, input: unknown): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized !== "grep" && normalized !== "read_file" && normalized !== "glob") {
    return false;
  }
  const record = asRecord(input);
  const path = stringField(record, "path", "file_path", "filePath", "target", "glob");
  const pattern = stringField(record, "pattern", "query", "glob_pattern", "globPattern");
  const haystack = `${path}\n${pattern}`;

  if (/(?:^|[/\\])skills[/\\][^/\\]+[/\\]scripts(?:[/\\]|$|\n)/i.test(haystack)) {
    return true;
  }
  if (/(?:^|[/\\])skills[/\\][^/\\]+[/\\][^/\\]+\.(py|sh|mjs|cjs|js)$/i.test(path)) {
    return true;
  }
  // Grep/glob focused on cli entrypoints by name even when path is wide.
  if (/(?:^|[/\\])(?:pdf|docx|pptx|spreadsheet|diagram)(?:_cli)?\.(?:py|sh)\b/i.test(haystack)) {
    return true;
  }
  if (/assets[/\\]starter_pdf\.py/i.test(haystack)) {
    return true;
  }
  return false;
}

export function areOnlySkillSourceInspections(
  calls: ReadonlyArray<{ name: string; input: unknown }>,
): boolean {
  return calls.length > 0 && calls.every((call) => isSkillSourceInspectionCall(call.name, call.input));
}

export function resolveEffectiveMaxTurns(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return DEFAULT_MAX_TURNS;
}

export function resolveEffectiveMaxToolCalls(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return DEFAULT_MAX_TOOL_CALLS;
}
