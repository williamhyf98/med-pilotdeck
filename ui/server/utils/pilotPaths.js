/**
 * Pure-JS port of the path helpers from `src/pilot/paths.ts`.
 *
 * Lets `ui/server/` resolve `~/.pilotdeck` and encode project IDs the
 * same way the gateway server does, WITHOUT pulling `dist/src/pilot/`
 * into the express bridge. Keeping the math here means the UI server
 * can run from source without needing the TypeScript output to exist
 * on disk first.
 *
 * Keep this in sync with `src/pilot/paths.ts` — both must round-trip
 * identically or `~/.pilotdeck/projects/<id>/.cwd` markers written by
 * the bridge will not be found by `gateway.listProjects()` and vice
 * versa.
 */
import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';

export const DEFAULT_PILOT_HOME = '~/.pilotdeck';
export const GENERAL_WORKSPACE_ID = 'general';

/** Directory / id-prefix keys (avoid colliding with legacy virtual `general`). */
export const PROJECT_TYPE_KEYS = Object.freeze({
    general_medicine: 'general_med',
    war_trauma: 'trauma_med',
});

export const PROJECT_TYPE_KEY_SET = new Set(Object.values(PROJECT_TYPE_KEYS));

/** Stable system project id that owns pre-typed general-chat memory (P0.1 migration). */
export const LEGACY_GENERAL_PROJECT_ID = 'general_med-legacy-general';

export function isProjectMetaType(value) {
    return Boolean(value && Object.prototype.hasOwnProperty.call(PROJECT_TYPE_KEYS, value));
}

export function projectTypeKeyFromMetaType(type) {
    if (!isProjectMetaType(type)) return null;
    return PROJECT_TYPE_KEYS[type];
}

export function projectTypeKeyFromProjectId(projectId) {
    if (!projectId) return null;
    if (projectId.startsWith(`${PROJECT_TYPE_KEYS.general_medicine}-`)) {
        return PROJECT_TYPE_KEYS.general_medicine;
    }
    if (projectId.startsWith(`${PROJECT_TYPE_KEYS.war_trauma}-`)) {
        return PROJECT_TYPE_KEYS.war_trauma;
    }
    return null;
}

/** True when value is a storage/id token, not a filesystem path. */
export function isBareProjectId(value) {
    if (!value) return false;
    return !isAbsolute(value) && !value.includes('/') && !value.includes('\\');
}

/** `$PILOT_HOME/projects/<typeKey>/<projectId>` or legacy flat `$PILOT_HOME/projects/<id>`. */
export function resolveTypedProjectDir(projectId, pilotHome = resolvePilotHome()) {
    const typeKey = projectTypeKeyFromProjectId(projectId);
    if (typeKey) {
        return resolve(pilotHome, 'projects', typeKey, projectId);
    }
    return resolve(pilotHome, 'projects', projectId);
}

/** `$PILOT_HOME/memory/<typeKey>/<projectId>` for typed system projects. */
export function resolveTypedProjectMemoryDir(projectId, pilotHome = resolvePilotHome()) {
    const typeKey = projectTypeKeyFromProjectId(projectId);
    if (!typeKey) {
        throw new Error(`Not a typed system project id: ${projectId}`);
    }
    return resolve(pilotHome, 'memory', typeKey, projectId);
}

export function getPilotMemoryRootDir(pilotHome = resolvePilotHome()) {
    return resolve(pilotHome, 'memory');
}

/**
 * On-disk memory data directory for a project key / agent cwd.
 * Virtual general shares general_med-legacy-general until P2 removes it.
 */
export function resolveProjectMemoryDataDir(projectKey, pilotHome = resolvePilotHome()) {
    const memoryRoot = getPilotMemoryRootDir(pilotHome);
    if (isGeneralProjectKey(projectKey, pilotHome)) {
        return resolve(memoryRoot, PROJECT_TYPE_KEYS.general_medicine, LEGACY_GENERAL_PROJECT_ID);
    }

    const identityKey = resolveGatewayProjectKey(projectKey, pilotHome);
    if (isGeneralProjectKey(identityKey, pilotHome)) {
        return resolve(memoryRoot, PROJECT_TYPE_KEYS.general_medicine, LEGACY_GENERAL_PROJECT_ID);
    }

    const workspaceId = resolveWorkspaceId(identityKey, pilotHome);
    if (projectTypeKeyFromProjectId(workspaceId)) {
        return resolveTypedProjectMemoryDir(workspaceId, pilotHome);
    }

    const storageId = resolveProjectStorageId(
        typeof projectKey === 'string' && projectKey ? projectKey : identityKey,
        pilotHome,
    );
    if (projectTypeKeyFromProjectId(storageId)) {
        return resolveTypedProjectMemoryDir(storageId, pilotHome);
    }
    return resolve(
        memoryRoot,
        PROJECT_TYPE_KEYS.general_medicine,
        `general_med-legacy-path-${storageId}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120),
    );
}

function normalizeHomePath(p) {
    if (p === '~') return homedir();
    if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
    return resolve(p);
}

/**
 * Resolve the active PilotDeck home directory. Honors `PILOT_HOME` so
 * tests / multi-instance setups can isolate state. Defaults to
 * `~/.pilotdeck`.
 *
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @returns {string} Absolute path.
 */
export function resolvePilotHome(env = process.env) {
    return normalizeHomePath(env.PILOT_HOME ?? DEFAULT_PILOT_HOME);
}

/**
 * Encode an absolute project path into the on-disk project ID used under
 * `~/.pilotdeck/projects/<id>/`.
 *
 * This is the legacy lossy encoding. New UI-created projects use
 * `createCollisionResistantProjectId()` only when this id is already claimed
 * by a different `.cwd` marker.
 *
 * @param {string} projectRoot Absolute filesystem path.
 * @returns {string} Encoded project ID.
 */
export function createProjectId(projectRoot) {
    const normalizedRoot = resolve(projectRoot);
    return createLegacyProjectId(normalizedRoot);
}

export function createCollisionResistantProjectId(projectRoot) {
    const normalizedRoot = resolve(projectRoot);
    const legacyId = createLegacyProjectId(normalizedRoot);
    const digest = createHash('sha1').update(normalizedRoot).digest('hex').slice(0, 10);
    return `${legacyId}--${digest}`;
}

/**
 * Resolve the on-disk project directory name for a workspace.
 *
 * `.cwd` markers disambiguate paths that collapse to the same legacy slug.
 * If no valid marker exists, preserve the legacy ID for compatibility with
 * unregistered workspaces.
 *
 * @param {string} projectRoot Absolute filesystem path.
 * @param {string} [pilotHome] Active PilotDeck home directory.
 * @returns {string} Project directory name under `<pilotHome>/projects`.
 */
export function resolveProjectStorageId(projectRoot, pilotHome = resolvePilotHome()) {
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
 * Sanitize a sessionId for safe use as a filename component.
 *
 * TUI/CLI sessionKeys embed the absolute project path (e.g.
 * `tui:project=/Users/foo/work/repo:default`). Without sanitization
 * the raw `/` characters make `path.resolve()` treat it as multiple
 * path segments, burying the transcript in nested dirs that
 * `listProjectSessions` can't find.
 *
 * Keep in sync with `src/session/storage/ProjectSessionStorage.ts`.
 *
 * @param {string} sessionId Raw session key.
 * @returns {string} Filename-safe session identifier.
 */
export function sanitizeSessionIdForPath(sessionId) {
    const illegal = process.platform === 'win32' ? /[\\/:<>"|?*]+/g : /[\\/]+/g;
    return sessionId.replace(illegal, '-').replace(/^-+|-+$/g, '') || 'session';
}

function createLegacyProjectId(projectRoot) {
    // Normalize to forward slashes so the same physical path produces the same
    // project ID on Windows (\) and Unix (/). Also strip a Windows drive-letter
    // prefix (e.g. "C:") so "C:\Users\foo" slugifies identically to "/Users/foo".
    const normalized = projectRoot.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
    return normalized.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function* listProjectMarkerCandidates(projectsDir) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (PROJECT_TYPE_KEY_SET.has(entry.name)) {
            const typeDir = resolve(projectsDir, entry.name);
            let nested;
            try {
                nested = readdirSync(typeDir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const child of nested) {
                if (!child.isDirectory()) continue;
                yield {
                    projectId: child.name,
                    markerPath: resolve(typeDir, child.name, '.cwd'),
                };
            }
            continue;
        }
        yield {
            projectId: entry.name,
            markerPath: resolve(projectsDir, entry.name, '.cwd'),
        };
    }
}

function findStoredProjectId(projectRoot, pilotHome) {
    const projectsDir = resolve(pilotHome, 'projects');
    if (!existsSync(projectsDir)) return null;

    const target = normalizeProjectPathForMarkerComparison(projectRoot);
    try {
        for (const { projectId, markerPath } of listProjectMarkerCandidates(projectsDir)) {
            let marker;
            try {
                marker = readFileSync(markerPath, 'utf8').trim();
            } catch {
                continue;
            }
            if (!marker || normalizeProjectPathForMarkerComparison(marker) !== target) continue;
            try {
                if (statSync(marker).isDirectory()) return projectId;
            } catch {
                continue;
            }
        }
    } catch {
        return null;
    }
    return null;
}

function normalizeProjectPathForMarkerComparison(projectRoot) {
    const resolved = resolve(projectRoot);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isGeneralWorkspaceId(workspaceId) {
    return workspaceId === GENERAL_WORKSPACE_ID;
}

export function isGeneralProjectKey(projectKey, pilotHome = resolvePilotHome()) {
    if (!projectKey) return true;
    if (projectKey === GENERAL_WORKSPACE_ID) return true;
    if (isBareProjectId(projectKey) && !isGeneralWorkspaceId(projectKey)) {
        return false;
    }
    const resolvedKey = resolve(projectKey);
    const resolvedHome = resolve(pilotHome);
    if (resolvedKey === resolvedHome) return true;
    const generalWorkspace = resolveWorkspaceDataRoot(GENERAL_WORKSPACE_ID, pilotHome);
    return resolvedKey === resolve(generalWorkspace);
}

export function resolveWorkspaceId(projectKey, pilotHome = resolvePilotHome()) {
    if (isGeneralProjectKey(projectKey, pilotHome)) {
        return GENERAL_WORKSPACE_ID;
    }
    if (projectKey && isBareProjectId(projectKey)) {
        return projectKey;
    }
    return resolveProjectStorageId(resolve(projectKey), pilotHome);
}

export function resolveWorkspaceDataRoot(workspaceId, pilotHome = resolvePilotHome()) {
    const typeKey = projectTypeKeyFromProjectId(workspaceId);
    if (typeKey) {
        return resolve(pilotHome, 'workspaces', typeKey, workspaceId);
    }
    return resolve(pilotHome, 'workspaces', workspaceId);
}

export function resolveAgentCwd(projectKey, pilotHome = resolvePilotHome()) {
    const workspaceId = resolveWorkspaceId(projectKey, pilotHome);
    return resolveWorkspaceDataRoot(workspaceId, pilotHome);
}

export function resolveInboxBatchDir(workspaceDataRoot, batchId) {
    return resolve(workspaceDataRoot, 'inbox', batchId);
}

export function resolveInboxDerivedDir(workspaceDataRoot, batchId) {
    return resolve(workspaceDataRoot, 'inbox', batchId, 'derived');
}

export function resolveWorkspaceExportsDir(workspaceDataRoot) {
    return resolve(workspaceDataRoot, 'exports');
}

export function resolveWorkspaceScratchDir(workspaceDataRoot) {
    return resolve(workspaceDataRoot, 'scratch');
}

export function ensureWorkspaceLayout(workspaceDataRoot) {
    const dirs = [
        resolve(workspaceDataRoot, 'inbox'),
        resolve(workspaceDataRoot, 'exports'),
        resolve(workspaceDataRoot, 'scratch', 'qa'),
        resolve(workspaceDataRoot, 'scratch', 'work'),
        resolve(workspaceDataRoot, 'scratch', 'preview'),
        resolve(workspaceDataRoot, 'scratch', 'tool-results'),
    ];
    for (const dir of dirs) {
        mkdirSync(dir, { recursive: true });
    }
}

export function resolveAssociatedProjectPath(workspaceId, pilotHome = resolvePilotHome()) {
    if (isGeneralWorkspaceId(workspaceId)) {
        return null;
    }
    const markerPath = resolve(resolveTypedProjectDir(workspaceId, pilotHome), '.cwd');
    try {
        const marker = readFileSync(markerPath, 'utf8').trim();
        if (marker && statSync(marker).isDirectory()) {
            return resolve(marker);
        }
    } catch {
        return null;
    }
    return null;
}

export function resolveGatewayProjectKey(projectPath, pilotHome = resolvePilotHome()) {
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
    const workspacesRoot = resolve(pilotHome, 'workspaces');
    const prefix = workspacesRoot.endsWith('/') ? workspacesRoot : `${workspacesRoot}/`;
    if (resolvedPath === workspacesRoot || resolvedPath.startsWith(prefix)) {
        const parts = resolvedPath.slice(prefix.length).split('/').filter(Boolean);
        let relativeId = parts[0] ?? '';
        if (parts.length >= 2 && PROJECT_TYPE_KEY_SET.has(parts[0])) {
            relativeId = parts[1] ?? '';
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
export function resolveProjectChatDir(projectKey, pilotHome = resolvePilotHome()) {
    const gatewayKey = resolveGatewayProjectKey(projectKey, pilotHome);
    const projectId = resolveProjectStorageId(gatewayKey, pilotHome);
    return resolve(resolveTypedProjectDir(projectId, pilotHome), 'chats');
}

/** Linked repository path for git/taskmaster/terminal. Not the gateway identity key. */
export function resolveLinkedRepoPath(projectKey, pilotHome = resolvePilotHome()) {
    const identityKey = resolveGatewayProjectKey(projectKey, pilotHome);
    const agentCwd = resolveAgentCwd(identityKey, pilotHome);
    const workspaceId = resolveWorkspaceId(identityKey, pilotHome);
    const associated = resolveAssociatedProjectPath(workspaceId, pilotHome);
    if (associated && resolve(associated) !== resolve(agentCwd)) {
        return associated;
    }
    return agentCwd;
}

export function resolveWorkspaceDirectoryForProjectName(projectName, pilotHome = resolvePilotHome()) {
    if (!projectName || isGeneralProjectKey(projectName, pilotHome)) {
        return resolveWorkspaceDataRoot(GENERAL_WORKSPACE_ID, pilotHome);
    }
    if (isBareProjectId(projectName) || !isAbsolute(projectName)) {
        return resolveWorkspaceDataRoot(projectName, pilotHome);
    }
    const workspaceId = resolveWorkspaceId(projectName, pilotHome);
    return resolveWorkspaceDataRoot(workspaceId, pilotHome);
}

export function listProjectStorageIds(pilotHome = resolvePilotHome()) {
    const projectsDir = resolve(pilotHome, 'projects');
    if (!existsSync(projectsDir)) return [];
    const ids = [];
    for (const { projectId } of listProjectMarkerCandidates(projectsDir)) {
        ids.push(projectId);
    }
    return ids;
}

export function resolveAgentAdditionalWorkingDirectories(projectKey, pilotHome = resolvePilotHome()) {
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
