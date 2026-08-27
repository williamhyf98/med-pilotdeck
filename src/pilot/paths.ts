import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { findCanonicalProjectRoot } from "../session/worktree/findCanonicalProjectRoot.js";

export type PilotPathEnv = Record<string, string | undefined>;

export const DEFAULT_PILOT_HOME = "~/.pilotdeck";
export const PILOT_CONFIG_FILE_NAME = "pilotdeck.yaml";
export const PILOT_PROJECT_DIR_NAME = ".pilotdeck";
/** Storage id and workspace folder name for the virtual general chat workspace. */
export const GENERAL_WORKSPACE_ID = "general";

export type PilotExtensionPaths = {
  globalPluginsDir: string;
  globalSkillsDir: string;
  projectPluginsDir: string;
  projectSkillsDir: string;
};

export function resolvePilotHome(env: PilotPathEnv = process.env): string {
  return normalizeHomePath(env.PILOT_HOME ?? DEFAULT_PILOT_HOME);
}

export function getPilotConfigFilePath(pilotHome: string): string {
  return resolve(pilotHome, PILOT_CONFIG_FILE_NAME);
}

export function getPilotProjectConfigFilePath(projectRoot: string): string {
  return resolve(projectRoot, PILOT_PROJECT_DIR_NAME, PILOT_CONFIG_FILE_NAME);
}

export function getPilotMemoryRootDir(pilotHome: string): string {
  return resolve(pilotHome, "memory");
}

export function getPilotProjectChatDir(projectRoot: string, pilotHome: string): string {
  const gatewayKey = resolveGatewayProjectKey(projectRoot, pilotHome);
  const projectId = resolveProjectStorageId(gatewayKey, pilotHome);
  return resolve(pilotHome, "projects", projectId, "chats");
}

/**
 * Async variant that first resolves a worktree cwd to its canonical
 * main-repository root (so all worktrees share the same project ID).
 * Use this for all new code. The sync `getPilotProjectChatDir` keeps
 * the legacy behaviour for callers that cannot await.
 */
export async function getPilotProjectChatDirAsync(
  projectRoot: string,
  pilotHome: string,
): Promise<string> {
  const gatewayKey = resolveGatewayProjectKey(projectRoot, pilotHome);
  const canonical = await findCanonicalProjectRoot(gatewayKey);
  const projectId = resolveProjectStorageId(canonical, pilotHome);
  return resolve(pilotHome, "projects", projectId, "chats");
}

export function getPilotExtensionPaths(projectRoot: string, pilotHome: string): PilotExtensionPaths {
  const repoRoot = resolveGatewayProjectKey(projectRoot, pilotHome);
  return {
    globalPluginsDir: resolve(pilotHome, "plugins"),
    globalSkillsDir: resolve(pilotHome, "skills"),
    projectPluginsDir: resolve(repoRoot, PILOT_PROJECT_DIR_NAME, "plugins"),
    projectSkillsDir: resolve(repoRoot, PILOT_PROJECT_DIR_NAME, "skills"),
  };
}

export function createProjectId(projectRoot: string): string {
  const normalizedRoot = resolve(projectRoot);
  return createLegacyProjectId(normalizedRoot);
}

export function createCollisionResistantProjectId(projectRoot: string): string {
  const normalizedRoot = resolve(projectRoot);
  const legacyId = createLegacyProjectId(normalizedRoot);
  const digest = createHash("sha1").update(normalizedRoot).digest("hex").slice(0, 10);
  return `${legacyId}--${digest}`;
}

/**
 * Resolve the on-disk project directory name for a workspace.
 *
 * `.cwd` markers are authoritative because the legacy project ID is lossy:
 * distinct paths (especially paths containing non-ASCII segments) can encode
 * to the same slug. When no valid marker exists, retain the legacy ID for
 * backwards compatibility with unregistered projects.
 */
export function resolveProjectStorageId(projectRoot: string, pilotHome: string): string {
  return findStoredProjectId(projectRoot, pilotHome) ?? createProjectId(projectRoot);
}

/**
 * Async variant: resolves canonical (worktree-aware) root before hashing.
 * Two worktrees of the same repo produce the same project ID.
 */
export async function createProjectIdAsync(projectRoot: string): Promise<string> {
  const canonical = await findCanonicalProjectRoot(projectRoot);
  return createProjectId(canonical);
}

function normalizeHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return resolve(path);
}

function createLegacyProjectId(projectRoot: string): string {
  // Normalize to forward slashes so the same physical path produces the same
  // project ID on Windows (\) and Unix (/). Also strip a Windows drive-letter
  // prefix (e.g. "C:") so "C:\Users\foo" slugifies identically to "/Users/foo".
  const normalized = projectRoot.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  return normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function findStoredProjectId(projectRoot: string, pilotHome: string): string | null {
  const projectsDir = resolve(pilotHome, "projects");
  if (!existsSync(projectsDir)) {
    return null;
  }
  const target = normalizeProjectPathForMarkerComparison(projectRoot);
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const markerPath = resolve(projectsDir, entry.name, ".cwd");
      let marker: string;
      try {
        marker = readFileSync(markerPath, "utf8").trim();
      } catch {
        continue;
      }
      if (!marker || normalizeProjectPathForMarkerComparison(marker) !== target) {
        continue;
      }
      try {
        if (statSync(marker).isDirectory()) {
          return entry.name;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeProjectPathForMarkerComparison(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isGeneralWorkspaceId(workspaceId: string): boolean {
  return workspaceId === GENERAL_WORKSPACE_ID;
}

export function isGeneralProjectKey(projectKey: string | null | undefined, pilotHome: string): boolean {
  if (!projectKey) return true;
  const resolvedKey = resolve(projectKey);
  const resolvedHome = resolve(pilotHome);
  if (resolvedKey === resolvedHome) return true;
  if (projectKey === GENERAL_WORKSPACE_ID) return true;
  const generalWorkspace = resolveWorkspaceDataRoot(GENERAL_WORKSPACE_ID, pilotHome);
  return resolvedKey === resolve(generalWorkspace);
}

/**
 * Map a gateway/UI project key to the workspace storage id used under
 * `$PILOT_HOME/workspaces/<id>/`.
 */
export function resolveWorkspaceId(projectKey: string | null | undefined, pilotHome: string): string {
  if (isGeneralProjectKey(projectKey, pilotHome)) {
    return GENERAL_WORKSPACE_ID;
  }
  return resolveProjectStorageId(resolve(projectKey!), pilotHome);
}

/** Absolute path to `$PILOT_HOME/workspaces/<workspaceId>/`. */
export function resolveWorkspaceDataRoot(workspaceId: string, pilotHome: string): string {
  return resolve(pilotHome, "workspaces", workspaceId);
}

/** Agent file-data cwd for a project key. */
export function resolveAgentCwd(projectKey: string | null | undefined, pilotHome: string): string {
  const workspaceId = resolveWorkspaceId(projectKey, pilotHome);
  return resolveWorkspaceDataRoot(workspaceId, pilotHome);
}

export function resolveInboxBatchDir(workspaceDataRoot: string, batchId: string): string {
  return resolve(workspaceDataRoot, "inbox", batchId);
}

export function resolveInboxDerivedDir(workspaceDataRoot: string, batchId: string): string {
  return resolve(workspaceDataRoot, "inbox", batchId, "derived");
}

export function resolveWorkspaceExportsDir(workspaceDataRoot: string): string {
  return resolve(workspaceDataRoot, "exports");
}

export function resolveWorkspaceScratchDir(workspaceDataRoot: string): string {
  return resolve(workspaceDataRoot, "scratch");
}

/** Create inbox / exports / scratch layout if missing. Idempotent. */
export function ensureWorkspaceLayout(workspaceDataRoot: string): void {
  const dirs = [
    resolve(workspaceDataRoot, "inbox"),
    resolve(workspaceDataRoot, "exports"),
    resolve(workspaceDataRoot, "scratch", "qa"),
    resolve(workspaceDataRoot, "scratch", "work"),
    resolve(workspaceDataRoot, "scratch", "preview"),
    resolve(workspaceDataRoot, "scratch", "tool-results"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read the real linked repository path from `$PILOT_HOME/projects/<id>/.cwd`.
 * Returns null for general workspace or when no marker exists.
 */
export function resolveAssociatedProjectPath(workspaceId: string, pilotHome: string): string | null {
  if (isGeneralWorkspaceId(workspaceId)) {
    return null;
  }
  const markerPath = resolve(pilotHome, "projects", workspaceId, ".cwd");
  try {
    const marker = readFileSync(markerPath, "utf8").trim();
    if (marker && statSync(marker).isDirectory()) {
      return resolve(marker);
    }
  } catch {
    return null;
  }
  return null;
}

/** Additional directories the agent may read when cwd is the workspace data root. */
export function resolveAgentAdditionalWorkingDirectories(
  projectKey: string | null | undefined,
  pilotHome: string,
): string[] {
  const workspaceId = resolveWorkspaceId(projectKey, pilotHome);
  const associated = resolveAssociatedProjectPath(workspaceId, pilotHome);
  if (!associated) {
    return [];
  }
  const agentCwd = resolveAgentCwd(projectKey, pilotHome);
  if (resolve(associated) === resolve(agentCwd)) {
    return [];
  }
  return [associated];
}

/**
 * Gateway session/memory key. Differs from agent cwd when the UI passes the
 * workspace data root instead of the linked repository or PILOT_HOME.
 */
export function resolveGatewayProjectKey(
  projectPath: string | null | undefined,
  pilotHome: string,
): string {
  if (!projectPath) {
    return resolve(pilotHome);
  }
  if (isGeneralProjectKey(projectPath, pilotHome)) {
    return resolve(pilotHome);
  }
  if (!isAbsolute(projectPath) && !projectPath.includes("/") && !projectPath.includes("\\")) {
    if (isGeneralWorkspaceId(projectPath)) {
      return resolve(pilotHome);
    }
    const associatedFromId = resolveAssociatedProjectPath(projectPath, pilotHome);
    if (associatedFromId) {
      return associatedFromId;
    }
  }
  const resolvedPath = resolve(projectPath);
  const workspacesRoot = resolve(pilotHome, "workspaces");
  const prefix = workspacesRoot.endsWith("/") ? workspacesRoot : `${workspacesRoot}/`;
  if (resolvedPath === workspacesRoot || resolvedPath.startsWith(prefix)) {
    const relativeId = resolvedPath.slice(prefix.length).split("/")[0] ?? "";
    if (relativeId && isGeneralWorkspaceId(relativeId)) {
      return resolve(pilotHome);
    }
    if (relativeId) {
      const associated = resolveAssociatedProjectPath(relativeId, pilotHome);
      if (associated) {
        return associated;
      }
    }
  }
  return resolvedPath;
}

/** Gateway session transcript directory for a UI project name or workspace path. */
export function resolveProjectChatDir(projectKey: string, pilotHome: string): string {
  const gatewayKey = resolveGatewayProjectKey(projectKey, pilotHome);
  const projectId = resolveProjectStorageId(gatewayKey, pilotHome);
  return resolve(pilotHome, "projects", projectId, "chats");
}

export function resolveWorkspaceDirectoryForProjectName(
  projectName: string | null | undefined,
  pilotHome: string,
): string {
  if (!projectName || isGeneralProjectKey(projectName, pilotHome)) {
    return resolveWorkspaceDataRoot(GENERAL_WORKSPACE_ID, pilotHome);
  }
  if (isAbsolute(projectName)) {
    const workspaceId = resolveWorkspaceId(projectName, pilotHome);
    return resolveWorkspaceDataRoot(workspaceId, pilotHome);
  }
  // Storage id slug under projects/<id>/.
  return resolveWorkspaceDataRoot(projectName, pilotHome);
}
