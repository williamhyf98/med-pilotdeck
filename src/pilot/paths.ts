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

/** Directory / id-prefix keys (avoid colliding with legacy virtual `general`). */
export const PROJECT_TYPE_KEYS = {
  general_medicine: "general_med",
  war_trauma: "trauma_med",
} as const;

export type ProjectMetaType = keyof typeof PROJECT_TYPE_KEYS;
export type ProjectTypeKey = (typeof PROJECT_TYPE_KEYS)[ProjectMetaType];

export const PROJECT_TYPE_KEY_SET = new Set<string>(Object.values(PROJECT_TYPE_KEYS));

/** Stable system project id that owns pre-typed general-chat memory (P0.1 migration). */
export const LEGACY_GENERAL_PROJECT_ID = "general_med-legacy-general";

export function isProjectMetaType(value: string | null | undefined): value is ProjectMetaType {
  return Boolean(value && value in PROJECT_TYPE_KEYS);
}

export function projectTypeKeyFromMetaType(type: string | null | undefined): ProjectTypeKey | null {
  if (!isProjectMetaType(type)) return null;
  return PROJECT_TYPE_KEYS[type];
}

export function projectTypeKeyFromProjectId(projectId: string | null | undefined): ProjectTypeKey | null {
  if (!projectId) return null;
  if (projectId.startsWith(`${PROJECT_TYPE_KEYS.general_medicine}-`)) {
    return PROJECT_TYPE_KEYS.general_medicine;
  }
  if (projectId.startsWith(`${PROJECT_TYPE_KEYS.war_trauma}-`)) {
    return PROJECT_TYPE_KEYS.war_trauma;
  }
  return null;
}

/**
 * Resolve the immutable project type from a typed system-project id or path.
 * Unknown/legacy workspaces retain the historical general-medicine behavior.
 */
export function projectMetaTypeFromProjectPath(projectPath: string | null | undefined): ProjectMetaType {
  const normalized = (projectPath ?? "").replace(/\\/gu, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.includes(PROJECT_TYPE_KEYS.war_trauma)
    || segments.some((segment) => segment.startsWith(`${PROJECT_TYPE_KEYS.war_trauma}-`))
  ) {
    return "war_trauma";
  }
  return "general_medicine";
}

/** True when value is a storage/id token, not a filesystem path. */
export function isBareProjectId(value: string | null | undefined): boolean {
  if (!value) return false;
  return !isAbsolute(value) && !value.includes("/") && !value.includes("\\");
}

/** `$PILOT_HOME/projects/<typeKey>/<projectId>` or legacy flat `$PILOT_HOME/projects/<id>`. */
export function resolveTypedProjectDir(projectId: string, pilotHome: string): string {
  const typeKey = projectTypeKeyFromProjectId(projectId);
  if (typeKey) {
    return resolve(pilotHome, "projects", typeKey, projectId);
  }
  return resolve(pilotHome, "projects", projectId);
}

/** `$PILOT_HOME/memory/<typeKey>/<projectId>` for typed system projects. */
export function resolveTypedProjectMemoryDir(projectId: string, pilotHome: string): string {
  const typeKey = projectTypeKeyFromProjectId(projectId);
  if (!typeKey) {
    throw new Error(`Not a typed system project id: ${projectId}`);
  }
  return resolve(pilotHome, "memory", typeKey, projectId);
}

/**
 * On-disk memory data directory for a project key / agent cwd.
 *
 * Never returns `$PILOT_HOME/memory/workspaces/<hash>` for system or general
 * keys — those go under typed buckets. Virtual general (until P2) shares
 * `general_med-legacy-general`.
 */
export function resolveProjectMemoryDataDir(
  projectKey: string | null | undefined,
  pilotHome: string,
): string {
  const memoryRoot = getPilotMemoryRootDir(pilotHome);
  if (isGeneralProjectKey(projectKey, pilotHome)) {
    return resolve(
      memoryRoot,
      PROJECT_TYPE_KEYS.general_medicine,
      LEGACY_GENERAL_PROJECT_ID,
    );
  }

  const identityKey = resolveGatewayProjectKey(projectKey ?? null, pilotHome);
  if (isGeneralProjectKey(identityKey, pilotHome)) {
    return resolve(
      memoryRoot,
      PROJECT_TYPE_KEYS.general_medicine,
      LEGACY_GENERAL_PROJECT_ID,
    );
  }

  const workspaceId = resolveWorkspaceId(identityKey, pilotHome);
  if (projectTypeKeyFromProjectId(workspaceId)) {
    return resolveTypedProjectMemoryDir(workspaceId, pilotHome);
  }

  // Unregistered absolute path: park under general_med with a stable slug id.
  const storageId = resolveProjectStorageId(
    typeof projectKey === "string" && projectKey ? projectKey : identityKey,
    pilotHome,
  );
  if (projectTypeKeyFromProjectId(storageId)) {
    return resolveTypedProjectMemoryDir(storageId, pilotHome);
  }
  return resolve(
    memoryRoot,
    PROJECT_TYPE_KEYS.general_medicine,
    `general_med-legacy-path-${storageId}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120),
  );
}

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
  return resolve(resolveTypedProjectDir(projectId, pilotHome), "chats");
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
  return resolve(resolveTypedProjectDir(projectId, pilotHome), "chats");
}

export function getPilotExtensionPaths(projectRoot: string, pilotHome: string): PilotExtensionPaths {
  const agentCwd = resolveAgentCwd(projectRoot, pilotHome);
  return {
    globalPluginsDir: resolve(pilotHome, "plugins"),
    globalSkillsDir: resolve(pilotHome, "skills"),
    projectPluginsDir: resolve(agentCwd, PILOT_PROJECT_DIR_NAME, "plugins"),
    projectSkillsDir: resolve(agentCwd, PILOT_PROJECT_DIR_NAME, "skills"),
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
 *
 * Bare system project ids (`general_med-*` / `trauma_med-*`) are returned as-is.
 */
export function resolveProjectStorageId(projectRoot: string, pilotHome: string): string {
  if (isBareProjectId(projectRoot)) {
    if (isGeneralWorkspaceId(projectRoot)) {
      return createProjectId(resolve(pilotHome));
    }
    if (
      projectTypeKeyFromProjectId(projectRoot)
      || existsSync(resolveTypedProjectDir(projectRoot, pilotHome))
    ) {
      return projectRoot;
    }
  }
  if (isGeneralProjectKey(projectRoot, pilotHome)) {
    return createProjectId(resolve(pilotHome));
  }
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
    for (const { projectId, markerPath } of listProjectMarkerCandidates(projectsDir)) {
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
          return projectId;
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

function* listProjectMarkerCandidates(projectsDir: string): Generator<{ projectId: string; markerPath: string }> {
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (PROJECT_TYPE_KEY_SET.has(entry.name)) {
      const typeDir = resolve(projectsDir, entry.name);
      try {
        for (const child of readdirSync(typeDir, { withFileTypes: true })) {
          if (!child.isDirectory()) continue;
          yield {
            projectId: child.name,
            markerPath: resolve(typeDir, child.name, ".cwd"),
          };
        }
      } catch {
        continue;
      }
      continue;
    }
    yield {
      projectId: entry.name,
      markerPath: resolve(projectsDir, entry.name, ".cwd"),
    };
  }
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
  if (projectKey === GENERAL_WORKSPACE_ID) return true;
  // Bare system/storage ids are never the virtual general workspace.
  if (isBareProjectId(projectKey) && !isGeneralWorkspaceId(projectKey)) {
    return false;
  }
  const resolvedKey = resolve(projectKey);
  const resolvedHome = resolve(pilotHome);
  if (resolvedKey === resolvedHome) return true;
  const generalWorkspace = resolveWorkspaceDataRoot(GENERAL_WORKSPACE_ID, pilotHome);
  return resolvedKey === resolve(generalWorkspace);
}

/**
 * Map a gateway/UI project key to the workspace storage id used under
 * `$PILOT_HOME/workspaces/[<typeKey>/]<id>/`.
 */
export function resolveWorkspaceId(projectKey: string | null | undefined, pilotHome: string): string {
  if (isGeneralProjectKey(projectKey, pilotHome)) {
    return GENERAL_WORKSPACE_ID;
  }
  if (projectKey && isBareProjectId(projectKey)) {
    return projectKey;
  }
  return resolveProjectStorageId(resolve(projectKey!), pilotHome);
}

/** Absolute path to `$PILOT_HOME/workspaces/<typeKey>/<workspaceId>/` when typed. */
export function resolveWorkspaceDataRoot(workspaceId: string, pilotHome: string): string {
  const typeKey = projectTypeKeyFromProjectId(workspaceId);
  if (typeKey) {
    return resolve(pilotHome, "workspaces", typeKey, workspaceId);
  }
  return resolve(pilotHome, "workspaces", workspaceId);
}

/** `$PILOT_HOME/archives` — retained workspace snapshots after project delete (P7). */
export function getPilotArchivesRootDir(pilotHome: string): string {
  return resolve(pilotHome, "archives");
}

/**
 * Destination for an archived project workspace:
 * `$PILOT_HOME/archives/projects/<projectId>-<timestamp>/`.
 */
export function resolveProjectArchiveDir(
  projectId: string,
  timestamp: string,
  pilotHome: string,
): string {
  const safeId = projectId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const safeTs = timestamp.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || String(Date.now());
  return resolve(pilotHome, "archives", "projects", `${safeId}-${safeTs}`);
}

/** UTC stamp safe for archive directory names, e.g. `20260827T122530Z`. */
export function formatProjectArchiveTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    "T",
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
    "Z",
  ].join("");
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
  const markerPath = resolve(resolveTypedProjectDir(workspaceId, pilotHome), ".cwd");
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
 * Gateway session/memory identity key.
 *
 * For system projects this is the project id (`general_med-*` / `trauma_med-*`),
 * not `$WS` or a linked-repo absolute path. Agent cwd / uploads still use
 * `resolveAgentCwd` → `$WS`.
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
  if (isBareProjectId(projectPath)) {
    if (isGeneralWorkspaceId(projectPath)) {
      return resolve(pilotHome);
    }
    return projectPath;
  }

  const resolvedPath = resolve(projectPath);
  const workspacesRoot = resolve(pilotHome, "workspaces");
  const prefix = workspacesRoot.endsWith("/") ? workspacesRoot : `${workspacesRoot}/`;
  if (resolvedPath === workspacesRoot || resolvedPath.startsWith(prefix)) {
    const parts = resolvedPath.slice(prefix.length).split("/").filter(Boolean);
    let relativeId = parts[0] ?? "";
    if (parts.length >= 2 && PROJECT_TYPE_KEY_SET.has(parts[0]!)) {
      relativeId = parts[1] ?? "";
    }
    if (relativeId && isGeneralWorkspaceId(relativeId)) {
      return resolve(pilotHome);
    }
    if (relativeId) {
      return relativeId;
    }
  }

  const stored = findStoredProjectId(resolvedPath, pilotHome);
  if (stored) {
    return stored;
  }
  return resolvedPath;
}

/** Gateway session transcript directory for a UI project name or workspace path. */
export function resolveProjectChatDir(projectKey: string, pilotHome: string): string {
  const gatewayKey = resolveGatewayProjectKey(projectKey, pilotHome);
  const projectId = resolveProjectStorageId(gatewayKey, pilotHome);
  return resolve(resolveTypedProjectDir(projectId, pilotHome), "chats");
}

export function resolveWorkspaceDirectoryForProjectName(
  projectName: string | null | undefined,
  pilotHome: string,
): string {
  if (!projectName || isGeneralProjectKey(projectName, pilotHome)) {
    return resolveWorkspaceDataRoot(GENERAL_WORKSPACE_ID, pilotHome);
  }
  if (isBareProjectId(projectName) || !isAbsolute(projectName)) {
    return resolveWorkspaceDataRoot(projectName, pilotHome);
  }
  const workspaceId = resolveWorkspaceId(projectName, pilotHome);
  return resolveWorkspaceDataRoot(workspaceId, pilotHome);
}

/** Enumerate project storage ids under flat and typed `projects/` trees. */
export function listProjectStorageIds(pilotHome: string): string[] {
  const projectsDir = resolve(pilotHome, "projects");
  if (!existsSync(projectsDir)) {
    return [];
  }
  const ids: string[] = [];
  for (const { projectId } of listProjectMarkerCandidates(projectsDir)) {
    ids.push(projectId);
  }
  return ids;
}
