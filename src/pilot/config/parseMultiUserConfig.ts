import type { PilotConfigDiagnostic } from "./types.js";

export type RetentionConfig = {
  logMaxBytes: number;
  logKeep: number;
  attachmentMaxAgeDays: number;
  archiveMaxAgeDays: number;
};
export type MultiUserConfig = { retention: RetentionConfig; gatewayPool?: Record<string, unknown> };

export const DEFAULT_RETENTION: RetentionConfig = {
  logMaxBytes: 20 * 1024 * 1024,
  logKeep: 5,
  attachmentMaxAgeDays: 7,
  archiveMaxAgeDays: 30,
};

function num(
  raw: Record<string, unknown>,
  key: keyof RetentionConfig,
  fallback: number,
  diagnostics: PilotConfigDiagnostic[],
): number {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  diagnostics.push({
    code: "multi-user.retention.invalid",
    severity: "warning",
    message: `multiUser.retention.${key} must be a positive number; using ${fallback}`,
    path: `multiUser.retention.${key}`,
    recoverable: true,
  });
  return fallback;
}

export function parseMultiUserConfig(raw: unknown, diagnostics: PilotConfigDiagnostic[]): MultiUserConfig {
  const section = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ret =
    section.retention && typeof section.retention === "object"
      ? (section.retention as Record<string, unknown>)
      : {};
  return {
    retention: {
      logMaxBytes: num(ret, "logMaxBytes", DEFAULT_RETENTION.logMaxBytes, diagnostics),
      logKeep: num(ret, "logKeep", DEFAULT_RETENTION.logKeep, diagnostics),
      attachmentMaxAgeDays: num(ret, "attachmentMaxAgeDays", DEFAULT_RETENTION.attachmentMaxAgeDays, diagnostics),
      archiveMaxAgeDays: num(ret, "archiveMaxAgeDays", DEFAULT_RETENTION.archiveMaxAgeDays, diagnostics),
    },
    gatewayPool:
      section.gatewayPool && typeof section.gatewayPool === "object"
        ? (section.gatewayPool as Record<string, unknown>)
        : undefined,
  };
}
