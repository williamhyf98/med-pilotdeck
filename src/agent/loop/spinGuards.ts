/**
 * Hard guards against agent "empty spinning" (C): tool-call budgets and
 * skill-source inspection streaks (grep/read_file/glob under skills/.../scripts).
 */

/**
 * 交互式对话的默认预算。
 *
 * 2026-11-12 实跑：数据分析任务（读数据 → 写脚本 → 跑 → 看报错 → 改 → 再跑 → 出图 →
 * 写报告）在 18 次调用时就撞上旧的 20 次上限，模型被迫在交付文档之前收尾。
 * 纯问答用不到 20 次，而"分析 + 出交付物"这类任务 20 次明显不够，所以抬到 40
 * （软提醒同步移到第 38 次，见 maxToolCallsGracePrompt）。
 *
 * `maxTurns` 必须大于 `maxToolCalls`：每次调用至少占一个 turn，串行时
 * turns ≈ toolCalls + 1，多留的余量给"模型报错重试"这种不产生工具调用的 turn，
 * 否则真正卡住流程的会变成 turn 上限（它没有软提醒，直接结束）。
 */
export const DEFAULT_MAX_TOOL_CALLS = 40;
export const DEFAULT_MAX_TURNS = 45;

/** Consecutive model steps whose tools are only skill-source inspection. */
export const SKILL_SOURCE_GRACE_AFTER_TURNS = 4;
export const SKILL_SOURCE_STOP_AFTER_TURNS = 6;

export const SKILL_SOURCE_GRACE_PROMPT = [
  "You appear to be repeatedly inspecting skill script source code (grep/read_file/glob under skills/*/scripts) to discover undocumented capabilities.",
  "Stop reading skill implementation source now.",
  "If the skill does not support what the user asked for (for example: PDF make cannot embed user photos in the document body), reply to the user in clear natural language:",
  "state the limitation briefly, offer a practical alternative (plain-text PDF, Word/PPT with images, etc.), and do not call more tools.",
].join(" ");

/**
 * 软提醒文案（2026-11-12 改写）。
 *
 * 旧文案以 "approaching the tool-call budget" 开头、紧接着 "Stop calling tools"，
 * 模型只记住后半句，把"还剩 2 次"理解成"已经用完"，于是放弃写交付物直接交文字。
 * 现在明确给出剩余次数，并说明这是**预算提醒不是停止信号**，把剩余预算导向交付物。
 */
export function maxToolCallsGracePrompt(remaining: number): string {
  const left = Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0;
  return [
    left > 0
      ? `Tool-call budget for this turn: ${left} call${left === 1 ? "" : "s"} left.`
      : "Tool-call budget for this turn is used up.",
    left > 0
      ? "This is a budget warning, not a stop: you may still call tools."
      : "Calling another tool now ends the turn with an error.",
    "Spend the remaining budget on the user-facing deliverable (write the final file, run the final command), not on further exploration.",
    "Do not re-run a command that already failed with the same input, and do not go hunting for logs the tool output already gave you.",
    "If you cannot finish, reply with the result you already have, the single blocking step, and what the next turn should do.",
  ].join(" ");
}

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
