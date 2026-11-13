/**
 * 存储页（设置 → 存储）的唯一数据源。
 *
 * 2026-11-12 重构后语义收窄为「**项目视角**」：
 *
 * - 只列**在用项目**：名称 / 类型 / 会话数 / 占用 / 回收站占用 / 最后活动；
 * - 项目里的目录清单与**工作区页面一致**（inbox / exports / scratch + 用户自建目录）；
 *   隐藏目录（`.trash` / `.pilotdeck`）不出现，`.pilotdeck` 也不计入占用；
 * - 只提供两个动作：只读预览文件、**永久删除整个项目**；
 * - 不再有归档 tab，也不再从这一页删单个文件（文件级删除只属于工作区页的回收站）。
 *
 * 删除动作本身走 `DELETE /api/projects/:projectName`（见 `projects.deleteProject`），
 * 这里不重复实现，避免两套删除语义。
 */
import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import {
    assertPathInUserHome,
    PROJECT_TYPE_KEYS,
    resolveScopedHome,
} from '../utils/pilotPaths.js';
import { listTrash } from '../services/trash.js';

const router = express.Router();
const TYPE_KEYS = new Set(Object.values(PROJECT_TYPE_KEYS));
const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.json', '.jsonl', '.xml', '.csv', '.tsv',
    '.yaml', '.yml', '.log', '.html', '.htm', '.css', '.js', '.ts', '.py',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;

function invalidInput(message) {
    const error = new Error(message);
    error.code = 'invalid_input';
    return error;
}

function isSafeSegment(value) {
    return typeof value === 'string'
        && value.length > 0
        && value !== '.'
        && value !== '..'
        && !value.includes('/')
        && !value.includes('\\')
        && !value.includes('\0');
}

function assertInside(root, target) {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
    throw invalidInput('Path is outside the managed storage root');
}

function assertWithinUserHome(target, pilotHome) {
    try {
        assertPathInUserHome(target, pilotHome);
    } catch {
        throw invalidInput('Path is outside the managed storage root');
    }
}

function previewKind(filename) {
    const extension = path.extname(filename).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) return 'image';
    if (extension === '.pdf') return 'pdf';
    if (TEXT_EXTENSIONS.has(extension)) return 'text';
    return null;
}

async function readDirectoryNames(directory) {
    try {
        return await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

async function scanFiles(root) {
    const files = [];

    async function visit(directory) {
        const entries = await readDirectoryNames(directory);
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const absolutePath = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) continue;
            // `.` 开头的都是内部物件，不当作"用户的文件"：
            // `.trash`（软删除，单独记 trashBytes）、`.pilotdeck`（会话级过程数据，
            // 有自己的 14 天 TTL）、`.usage.json` / `.pinned` 之类的记账文件。
            // 与工作区页面一致：那边也是 name.startsWith('.') 一律不显示。
            if (entry.name.startsWith('.')) continue;
            if (entry.isDirectory()) {
                await visit(absolutePath);
                continue;
            }
            if (!entry.isFile()) continue;
            const stat = await fs.stat(absolutePath);
            const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
            files.push({
                path: relativePath,
                name: entry.name,
                sizeBytes: stat.size,
                previewKind: previewKind(entry.name),
            });
        }
    }

    await visit(root);
    return files;
}

/** 三个默认目录（工作区布局保证存在）+ 用户自建的顶层目录。 */
const DEFAULT_TOP_LEVEL_DIRS = ['inbox', 'exports', 'scratch'];

/**
 * 顶层目录清单：**和工作区页面看到的一模一样** —— 三个规定目录永远在，
 * 再加用户新建的顶层目录（空的也列出来，否则"我建的空目录去哪了"）。
 * 这里的数字都从已扫出的 `files[]` 里算，不额外遍历。
 */
async function readTopLevelFolders(root, files) {
    const counts = new Map();
    const sizes = new Map();
    for (const file of files) {
        const top = file.path.split('/')[0];
        counts.set(top, (counts.get(top) ?? 0) + 1);
        sizes.set(top, (sizes.get(top) ?? 0) + file.sizeBytes);
    }

    const names = new Set(DEFAULT_TOP_LEVEL_DIRS);
    const directoryNames = new Set();
    for (const entry of await readDirectoryNames(root)) {
        // 只认目录；隐藏目录（.trash / .pilotdeck）不进清单
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        directoryNames.add(entry.name);
        names.add(entry.name);
    }
    // 顶层散落文件（正常布局里不会有，但别让它从页面上凭空消失）
    for (const top of counts.keys()) {
        if (!directoryNames.has(top)) names.add(top);
    }

    const ordered = [
        ...DEFAULT_TOP_LEVEL_DIRS,
        ...[...names].filter((name) => !DEFAULT_TOP_LEVEL_DIRS.includes(name)).sort((a, b) => a.localeCompare(b)),
    ];
    return ordered.map((name) => ({
        name,
        fileCount: counts.get(name) ?? 0,
        sizeBytes: sizes.get(name) ?? 0,
    }));
}

/**
 * 工作区用量按顶层目录聚合：只从已经扫出来的 `files[]` 里加，不额外遍历磁盘。
 * 自定义目录（如 `我的资料/`）不进这三项，所以 `inbox + exports + scratch <= totalBytes`。
 */
function aggregateUsage(files, totalBytes) {
    const usage = {
        inboxBytes: 0,
        exportsBytes: 0,
        scratchBytes: 0,
        totalBytes,
    };
    for (const file of files) {
        const topLevel = file.path.split('/')[0];
        if (topLevel === 'inbox') usage.inboxBytes += file.sizeBytes;
        else if (topLevel === 'exports') usage.exportsBytes += file.sizeBytes;
        else if (topLevel === 'scratch') usage.scratchBytes += file.sizeBytes;
    }
    return usage;
}

/** 单个工作区（任意目录）的用量，给工作区面板的三条用量条用。 */
export async function measureWorkspaceUsage(workspaceRoot) {
    const files = await scanFiles(workspaceRoot);
    return aggregateUsage(
        files,
        files.reduce((sum, file) => sum + file.sizeBytes, 0),
    );
}

async function readProjectMeta(pilotHome, typeKey, projectId) {
    try {
        const raw = await fs.readFile(
            path.join(pilotHome, 'projects', typeKey, projectId, 'meta.json'),
            'utf8',
        );
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * 会话数与最后活动时间：数 `projects/<类型>/<项目>/chats/*.jsonl`。
 * 回退影子副本（`.pre-rewind`）不是独立会话，跳过。
 */
async function readSessionStats(pilotHome, typeKey, projectId) {
    const chatDir = path.join(pilotHome, 'projects', typeKey, projectId, 'chats');
    let entries = [];
    try {
        entries = await fs.readdir(chatDir, { withFileTypes: true });
    } catch {
        return { sessionCount: 0, lastActivityAt: null };
    }
    let count = 0;
    let last = 0;
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.includes('.pre-rewind')) continue;
        count += 1;
        try {
            const stat = await fs.stat(path.join(chatDir, entry.name));
            if (stat.mtimeMs > last) last = stat.mtimeMs;
        } catch {
            // 统计失败不影响列表
        }
    }
    return { sessionCount: count, lastActivityAt: last > 0 ? new Date(last).toISOString() : null };
}

async function scanProjectGroups(pilotHome) {
    const workspaceRoot = path.join(pilotHome, 'workspaces');
    const projects = [];
    for (const typeEntry of await readDirectoryNames(workspaceRoot)) {
        if (!typeEntry.isDirectory() || !TYPE_KEYS.has(typeEntry.name)) continue;
        const typeRoot = path.join(workspaceRoot, typeEntry.name);
        for (const projectEntry of await readDirectoryNames(typeRoot)) {
            if (!projectEntry.isDirectory() || !isSafeSegment(projectEntry.name)) continue;
            const groupRoot = path.join(typeRoot, projectEntry.name);
            const [files, meta, trashEntries, sessionStats] = await Promise.all([
                scanFiles(groupRoot),
                readProjectMeta(pilotHome, typeEntry.name, projectEntry.name),
                listTrash(groupRoot),
                readSessionStats(pilotHome, typeEntry.name, projectEntry.name),
            ]);
            const sizeBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
            projects.push({
                id: projectEntry.name,
                displayName: typeof meta.displayName === 'string' && meta.displayName.trim()
                    ? meta.displayName.trim()
                    : projectEntry.name,
                projectType: meta.type
                    ?? (typeEntry.name === PROJECT_TYPE_KEYS.war_trauma ? 'war_trauma' : 'general_medicine'),
                typeKey: typeEntry.name,
                sizeBytes,
                usage: aggregateUsage(files, sizeBytes),
                trashBytes: trashEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
                trashCount: trashEntries.length,
                ...sessionStats,
                files,
                folders: await readTopLevelFolders(groupRoot, files),
            });
        }
    }
    return projects.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function scanStorage(pilotHome = resolveScopedHome()) {
    const projects = await scanProjectGroups(pilotHome);
    const workspaceBytes = projects.reduce((sum, project) => sum + project.sizeBytes, 0);
    const trashBytes = projects.reduce((sum, project) => sum + (project.trashBytes ?? 0), 0);
    return {
        totals: {
            // 回收站里的文件仍占磁盘，计入 totalBytes，但不计入 workspaceBytes（那是"当前文件"口径）。
            totalBytes: workspaceBytes + trashBytes,
            workspaceBytes,
            trashBytes,
            projectCount: projects.length,
        },
        projects,
    };
}

/** 只读预览：只允许落在某个**在用项目**的工作区里。 */
export async function resolvePreviewTarget(pilotHome, query) {
    const { typeKey, groupId, path: relativePath } = query;
    if (!TYPE_KEYS.has(typeKey)) throw invalidInput('Invalid project type');
    if (!isSafeSegment(groupId)) throw invalidInput('Invalid project id');
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
        throw invalidInput('A relative file path is required');
    }
    const groupRoot = path.join(pilotHome, 'workspaces', typeKey, groupId);
    const target = path.resolve(groupRoot, relativePath);
    assertInside(groupRoot, target);
    assertWithinUserHome(target, pilotHome);
    const [realRoot, realTarget] = await Promise.all([fs.realpath(groupRoot), fs.realpath(target)]);
    assertInside(realRoot, realTarget);
    const stat = await fs.stat(realTarget);
    if (!stat.isFile()) throw invalidInput('Not a regular file');
    return { target: realTarget, stat };
}

router.get('/', async (_req, res) => {
    try {
        res.json(await scanStorage());
    } catch (error) {
        console.error('[Storage] Scan failed:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

router.get('/preview', async (req, res) => {
    try {
        const pilotHome = resolveScopedHome();
        const resolved = await resolvePreviewTarget(pilotHome, req.query);
        const kind = previewKind(resolved.target);
        if (!kind) return res.status(415).json({ error: 'This file type cannot be previewed' });

        const contentType = mime.lookup(resolved.target) || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Preview-Kind', kind);
        res.setHeader('Cache-Control', 'no-store');
        if (kind === 'text') {
            const handle = await fs.open(resolved.target, 'r');
            try {
                const length = Math.min(resolved.stat.size, MAX_TEXT_PREVIEW_BYTES);
                const buffer = Buffer.alloc(length);
                const { bytesRead } = await handle.read(buffer, 0, length, 0);
                res.setHeader('X-Preview-Truncated', String(resolved.stat.size > bytesRead));
                return res.send(buffer.subarray(0, bytesRead));
            } finally {
                await handle.close();
            }
        }
        return res.sendFile(resolved.target);
    } catch (error) {
        const status = error?.code === 'invalid_input' ? 400 : error?.code === 'ENOENT' ? 404 : 500;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

export default router;
