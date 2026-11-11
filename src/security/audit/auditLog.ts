import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolvePilotHome, type PilotPathEnv } from "../../pilot/paths.js";

/**
 * 审计日志（spec §11）：每次拒绝留一行 JSON，按天分文件。
 *
 * 位置：`<systemHome>/system/audit/<YYYY-MM-DD>.jsonl`
 * 其中 `systemHome` 与安全策略文件同源：多用户下取 `PILOTDECK_SYSTEM_HOME`，
 * 单机下退回 `PILOT_HOME`（见 `security/policy/paths.ts` 的同一约定）。
 *
 * 硬约束：
 * - **写失败绝不抛错**。审计是旁路，不能因为磁盘满/权限问题让业务 500。
 * - **不落绝对路径**。`target` 由调用方给相对路径，落盘前再兜一次底。
 * - 单行上限 4 KB，超长字段截断，避免把整个文件内容抄进审计。
 */

export type AuditDecision = "deny" | "ask" | "allow" | "error";

export type AuditEvent = {
  /** 事件名，固定命名空间：`file.denied` / `bash.denied` / `sandbox.denied` / `analysis.rejected` … */
  action: string;
  decision?: AuditDecision;
  /** 触发的工具名，如 `write_file` / `bash` */
  tool?: string;
  /** 工作区相对路径或占位符；不得是绝对路径 */
  target?: string;
  /** 机器可读的简短原因 */
  reason?: string;
  actor?: string;
  meta?: Record<string, unknown>;
};

const MAX_FIELD_CHARS = 500;
const MAX_LINE_BYTES = 4096;

export function resolveAuditDir(env: PilotPathEnv = process.env): string {
  const systemHome = resolvePilotHome({ ...env, PILOT_HOME: env.PILOTDECK_SYSTEM_HOME ?? env.PILOT_HOME });
  return resolve(systemHome, "system", "audit");
}

export function auditFilePath(now: Date = new Date(), env: PilotPathEnv = process.env): string {
  return join(resolveAuditDir(env), `${dayStamp(now)}.jsonl`);
}

/** 追加一条审计；任何异常都被吞掉，返回值只用于测试/诊断。 */
export function appendAudit(
  event: AuditEvent,
  options: { env?: PilotPathEnv; now?: Date } = {},
): { ok: boolean; file?: string; error?: string } {
  try {
    const env = options.env ?? process.env;
    const now = options.now ?? new Date();
    const file = auditFilePath(now, env);
    const line = serialize(event, now);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line, { encoding: "utf8" });
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function serialize(event: AuditEvent, now: Date): string {
  const record: Record<string, unknown> = {
    ts: now.toISOString(),
    action: clip(event.action),
  };
  if (event.decision) record.decision = event.decision;
  if (event.tool) record.tool = clip(event.tool);
  if (event.target) record.target = sanitizeTarget(event.target);
  if (event.reason) record.reason = clip(event.reason);
  if (event.actor) record.actor = clip(event.actor);
  if (event.meta) record.meta = clipMeta(event.meta);
  const line = `${JSON.stringify(record)}\n`;
  return Buffer.byteLength(line) <= MAX_LINE_BYTES ? line : `${line.slice(0, MAX_LINE_BYTES - 2)}\n`;
}

function clip(value: string): string {
  const text = String(value ?? "");
  return text.length <= MAX_FIELD_CHARS ? text : `${text.slice(0, MAX_FIELD_CHARS)}…`;
}

/** 绝对路径一律退化成基名，杜绝把用户目录结构写进审计。 */
export function sanitizeTarget(target: string): string {
  const text = String(target ?? "");
  if (!text) return "";
  if (!text.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(text)) return clip(text);
  const base = text.split(/[\\/]/).filter(Boolean).pop() ?? "(unknown)";
  return clip(`(absolute)/${base}`);
}

function clipMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let index = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (index >= 12) break;
    out[clip(key)] = typeof value === "string" ? clip(value) : value;
    index += 1;
  }
  return out;
}

function dayStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
