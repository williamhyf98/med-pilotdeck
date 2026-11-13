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
    abortViaGateway,
    isSessionActiveViaGateway,
} from './pilotdeck-bridge.js';
import { mapLegacySessionPresentation } from '../../src/web/server/legacySessionPresentation.js';
import {
    resolveScopedHome,
    assertPathInUserHome,
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
    projectTypeKeyFromProjectId,
    PROJECT_TYPE_KEY_SET,
    GENERAL_WORKSPACE_ID,
    ensureWorkspaceLayout,
} from './utils/pilotPaths.js';
import { deleteSessionArtifacts } from './utils/sessionCleanup.js';
import { purgeSessionMemoryRows } from './services/sessionMemory.js';
import { purgeProjectStorage } from './utils/projectDelete.js';
import { mapCronRunOutcome } from '../../src/cron/protocol/types.js';
import sessionManager from './sessionManager.js';
import { applyCustomSessionNames, sessionNamesDb } from './database/db.js';
import { requireUserScope } from './middleware/userScope.js';

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
const CREATABLE_PROJECT_TYPES = new Set([
    PROJECT_TYPES.GENERAL_MEDICINE,
    PROJECT_TYPES.WAR_TRAUMA,
]);

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
    if (!CREATABLE_PROJECT_TYPES.has(type)) {
        const err = new Error(`type must be one of: ${[...CREATABLE_PROJECT_TYPES].join(', ')}`);
        err.code = 'invalid_input';
        throw err;
    }

    const typeKey = projectTypeKeyFromMetaType(type);
    if (!typeKey) {
        const err = new Error(`unsupported project type: ${type}`);
        err.code = 'invalid_input';
        throw err;
    }

    const pilotHome = resolveScopedHome();
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
    await fs.writeFile(path.join(projectDir, '.cwd'), path.relative(pilotHome, workspacePath), 'utf8');
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
    const pilotHome = resolveScopedHome();
    const result = new Map();
    for await (const { projectId, projectDir } of iterateProjectDirs(pilotHome)) {
        const cwdFile = path.join(projectDir, '.cwd');
        try {
            const raw = await fs.readFile(cwdFile, 'utf8');
            const cwd = raw.trim() ? path.resolve(pilotHome, raw.trim()) : '';
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
    const pilotHome = resolveScopedHome();
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
        applyCustomSessionNames(requireUserScope().userId, sessions, 'claude');

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
    const pilotHome = resolveScopedHome();
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
    const pilotHome = resolveScopedHome();
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
    const pilotHome = resolveScopedHome();
    const name = await allocateProjectIdForPath(absolute, pilotHome);
    rememberProjectDirectory(name, absolute);

    // Materialize a PilotDeck project directory and drop a `.cwd` marker
    // recording a path relative to PILOT_HOME. We need the marker because
    // createProjectId() encodes both '/' and literal '-' to '-', so the
    // PilotDeck's listWebProjects() heuristically tries each `-` as a
    // path separator and drops the project when no decode matches an
    // existing directory — which would silently lose workspaces whose
    // real path contains a dash. getProjects() reads `.cwd` to backfill
    // any project listProjects() couldn't recover.
    const projectDir = path.join(pilotHome, 'projects', name);
    try {
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(path.join(projectDir, '.cwd'), path.relative(pilotHome, absolute) || '.', 'utf8');
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
        if (marker && path.resolve(pilotHome, marker) === absolutePath) {
            return legacyId;
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    return createCollisionResistantProjectId(absolutePath);
}

async function renameProject(projectName, displayName) {
    const name = typeof displayName === 'string' ? displayName.trim() : '';
    if (!name) {
        const error = new Error('displayName is required');
        error.code = 'invalid_input';
        throw error;
    }
    if (typeof projectName !== 'string' || !projectName || projectName === '.' || projectName === '..'
        || projectName.includes('/') || projectName.includes('\\')) {
        const error = new Error('Invalid project name');
        error.code = 'invalid_input';
        throw error;
    }
    const pilotHome = resolveScopedHome();
    const metaFile = projectMetaPath(pilotHome, projectName);
    assertPathInUserHome(metaFile, pilotHome, true);
    let meta = await readProjectMeta(pilotHome, projectName);
    if (!meta) {
        const typeKey = projectTypeKeyFromProjectId(projectName);
        const projectDir = resolveTypedProjectDir(projectName, pilotHome);
        const stat = await fs.stat(projectDir).catch((error) => {
            if (error?.code === 'ENOENT') return null;
            throw error;
        });
        if (stat?.isDirectory() && typeKey) {
            meta = {
                id: projectName,
                type: typeKey === 'trauma_med' ? PROJECT_TYPES.WAR_TRAUMA : PROJECT_TYPES.GENERAL_MEDICINE,
                kind: 'system',
            };
        }
    }
    if (!meta || (meta.id && meta.id !== projectName) || !isAllowedProjectType(meta.type)) {
        const error = new Error('Project not found');
        error.code = 'project_not_found';
        throw error;
    }
    const temporary = `${metaFile}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify({ ...meta, displayName: name }, null, 2)}\n`,
            { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, metaFile);
    } finally {
        await fs.rm(temporary, { force: true });
    }
    return { success: true };
}

async function deleteSession(projectName, sessionId, options = {}) {
    const pilotHome = resolveScopedHome();
    // 子任务会话（background_task）的 transcript 落在父会话目录下，
    // 只能靠调用方给的相对路径定位；这里一路透传，别吞掉。
    const result = await deleteSessionArtifacts(projectName, sessionId, {
        pilotHome,
        relativeTranscriptPath: options.relativeTranscriptPath ?? undefined,
    });
    // 文件清完还要清记忆库里的原始对话（L0）。L1/L2 是项目级提炼结论，按设计保留。
    const memory = await purgeSessionMemoryRows({
        projectId: result.projectId,
        sessionId: result.sessionId,
        pilotHome,
    });
    return { ...result, deleted: { ...result.deleted, memoryRows: memory.deletedRows } };
}

/** 项目 chats 目录里的所有会话 id（排除回退影子副本）。 */
async function listProjectSessionIds(chatDir) {
    let entries = [];
    try {
        entries = await fs.readdir(chatDir);
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    return entries
        .filter((name) => name.endsWith('.jsonl') && !name.includes('.pre-rewind'))
        .map((name) => name.slice(0, -'.jsonl'.length));
}

/**
 * 删掉绑在这个项目上的 cron 任务。
 *
 * 项目没了但定时任务还在，下一次到点就会拿旧 projectKey 空跑一轮；
 * 网关不可用/超时都只记日志 —— 不能因为清理附属物失败就卡住"删项目"本身。
 */
async function deleteProjectCronTasks(projectId) {
    const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
    try {
        const gateway = await withTimeout(getPilotDeckGateway(), 5000);
        if (!gateway) return { deleted: 0, reason: 'timeout' };
        const listed = await withTimeout(
            gateway.cronList({ projectKey: projectId, includeHistory: false, limit: 200 }),
            5000,
        );
        const tasks = Array.isArray(listed?.tasks) ? listed.tasks : [];
        let deleted = 0;
        for (const task of tasks) {
            if (!task?.taskId) continue;
            const ok = await withTimeout(
                gateway.cronDelete({ taskId: task.taskId, projectKey: projectId, stopRunning: true })
                    .then(() => true),
                5000,
            );
            if (ok) deleted += 1;
        }
        return { deleted };
    } catch (error) {
        console.warn('[projects] cron cleanup on delete failed:', error?.message ?? error);
        return { deleted: 0, reason: 'error' };
    }
}

/**
 * 删除项目（2026-11-12 起是**真删**，不留归档、不进回收站）。
 *
 * 顺序是刻意的：先能失败的（掐运行、删 cron），最后动不可逆的磁盘。
 * 任何一步失败都抛错并说明停在哪，不做"删一半当成功"。
 *
 * @param {string} projectName 项目名 / 项目 id
 * @param {{ force?: boolean, confirmName?: string }} [options]
 * @returns {Promise<{ success: boolean, projectId: string, deleted: object }>}
 */
async function deleteProject(projectName, options = {}) {
    const force = Boolean(options.force);
    const pilotHome = resolveScopedHome();
    const projectId = resolveProjectStorageId(
        resolveGatewayProjectKey(projectName, pilotHome),
        pilotHome,
    );

    // 输入项目名确认（存储页与侧边栏都走这条）：接受展示名、项目 id、调用方给的名字。
    if (typeof options.confirmName === 'string') {
        const meta = await readProjectMeta(pilotHome, projectId).catch(() => null);
        const displayName = typeof meta?.displayName === 'string' && meta.displayName.trim()
            ? meta.displayName.trim()
            : projectId;
        const accepted = new Set([displayName, projectId, projectName].filter(Boolean));
        if (!accepted.has(options.confirmName.trim())) {
            throw Object.assign(new Error('Confirmation name does not match the project'), {
                code: 'CONFIRM_MISMATCH',
            });
        }
    }

    const chatDir = resolveProjectChatDir(projectName, pilotHome);
    const sessionIds = await listProjectSessionIds(chatDir);

    // 1) 掐掉还在跑的 turn：不掐的话网关会在删除之后继续往旧路径写。
    for (const sessionId of sessionIds) {
        if (!isSessionActiveViaGateway(sessionId)) continue;
        try {
            await abortViaGateway(sessionId);
        } catch (error) {
            console.warn(`[projects] abort on project delete failed for ${sessionId}:`, error?.message ?? error);
        }
    }

    // 2) 删网关里的定时任务（best-effort）。
    const cron = await deleteProjectCronTasks(projectId);

    // 3) 真删磁盘。
    const result = await purgeProjectStorage({ pilotHome, projectId, force });

    // 4) 清会话名（SQLite）。做在磁盘之后：名字行是最后一点痕迹。
    try {
        sessionNamesDb.deleteNamesForSessions(requireUserScope().userId, sessionIds);
    } catch (error) {
        console.warn('[projects] session_names cleanup failed:', error?.message ?? error);
    }

    directoryCache.delete(projectName);
    directoryCache.delete(projectId);
    return { ...result, cron };
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
        const pilotHome = resolveScopedHome();
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
