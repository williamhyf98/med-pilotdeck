import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkspaceMemoryMode } from "./types.js";
import { hashText } from "./utils/id.js";

export const GENERAL_PROJECT_META_DIR = "GeneralProjects";
export const GENERAL_PROJECT_MEMORY_DIR = "Project";
export const GENERAL_FEEDBACK_MEMORY_DIR = "Feedback";
export const EXTERNAL_RECORD_PREFIX = "external:" as const;
export const EXTERNAL_PROJECT_PREFIX = "external-project:" as const;

/** Resolve the "general" workspace root (`PILOT_HOME`, else `~/.pilotdeck`). */
export function getGeneralWorkspaceDir(): string {
  return process.env.PILOT_HOME
    ? resolve(process.env.PILOT_HOME)
    : join(homedir(), ".pilotdeck");
}

/**
 * Kept for API compatibility. Prefer `getGeneralWorkspaceDir()` when `PILOT_HOME`
 * may be set after module load — this snapshot is resolved on first property read
 * via the getter below in JS builds; in TS source treat as dynamic helper.
 * @deprecated Use getGeneralWorkspaceDir()
 */
export const GENERAL_WORKSPACE_DIR = getGeneralWorkspaceDir();

export function normalizeWorkspacePath(workspacePath: string): string {
  return resolve(workspacePath);
}

export function isGeneralWorkspaceDir(workspaceDir: string): boolean {
  return normalizeWorkspacePath(workspaceDir) === normalizeWorkspacePath(getGeneralWorkspaceDir());
}

export function getWorkspaceMemoryMode(workspaceDir: string): WorkspaceMemoryMode {
  return isGeneralWorkspaceDir(workspaceDir) ? "general" : "single";
}

export function buildExternalProjectLogicalId(workspacePath: string, projectId: string): string {
  return `${EXTERNAL_PROJECT_PREFIX}${hashText(`${normalizeWorkspacePath(workspacePath)}::${projectId}`)}`;
}

export function buildExternalRecordId(workspacePath: string, relativePath: string): string {
  return `${EXTERNAL_RECORD_PREFIX}${hashText(normalizeWorkspacePath(workspacePath))}:${relativePath.replace(/\\/g, "/")}`;
}

export function parseExternalRecordId(
  value: string,
): { workspaceKey: string; relativePath: string } | null {
  if (!value.startsWith(EXTERNAL_RECORD_PREFIX)) return null;
  const payload = value.slice(EXTERNAL_RECORD_PREFIX.length);
  const separator = payload.indexOf(":");
  if (separator <= 0) return null;
  const workspaceKey = payload.slice(0, separator).trim();
  const relativePath = payload.slice(separator + 1).trim().replace(/\\/g, "/");
  if (!workspaceKey || !relativePath) return null;
  return { workspaceKey, relativePath };
}

export function isExternalRecordId(value: string): boolean {
  return value.startsWith(EXTERNAL_RECORD_PREFIX);
}
