/**
 * Plan-mode tool constraints enforced by ToolRuntime. Plan mode keeps the
 * model-visible non-plan tool catalog stable for prompt-cache reuse; this
 * runtime boundary is the security check.
 */

/**
 * Tools the model is allowed to invoke while plan mode is active.
 * Everything else is blocked at runtime.
 */
export const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "read_file",
  "get_current_time",
  "grep",
  "glob",
  "ask_user_question",
  "todo_write",
  "exit_plan_mode",
  "read_skill",
  "bash",
  "write_file",
  "edit_file",
]);

const PLAN_MODE_VIOLATION_HEADER = "[PLAN_MODE_VIOLATION]";

export function buildPlanModeViolationMessage(toolName: string): string {
  return [
    `${PLAN_MODE_VIOLATION_HEADER} Tool "${toolName}" is BLOCKED in plan mode.`,
    "",
    "当前是只读计划模式，用户批准计划前不能执行这个工具。",
    "",
    "现在应当：",
    "1. 用 read_file、grep、glob 或只读 bash 查看工作区材料",
    "2. 只在 .pilotdeck/plans/ 下写 markdown 计划",
    "3. 用 exit_plan_mode(plan_file_path) 提交计划供用户审核",
    "",
    "不要重试这个工具；在计划模式下仍会失败。",
  ].join("\n");
}

export function buildPlanModeBashViolationMessage(command: string): string {
  const truncated = command.length > 120 ? command.slice(0, 120) + "…" : command;
  return [
    `${PLAN_MODE_VIOLATION_HEADER} bash command "${truncated}" is BLOCKED — write/modify commands are not allowed in plan mode.`,
    "",
    "计划模式只允许只读 bash 命令（例如 ls、git status、git log、git diff、pwd、wc）。",
    "",
    "请改成只读命令，或使用 read_file、grep、glob。",
  ].join("\n");
}

export function isPlanModeViolationText(text: unknown): boolean {
  return typeof text === "string" && text.includes(PLAN_MODE_VIOLATION_HEADER);
}
