import type { PilotConfigDiagnostic, SandboxConfig } from "./types.js";

export type { SandboxConfig };

export type RetentionConfig = {
  logMaxBytes: number;
  logKeep: number;
  attachmentMaxAgeDays: number;
  archiveMaxAgeDays: number;
};
export type MultiUserConfig = {
  retention: RetentionConfig;
  gatewayPool?: Record<string, unknown>;
  sandbox?: SandboxConfig;
};

export const DEFAULT_RETENTION: RetentionConfig = {
  logMaxBytes: 20 * 1024 * 1024,
  logKeep: 5,
  attachmentMaxAgeDays: 7,
  archiveMaxAgeDays: 30,
};

const SANDBOX_KINDS: readonly string[] = ["bwrap", "sandbox-exec", "none"];

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

function sandboxDiagnostic(key: keyof SandboxConfig, message: string, diagnostics: PilotConfigDiagnostic[]): void {
  diagnostics.push({
    code: "multi-user.sandbox.invalid",
    severity: "warning",
    message: `multiUser.sandbox.${key} ${message}`,
    path: `multiUser.sandbox.${key}`,
    recoverable: true,
  });
}

function sandboxBool(
  raw: Record<string, unknown>,
  key: "allowUnsandboxed" | "network",
  fallback: boolean,
  diagnostics: PilotConfigDiagnostic[],
): boolean {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  sandboxDiagnostic(key, `must be a boolean; using ${fallback}`, diagnostics);
  return fallback;
}

function sandboxKind(raw: Record<string, unknown>, diagnostics: PilotConfigDiagnostic[]): SandboxConfig["kind"] {
  const v = raw.kind;
  if (v === undefined) return undefined;
  if (typeof v === "string" && SANDBOX_KINDS.includes(v)) return v as SandboxConfig["kind"];
  sandboxDiagnostic("kind", "must be one of bwrap, sandbox-exec, none; using auto-detection", diagnostics);
  return undefined;
}

function sandboxBinds(raw: Record<string, unknown>, diagnostics: PilotConfigDiagnostic[]): string[] {
  const v = raw.extraReadOnlyBinds;
  if (v === undefined) return [];
  if (Array.isArray(v) && v.every((p) => typeof p === "string" && p.startsWith("/"))) return [...(v as string[])];
  sandboxDiagnostic("extraReadOnlyBinds", "must be an array of absolute paths; ignoring it", diagnostics);
  return [];
}

function parseSandbox(raw: unknown, diagnostics: PilotConfigDiagnostic[]): SandboxConfig {
  const section = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    kind: sandboxKind(section, diagnostics),
    allowUnsandboxed: sandboxBool(section, "allowUnsandboxed", false, diagnostics),
    network: sandboxBool(section, "network", true, diagnostics),
    extraReadOnlyBinds: sandboxBinds(section, diagnostics),
  };
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
    sandbox: parseSandbox(section.sandbox, diagnostics),
  };
}
