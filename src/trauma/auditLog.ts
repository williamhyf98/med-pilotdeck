import { appendFile, chmod, mkdir } from "node:fs/promises";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";

export type TraumaAuditStatus = "started" | "ok" | "error" | "skipped";

export type TraumaAuditRecord = {
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR";
  event: "turn_started" | "step_started" | "step_completed" | "step_failed" | "turn_completed" | "turn_failed";
  runId: string;
  projectId: string;
  sessionId: string;
  step?: number;
  phase?: string;
  status: TraumaAuditStatus;
  durationMs?: number;
  details?: Record<string, unknown>;
  error?: unknown;
};

export type TraumaAuditLogger = {
  readonly path: string;
  record(entry: TraumaAuditRecord): Promise<void>;
};

const SENSITIVE_KEY = /^(userText|assistantText|sourceQuote|text|prompt|content|apiKey|authorization|token|secret|password)$/i;
const MAX_ERROR_MESSAGE_CHARS = 1_000;

function sanitizeDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeDetails);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) continue;
    sanitized[key] = sanitizeDetails(item);
  }
  return sanitized;
}

function normalizeError(error: unknown): { name: string; code?: string; message: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name || "Error",
      ...(typeof code === "string" && code ? { code } : {}),
      message: error.message.replace(/[\r\n]+/g, " ").slice(0, MAX_ERROR_MESSAGE_CHARS),
    };
  }
  return {
    name: "Error",
    message: String(error).replace(/[\r\n]+/g, " ").slice(0, MAX_ERROR_MESSAGE_CHARS),
  };
}

export function createTraumaAuditLogger(options: { pilotHome: string }): TraumaAuditLogger {
  const logsDir = resolve(options.pilotHome, "logs");
  const path = resolve(logsDir, "trauma-agent.jsonl");
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  let pending = Promise.resolve();

  const write = async (entry: TraumaAuditRecord): Promise<void> => {
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      schemaVersion: 1,
      service: "trauma-turn-runner",
      ...entry,
      ...(entry.details ? { details: sanitizeDetails(entry.details) } : {}),
      ...(entry.error !== undefined ? { error: normalizeError(entry.error) } : {}),
    });
    await appendFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  };

  return {
    path,
    record(entry) {
      pending = pending.then(() => write(entry));
      return pending;
    },
  };
}
