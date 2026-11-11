/**
 * 把 data-analysis 执行器的结果翻译成审计事件（spec §4「每条拒绝都要写审计」/ §11）。
 *
 * 执行器（`skills/data-analysis/scripts/run_analysis.py`）在 stdout 打一行 JSON：
 *
 *   {"status":"rejected","violations":[...]}         退出 3
 *   {"status":"blocked","violations":[...]}          退出 8
 *   {"status":"timeout", ...}                        退出 5
 *   {"status":"ok"|"failed"|"oom", ...}              退出 0/4/6
 *
 * 这里只看**安全相关**的那几种（rejected / blocked / timeout / oom），
 * `ok` 与普通 `failed`（脚本自己写错了）不写审计——否则审计表会被日常噪声淹掉，
 * 一天几百条 "ok" 反而看不见真正的拒绝。
 */

export type AnalysisAuditAction =
  | "analysis.rejected"
  | "analysis.blocked"
  | "analysis.timeout"
  | "analysis.oom";

export type AnalysisAuditEvent = {
  action: AnalysisAuditAction;
  decision: "deny";
  tool: "bash";
  reason: string;
  meta: Record<string, unknown>;
};

type AnalysisReport = {
  status?: unknown;
  violations?: unknown;
  runnerExitCode?: unknown;
  out?: unknown;
  script?: unknown;
};

const ENTRY_SUFFIXES = [
  "data-analysis/scripts/analysis.sh",
  "data-analysis\\scripts\\analysis.sh",
];

const REASON_MAX = 160;

/** 这条 bash 命令是不是在调 data-analysis 的唯一入口。 */
export function isAnalysisCommand(command: string): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  return ENTRY_SUFFIXES.some((suffix) => command.includes(suffix));
}

/** 执行器输出的最后一行 JSON；解析不出来就返回 null。 */
export function parseAnalysisReport(stdout: string): AnalysisReport | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
        return parsed as AnalysisReport;
      }
    } catch {
      // 不是 JSON 就继续往上找
    }
  }
  return null;
}

function violationNames(violations: unknown): string[] {
  if (!Array.isArray(violations)) return [];
  const names: string[] = [];
  for (const violation of violations) {
    if (!violation || typeof violation !== "object") continue;
    const record = violation as Record<string, unknown>;
    const name = record.rule ?? record.event;
    if (typeof name === "string" && name) names.push(name);
  }
  return [...new Set(names)];
}

function clip(value: string): string {
  return value.length > REASON_MAX ? `${value.slice(0, REASON_MAX)}…` : value;
}

/**
 * 需要写审计时返回事件，否则返回 null。
 * `timedOut` 由调用方给（bash 层的墙钟超时早于执行器自己的超时）。
 */
export function analysisAuditEvent(options: {
  command: string;
  stdout: string;
  timedOut?: boolean;
}): AnalysisAuditEvent | null {
  const { command, stdout, timedOut = false } = options;
  if (!isAnalysisCommand(command)) return null;

  const report = parseAnalysisReport(stdout);
  const status = typeof report?.status === "string" ? report.status : undefined;
  const meta: Record<string, unknown> = {
    runnerExitCode: typeof report?.runnerExitCode === "number" ? report.runnerExitCode : undefined,
    out: typeof report?.out === "string" ? report.out : undefined,
  };

  if (timedOut || status === "timeout") {
    return { action: "analysis.timeout", decision: "deny", tool: "bash", reason: "wall-clock timeout", meta };
  }

  if (status === "rejected") {
    const rules = violationNames(report?.violations);
    return {
      action: "analysis.rejected",
      decision: "deny",
      tool: "bash",
      reason: clip(rules.length > 0 ? `static:${rules.join(",")}` : "static"),
      meta: { ...meta, violations: rules.length },
    };
  }

  if (status === "blocked") {
    const events = violationNames(report?.violations);
    return {
      action: "analysis.blocked",
      decision: "deny",
      tool: "bash",
      reason: clip(events.length > 0 ? `runtime:${events.join(",")}` : "runtime"),
      meta: { ...meta, violations: events.length },
    };
  }

  if (status === "oom") {
    return { action: "analysis.oom", decision: "deny", tool: "bash", reason: "memory limit", meta };
  }

  return null;
}
