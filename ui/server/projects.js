/**
 * Project / session metadata layer (PilotDeck-only).
 *
 * Replaces the legacy four-provider scanner that used to read
 * ~/.gemini/projects/. After the PilotDeck-only migration:
 *
 *   - `getProjects()` lists projects via `gateway.listProjects()`.
 *   - `getSessions()` lists session transcripts via
 *     `gateway.listSessions()` (PilotDeck transcripts under
 *     ~/.pilotdeck/projects/<id>/chats/<sessionKey>.jsonl).
 *   - All sessions are returned in the single `sessions` array.
 *
 * Exports preserved for external callers under ui/server/:
 *
 *     getProjects, getProjectCronJobsOverview, getSessions,
 *     renameProject, deleteSession, deleteProject, addProjectManually,
 *     extractProjectDirectory, clearProjectDirectoryCache,
 *     searchConversations
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import {
    getPilotDeckGateway,
} from './pilotdeck-bridge.js';
import { mapLegacySessionPresentation } from '../../src/web/server/legacySessionPresentation.js';
import {
    resolvePilotHome,
    createProjectId,
    createCollisionResistantProjectId,
    sanitizeSessionIdForPath,
    resolveWorkspaceDirectoryForProjectName,
    resolveWorkspaceDataRoot,
    resolveGatewayProjectKey,
    resolveProjectStorageId,
    resolveProjectChatDir,
    resolveTypedProjectDir,
    projectTypeKeyFromMetaType,
    PROJECT_TYPE_KEY_SET,
    GENERAL_WORKSPACE_ID,
    ensureWorkspaceLayout,
} from './utils/pilotPaths.js';
import { archiveAndDeleteProjectStorage } from './utils/projectDelete.js';
import { mapCronRunOutcome } from '../../src/cron/protocol/types.js';
import sessionManager from './sessionManager.js';
import { applyCustomSessionNames } from './database/db.js';

/** Project type ids (P0). Immutable after create. */
export const PROJECT_TYPES = Object.freeze({
    GENERAL_MEDICINE: 'general_medicine',
    WAR_TRAUMA: 'war_trauma',
});

export const PROJECT_TYPE_LABELS = Object.freeze({
    [PROJECT_TYPES.GENERAL_MEDICINE]: '通用医学',
    [PROJECT_TYPES.WAR_TRAUMA]: '战创伤医学',
});

const PROJECT_META_FILE = 'meta.json';
const ALLOWED_PROJECT_TYPES = new Set(Object.values(PROJECT_TYPES));

function isAllowedProjectType(type) {
    return typeof type === 'string' && ALLOWED_PROJECT_TYPES.has(type);
}

function projectMetaPath(pilotHome, projectId) {
    return path.join(resolveTypedProjectDir(projectId, pilotHome), PROJECT_META_FILE);
}

async function readProjectMeta(pilotHome, projectId) {
    try {
        const raw = await fs.readFile(projectMetaPath(pilotHome, projectId), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function writeProjectMeta(pilotHome, projectId, meta) {
    const dir = resolveTypedProjectDir(projectId, pilotHome);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
        projectMetaPath(pilotHome, projectId),
        `${JSON.stringify(meta, null, 2)}\n`,
        'utf8',
    );
}

async function allocateSystemProjectId(pilotHome, typeKey) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const id = `${typeKey}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
        try {
            await fs.access(path.join(pilotHome, 'projects', typeKey, id));
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return id;
            }
            throw error;
        }
    }
    throw new Error('Failed to allocate a unique system project id');
}

/**
 * Create a system-managed project (name + type). Files live under
 * workspaces/<typeKey>/<id>/; identity under projects/<typeKey>/<id>/meta.json.
 * `.cwd` points at the workspace root so existing list/session resolvers
 * can find the project id via the marker (P1 will further unify keys).
 */
async function createSystemProject({ displayName, type }) {
    const name = typeof displayName === 'string' ? displayName.trim() : '';
    if (!name) {
        const err = new Error('displayName is required');
        err.code = 'invalid_input';
        throw err;
    }
    if (!isAllowedProjectType(type)) {
        const err = new Error(
            `type must be one of: ${[...ALLOWED_PROJECT_TYPES].join(', ')}`,
        );
        err.code = 'invalid_input';
        throw err;
    }

    const typeKey = projectTypeKeyFromMetaType(type);
    if (!typeKey) {
        const err = new Error(`unsupported project type: ${type}`);
        err.code = 'invalid_input';
        throw err;
    }

    const pilotHome = resolvePilotHome(process.env);
    const id = await allocateSystemProjectId(pilotHome, typeKey);
    const projectDir = resolveTypedProjectDir(id, pilotHome);
    const workspacePath = resolveWorkspaceDataRoot(id, pilotHome);
    ensureWorkspaceLayout(workspacePath);

    const meta = {
        id,
        displayName: name,
        type,
        createdAt: new Date().toISOString(),
        status: 'active',
        kind: 'system',
    };
    await writeProjectMeta(pilotHome, id, meta);

    // Marker so listWebProjects / findStoredProjectId can resolve this id.
    await fs.writeFile(path.join(projectDir, '.cwd'), workspacePath, 'utf8');
    await fs.mkdir(path.join(projectDir, 'chats'), { recursive: true });

    rememberProjectDirectory(id, workspacePath);

    return {
        name: id,
        displayName: name,
        fullPath: workspacePath,
        path: workspacePath,
        projectType: type,
        type,
        status: meta.status,
        kind: 'system',
        createdAt: meta.createdAt,
    };
}

async function* iterateProjectDirs(pilotHome) {
    const projectsRoot = path.join(pilotHome, 'projects');
    let entries = [];
    try {
        entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (PROJECT_TYPE_KEY_SET.has(entry.name)) {
            const typeDir = path.join(projectsRoot, entry.name);
            let nested = [];
            try {
                nested = await fs.readdir(typeDir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const child of nested) {
                if (!child.isDirectory()) continue;
                yield { projectId: child.name, projectDir: path.join(typeDir, child.name) };
            }
            continue;
        }
        yield { projectId: entry.name, projectDir: path.join(projectsRoot, entry.name) };
    }
}

async function listSystemProjectIds(pilotHome) {
    const ids = [];
    for await (const { projectId } of iterateProjectDirs(pilotHome)) {
        const meta = await readProjectMeta(pilotHome, projectId);
        if (meta?.kind === 'system' || (meta?.type && isAllowedProjectType(meta.type))) {
            ids.push(projectId);
        }
    }
    return ids;
}
async function detectTaskMaster(projectPath) {
    try {
        const taskMasterDir = path.join(projectPath, '.taskmaster');
        const stat = await fs.stat(taskMasterDir);
        if (!stat.isDirectory()) {
            return { hasTaskmaster: false };
        }
        let tasksJson = false;
        try {
            await fs.access(path.join(taskMasterDir, 'tasks/tasks.json'));
            tasksJson = true;
        } catch {
            tasksJson = false;
        }
        return { hasTaskmaster: true, hasTasksJson: tasksJson };
    } catch {
        return { hasTaskmaster: false };
    }
}

const directoryCache = new Map();

function rememberProjectDirectory(name, fullPath) {
    if (!name || !fullPath) return;
    directoryCache.set(name, fullPath);
}

function clearProjectDirectoryCache() {
    directoryCache.clear();
}

function projectDisplayName(fullPath) {
    return path.basename(fullPath) || fullPath;
}

/**
 * Map a PilotDeck `WebSessionInfo` onto the legacy `ProjectSession`
 * shape the React frontend expects.
 */
function toLegacySession(session, projectName) {
    const presentation = mapLegacySessionPresentation(session);
    return {
        id: session.sessionId,
        title: presentation.title,
        summary: presentation.summary,
        name: presentation.name,
        createdAt: session.createdAt
            ? new Date(session.createdAt).toISOString()
            : new Date(session.lastModified || Date.now()).toISOString(),
        created_at: session.createdAt
            ? new Date(session.createdAt).toISOString()
            : new Date(session.lastModified || Date.now()).toISOString(),
        updated_at: session.lastModified
            ? new Date(session.lastModified).toISOString()
            : null,
        lastActivity: session.lastModified
            ? new Date(session.lastModified).toISOString()
            : null,
        messageCount: 0,
        cwd: session.cwd,
        customTitle: session.customTitle,
        aiTitle: session.aiTitle,
        firstPrompt: session.firstPrompt,
        tag: presentation.tag,
        parentSessionId: session.parentSessionId,
        forkedFromTurnId: session.forkedFromTurnId,
        __projectName: projectName,
    };
}

async function readMarkedProjectPaths() {
    // Scan ~/.pilotdeck/projects/[<typeKey>/]<id>/.cwd to recover real workspace paths
    // for projects whose encoded id is ambiguous (see addProjectManually).
    // Returns a Map<id, absoluteCwd>; missing/unreadable markers are skipped.
    const pilotHome = resolvePilotHome(process.env);
    const result = new Map();
    for await (const { projectId, projectDir } of iterateProjectDirs(pilotHome)) {
        const cwdFile = path.join(projectDir, '.cwd');
        try {
            const raw = await fs.readFile(cwdFile, 'utf8');
            const cwd = raw.trim();
            if (cwd) result.set(projectId, cwd);
        } catch {
            // No marker — listProjects can still surface this project via
            // its heuristic decoder when the path is unambiguous.
        }
    }
    return result;
}

async function getProjects(progressCallback = null) {
    const gateway = await getPilotDeckGateway();
    const { projects: webProjects } = await gateway.listProjects();
    const markedProjects = await readMarkedProjectPaths();
    const markedProjectIdsByPath = new Map(
        [...markedProjects.entries()].map(([id, cwd]) => [path.resolve(cwd), id]),
    );

    // Dedupe by `createProjectId(fullPath)` rather than raw path string.
    // The gateway's heuristic decoder for project ids (which collapses
    // `-` back into `/`) may produce a path that differs from the
    // verbatim path stored in `.cwd`, yet both encode to the same id —
    // and the SidebarV2 keys rows by that id. A raw-path Set would let
    // both rows through and produce a visible duplicate that share an
    // expand-state.
    //
    // Strategy: build a Map<projectId, entry> from the gateway list,
    // then for each `.cwd` marker either backfill a missing project or
    // override the existing entry's path with the marker (the marker is
    // the user-typed verbatim path, so it wins over the heuristic
    // decode). Session counts from the gateway are preserved.
    const byId = new Map();
    const pilotHome = resolvePilotHome(process.env);
    for (const project of webProjects) {
        const fullPath = project.fullPath || project.projectKey;
        if (!fullPath) continue;
        const id = markedProjectIdsByPath.get(path.resolve(fullPath)) || createProjectId(fullPath);
        if (!byId.has(id)) {
            byId.set(id, { ...project, __projectId: id });
        }
    }
    for (const [id, markedCwd] of markedProjects) {
        const existing = byId.get(id);
        if (existing) {
            existing.fullPath = markedCwd;
            existing.projectKey = markedCwd;
            existing.__projectId = id;
        } else {
            byId.set(id, {
                __projectId: id,
                fullPath: markedCwd,
                projectKey: markedCwd,
                sessionCount: 0,
            });
        }
    }

    // System projects (meta.json) may already be covered via `.cwd`; backfill any
    // that listProjects missed so create-system always shows up in the sidebar.
    for (const systemId of await listSystemProjectIds(pilotHome)) {
        if (byId.has(systemId)) continue;
        const workspacePath = resolveWorkspaceDataRoot(systemId, pilotHome);
        byId.set(systemId, {
            __projectId: systemId,
            fullPath: workspacePath,
            projectKey: workspacePath,
            sessionCount: 0,
        });
    }

    const dedupedProjects = [...byId.values()];
    const total = dedupedProjects.length;

    const result = [];
    for (let index = 0; index < dedupedProjects.length; index += 1) {
        const project = dedupedProjects[index];
        const gatewayKey = project.fullPath || project.projectKey;
        const name = project.__projectId || createProjectId(gatewayKey);
        const workspacePath = resolveWorkspaceDirectoryForProjectName(name, pilotHome);
        ensureWorkspaceLayout(workspacePath);
        rememberProjectDirectory(name, workspacePath);

        const meta = await readProjectMeta(pilotHome, name);
        const displayName = (meta?.displayName && String(meta.displayName).trim())
            || projectDisplayName(gatewayKey);
        const projectType = meta?.type && isAllowedProjectType(meta.type) ? meta.type : undefined;

        if (progressCallback) {
            progressCallback({
                phase: 'loading',
                processed: index,
                total,
                current: name,
            });
        }

        const sessionsResult = await gateway
            .listSessions({ projectKey: name, limit: 5 })
            .catch(() => ({ sessions: [] }));
        const sessions = (sessionsResult.sessions || []).map((session) =>
            toLegacySession(session, name),
        );
        applyCustomSessionNames(sessions, 'claude');

        const taskmaster = await detectTaskMaster(workspacePath).catch(() => ({
            hasTaskmaster: false,
        }));

        result.push({
            name,
            displayName,
            fullPath: workspacePath,
            path: workspacePath,
            ...(projectType ? { projectType, type: projectType } : {}),
            ...(meta?.status ? { status: meta.status } : {}),
            ...(meta?.kind ? { kind: meta.kind } : {}),
            ...(meta?.createdAt ? { createdAt: meta.createdAt } : {}),
            lastActivity: project.lastActivity,
            sessions,
            sessionMeta: {
                total: project.sessionCount ?? sessions.length,
                hasMore: (project.sessionCount ?? sessions.length) > sessions.length,
            },
            taskmaster,
        });
    }

    if (progressCallback) {
        progressCallback({ phase: 'done', processed: total, total });
    }

    // P2: do not inject a virtual "general" chat workspace. Users must create
    // a typed system project before chatting. Migrated history lives as the
    // normal project `general_med-legacy-general` when present on disk.

    return result;
}

async function getSessions(projectName, limit = 5, offset = 0) {
    const gateway = await getPilotDeckGateway();
    const pilotHome = resolvePilotHome(process.env);
    const gatewayKey = resolveGatewayProjectKey(projectName, pilotHome);
    const cursor = offset > 0 ? String(offset) : undefined;
    // Fan-out the page query and the project summary (for the authoritative
    // total session count) in parallel. Without summary.sessionCount we'd
    // have to estimate `total` as `offset + page.length + hasMoreBump`,
    // which the UI then uses to compute `remaining = total - allLoaded`.
    // That estimate drifts every page and ends up showing a stale
    // "Show more (N)" that never reaches the real count — which presents
    // to the user as a button that "doesn't react" once they've already
    // pulled in everything that exists.
    const [listResult, summary] = await Promise.all([
        gateway
            .listSessions({ projectKey: gatewayKey, limit, cursor })
            .catch(() => ({ sessions: [] })),
        gateway
            .describeProject({ projectKey: gatewayKey })
            .catch(() => null),
    ]);
    const sessions = (listResult.sessions || []).map((session) =>
        toLegacySession(session, projectName),
    );
    const hasMore = Boolean(listResult.nextCursor);
    const fallbackTotal = offset + sessions.length + (hasMore ? 1 : 0);
    const total = typeof summary?.sessionCount === 'number'
        ? summary.sessionCount
        : fallbackTotal;
    return {
        sessions,
        total,
        hasMore,
        offset,
        limit,
    };
}

/**
 * Resolve a `projectName` to the workspace data root used as agent cwd.
 */
async function extractProjectDirectory(projectName) {
    const pilotHome = resolvePilotHome(process.env);
    const workspaceDir = resolveWorkspaceDirectoryForProjectName(projectName, pilotHome);
    ensureWorkspaceLayout(workspaceDir);
    if (projectName) {
        rememberProjectDirectory(projectName, workspaceDir);
    }
    if (projectName === 'general' || projectName === GENERAL_WORKSPACE_ID) {
        rememberProjectDirectory('general', workspaceDir);
    }
    return workspaceDir;
}

async function addProjectManually(projectPath, _displayName = null) {
    if (!projectPath) {
        throw new Error('projectPath is required');
    }
    const absolute = path.resolve(projectPath);
    const pilotHome = resolvePilotHome(process.env);
    const name = await allocateProjectIdForPath(absolute, pilotHome);
    rememberProjectDirectory(name, absolute);

    // Materialize a PilotDeck project directory and drop a `.cwd` marker
    // recording the real absolute path. We need the marker because
    // createProjectId() encodes both '/' and literal '-' to '-', so the
    // PilotDeck's listWebProjects() heuristically tries each `-` as a
    // path separator and drops the project when no decode matches an
    // existing directory — which would silently lose workspaces whose
    // real path contains a dash. getProjects() reads `.cwd` to backfill
    // any project listProjects() couldn't recover.
    const projectDir = path.join(pilotHome, 'projects', name);
    try {
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(path.join(projectDir, '.cwd'), absolute, 'utf8');
    } catch (error) {
        console.warn(
            `[projects] failed to materialize PilotDeck project dir for ${name}:`,
            error?.message || error,
        );
    }

    const workspacePath = resolveWorkspaceDataRoot(name, pilotHome);
    ensureWorkspaceLayout(workspacePath);
    rememberProjectDirectory(name, workspacePath);

    return {
        name,
        displayName: projectDisplayName(absolute),
        fullPath: workspacePath,
        path: workspacePath,
    };
}

async function allocateProjectIdForPath(absolutePath, pilotHome) {
    const legacyId = createProjectId(absolutePath);
    const legacyDir = path.join(pilotHome, 'projects', legacyId);
    try {
        await fs.access(legacyDir);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return legacyId;
        }
        throw error;
    }

    const markerPath = path.join(legacyDir, '.cwd');
    try {
        const marker = (await fs.readFile(markerPath, 'utf8')).trim();
        if (marker && path.resolve(marker) === absolutePath) {
            return legacyId;
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    return createCollisionResistantProjectId(absolutePath);
}

async function renameProject(_projectName, _displayName) {
    // PilotDeck does not yet expose a rename API. Display names are derived
    // from the project's basename today, so this is a no-op.
    return { success: true };
}

async function deleteSession(projectName, sessionId, _options = {}) {
    const pilotHome = resolvePilotHome(process.env);
    const chatDir = resolveProjectChatDir(projectName, pilotHome);
    // Try the sanitized filename first (current storage layout), then the
    // raw form (legacy files written before the sanitize fix).
    const safeId = sanitizeSessionIdForPath(sessionId);
    const filenames = safeId === sessionId ? [sessionId] : [safeId, sessionId];
    let removed = false;
    for (const name of filenames) {
        const transcript = path.join(chatDir, `${name}.jsonl`);
        try {
            await fs.unlink(transcript);
            removed = true;
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }
    }
    return removed;
}

/**
 * P7: delete project chats + project memory; archive `$WS` under archives/projects.
 *
 * @returns {{ success: boolean, projectId: string, archivePath: string | null }}
 */
async function deleteProject(projectName, force = false) {
    const pilotHome = resolvePilotHome(process.env);
    const projectId = resolveProjectStorageId(
        resolveGatewayProjectKey(projectName, pilotHome),
        pilotHome,
    );
    const result = await archiveAndDeleteProjectStorage({
        pilotHome,
        projectId,
        force,
    });
    directoryCache.delete(projectName);
    directoryCache.delete(projectId);
    return result;
}

async function resolveProjectIdForPathOrName(projectName, fullPath) {
    const markedProjects = await readMarkedProjectPaths();
    if (projectName && !path.isAbsolute(projectName) && markedProjects.has(projectName)) {
        return projectName;
    }
    const resolved = path.resolve(fullPath);
    for (const [id, cwd] of markedProjects) {
        if (path.resolve(cwd) === resolved) {
            return id;
        }
    }
    return createProjectId(fullPath);
}

async function getProjectCronJobsOverview(projectName) {
    try {
        const gateway = await getPilotDeckGateway();
        const pilotHome = resolvePilotHome(process.env);
        const projectKey = projectName
            ? resolveGatewayProjectKey(projectName, pilotHome)
            : undefined;
        const result = await gateway.cronList({
            projectKey,
            includeHistory: true,
            limit: 50,
        });
        const runsByTaskId = new Map();
        if (Array.isArray(result.recentRuns)) {
            for (const run of result.recentRuns) {
                if (!run.taskId) continue;
                const existing = runsByTaskId.get(run.taskId);
                if (!existing || run.startedAt > existing.startedAt) {
                    runsByTaskId.set(run.taskId, run);
                }
            }
        }
        const jobs = (result.tasks || []).map((task) => {
            const latestRun = runsByTaskId.get(task.taskId) || null;
            const isCron = task.schedule?.type === 'cron';
            return {
                id: task.taskId,
                projectKey: task.projectKey || null,
                cron: isCron ? task.schedule.expression : '',
                prompt: task.message || '',
                createdAt: task.createdAt,
                nextRunAt: task.nextRunAt,
                recurring: isCron,
                permanent: isCron,
                manualOnly: false,
                status: task.status === 'running' ? 'running' : 'scheduled',
                lastFiredAt: latestRun?.startedAt ? new Date(latestRun.startedAt).getTime() : undefined,
                latestRun: latestRun ? {
                    status: mapCronRunOutcome(latestRun.outcome, latestRun.finishedAt),
                    runId: latestRun.runId,
                    startedAt: latestRun.startedAt,
                    taskId: latestRun.taskId,
                    sessionId: latestRun.sessionKey,
                } : null,
            };
        });
        return { jobs };
    } catch (error) {
        console.warn('[projects] cronList via gateway failed, returning empty:', error?.message);
        return { jobs: [] };
    }
}

async function searchConversations(query, limit = 50, onProjectResult = null, signal = null) {
    const needle = (query || '').trim().toLowerCase();
    if (!needle) {
        return { totalMatches: 0 };
    }
    const projects = await getProjects();
    let totalMatches = 0;
    for (let index = 0; index < projects.length; index += 1) {
        if (signal?.aborted) break;
        const project = projects[index];
        const matches = (project.sessions || []).filter((session) => {
            const haystack = [
                session.title,
                session.summary,
                session.customTitle,
                session.aiTitle,
                session.firstPrompt,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return haystack.includes(needle);
        });
        if (matches.length > 0) {
            const projectResult = {
                project: { name: project.name, fullPath: project.fullPath },
                matches,
            };
            totalMatches += matches.length;
            if (onProjectResult) {
                await Promise.resolve(
                    onProjectResult({
                        projectResult,
                        totalMatches,
                        scannedProjects: index + 1,
                        totalProjects: projects.length,
                    }),
                ).catch(() => undefined);
            }
            if (totalMatches >= limit) break;
        }
    }
    return { totalMatches };
}

export {
    getProjects,
    getProjectCronJobsOverview,
    getSessions,
    renameProject,
    deleteSession,
    deleteProject,
    addProjectManually,
    createSystemProject,
    extractProjectDirectory,
    clearProjectDirectoryCache,
    searchConversations,
};
