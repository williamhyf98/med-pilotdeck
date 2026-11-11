import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import {
    assertPathInUserHome,
    PROJECT_TYPE_KEYS,
    resolveScopedHome,
} from '../utils/pilotPaths.js';
import {
    TRASH_DIR_NAME,
    isReservedRelativePath,
    listTrash,
    moveFileToTrash,
    restoreFromTrash,
} from '../services/trash.js';

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
            // 软删除的文件仍在磁盘上，但不算"当前文件"：树和预览都不该看到它。
            if (directory === root && entry.name === TRASH_DIR_NAME) continue;
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

async function scanWorkspaceGroups(pilotHome) {
    const workspaceRoot = path.join(pilotHome, 'workspaces');
    const groups = [];
    for (const typeEntry of await readDirectoryNames(workspaceRoot)) {
        if (!typeEntry.isDirectory() || !TYPE_KEYS.has(typeEntry.name)) continue;
        const typeRoot = path.join(workspaceRoot, typeEntry.name);
        for (const projectEntry of await readDirectoryNames(typeRoot)) {
            if (!projectEntry.isDirectory() || !isSafeSegment(projectEntry.name)) continue;
            const groupRoot = path.join(typeRoot, projectEntry.name);
            const [files, meta, trashEntries] = await Promise.all([
                scanFiles(groupRoot),
                readProjectMeta(pilotHome, typeEntry.name, projectEntry.name),
                listTrash(groupRoot),
            ]);
            groups.push({
                id: projectEntry.name,
                projectId: projectEntry.name,
                displayName: typeof meta.displayName === 'string' && meta.displayName.trim()
                    ? meta.displayName.trim()
                    : projectEntry.name,
                projectType: meta.type
                    ?? (typeEntry.name === PROJECT_TYPE_KEYS.war_trauma
                        ? 'war_trauma'
                        : 'general_medicine'),
                typeKey: typeEntry.name,
                sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
                trashBytes: trashEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
                trashCount: trashEntries.length,
                files,
            });
        }
    }
    return groups.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

async function scanArchiveGroups(pilotHome) {
    const archiveRoot = path.join(pilotHome, 'archives', 'projects');
    const groups = [];
    for (const entry of await readDirectoryNames(archiveRoot)) {
        if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
        const files = await scanFiles(path.join(archiveRoot, entry.name));
        const timestampMatch = entry.name.match(/-(\d{8}T\d{6}Z(?:-[A-Za-z0-9._-]+)?)$/);
        groups.push({
            id: entry.name,
            projectId: timestampMatch ? entry.name.slice(0, -timestampMatch[0].length) : entry.name,
            archivedAt: timestampMatch?.[1] ?? null,
            sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
            files,
        });
    }
    return groups.sort((left, right) => right.id.localeCompare(left.id));
}

export async function scanStorage(pilotHome = resolveScopedHome()) {
    const [workspaces, archives] = await Promise.all([
        scanWorkspaceGroups(pilotHome),
        scanArchiveGroups(pilotHome),
    ]);
    const workspaceBytes = workspaces.reduce((sum, group) => sum + group.sizeBytes, 0);
    const archiveBytes = archives.reduce((sum, group) => sum + group.sizeBytes, 0);
    const trashBytes = workspaces.reduce((sum, group) => sum + (group.trashBytes ?? 0), 0);
    return {
        totals: {
            // 回收站里的文件仍占磁盘，所以计入 totalBytes；但不计入 workspaceBytes，
            // 那是"当前文件"的口径。
            totalBytes: workspaceBytes + archiveBytes + trashBytes,
            workspaceBytes,
            archiveBytes,
            trashBytes,
        },
        workspaces,
        archives,
    };
}

function resolveGroupRoot(pilotHome, scope, groupId, typeKey) {
    if (!isSafeSegment(groupId)) throw invalidInput('Invalid storage group');
    if (scope === 'workspace') {
        if (!TYPE_KEYS.has(typeKey)) throw invalidInput('Invalid project type');
        return path.join(pilotHome, 'workspaces', typeKey, groupId);
    }
    if (scope === 'archive') {
        return path.join(pilotHome, 'archives', 'projects', groupId);
    }
    throw invalidInput('Invalid storage scope');
}

async function resolveManagedFile(pilotHome, input) {
    const groupRoot = resolveGroupRoot(pilotHome, input.scope, input.groupId, input.typeKey);
    if (typeof input.path !== 'string' || !input.path || path.isAbsolute(input.path)) {
        throw invalidInput('A relative file path is required');
    }
    const target = path.resolve(groupRoot, input.path);
    assertInside(groupRoot, target);
    const [realRoot, realTarget, realHome] = await Promise.all([
        fs.realpath(groupRoot),
        fs.realpath(target),
        fs.realpath(pilotHome),
    ]);
    assertInside(realRoot, realTarget);
    assertWithinUserHome(realTarget, realHome);
    const stat = await fs.lstat(realTarget);
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalidInput('Target is not a regular file');
    return { groupRoot: realRoot, target: realTarget, stat };
}

function normalizeDeleteTargets(pilotHome, targets) {
    if (!Array.isArray(targets) || targets.length === 0) {
        throw invalidInput('Select at least one file or group');
    }
    if (targets.length > 1000) throw invalidInput('Too many delete targets');

    return targets.map((target) => {
        if (!target || typeof target !== 'object') throw invalidInput('Invalid delete target');
        const groupRoot = resolveGroupRoot(pilotHome, target.scope, target.groupId, target.typeKey);
        if (target.kind === 'workspace') {
            if (target.scope !== 'workspace') throw invalidInput('Invalid workspace delete target');
            return { ...target };
        }
        if (target.kind === 'archive') {
            if (target.scope !== 'archive') throw invalidInput('Invalid archive delete target');
            return { ...target };
        }
        if (target.kind !== 'file' || typeof target.path !== 'string' || path.isAbsolute(target.path)) {
            throw invalidInput('Invalid file delete target');
        }
        const absolutePath = path.resolve(groupRoot, target.path);
        assertInside(groupRoot, absolutePath);
        assertWithinUserHome(absolutePath, pilotHome);
        if (isReservedRelativePath(target.path)) {
            throw invalidInput(
                `"${target.path.split(/[\\/]/)[0]}" is a reserved system path and cannot be deleted`,
            );
        }
        return { ...target };
    });
}

async function deleteTarget(pilotHome, target) {
    const groupRoot = resolveGroupRoot(pilotHome, target.scope, target.groupId, target.typeKey);
    if (target.kind === 'archive') {
        await fs.rm(groupRoot, { recursive: true, force: false });
        return;
    }
    if (target.kind === 'workspace') {
        await fs.rm(groupRoot, { recursive: true, force: false });
        await Promise.all(['inbox', 'exports', 'scratch'].map((name) =>
            fs.mkdir(path.join(groupRoot, name), { recursive: true }),
        ));
        return;
    }
    const resolved = await resolveManagedFile(pilotHome, target);
    // A1：文件不真删，rename 进 `.trash`；失败由 moveFileToTrash 抛错，绝不退化 rm。
    await moveFileToTrash(
        resolved.groupRoot,
        path.relative(resolved.groupRoot, resolved.target).split(path.sep).join('/'),
    );
}

export async function deleteStorageTargets(targets, pilotHome = resolveScopedHome()) {
    const normalized = normalizeDeleteTargets(pilotHome, targets);
    const settled = await Promise.allSettled(
        normalized.map((target) => deleteTarget(pilotHome, target)),
    );
    const deleted = [];
    const failed = [];
    settled.forEach((result, index) => {
        const target = targets[index];
        if (result.status === 'fulfilled') {
            deleted.push(target);
        } else {
            failed.push({
                target,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
        }
    });
    return { deleted, failed };
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
        const resolved = await resolveManagedFile(pilotHome, {
            scope: req.query.scope,
            groupId: req.query.groupId,
            typeKey: req.query.typeKey,
            path: req.query.path,
        });
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

router.post('/delete', async (req, res) => {
    try {
        const result = await deleteStorageTargets(req.body?.targets);
        const snapshot = await scanStorage();
        res.status(result.failed.length > 0 ? 207 : 200).json({ ...result, snapshot });
    } catch (error) {
        const status = error?.code === 'invalid_input' ? 400 : 500;
        res.status(status).json({
            error: error instanceof Error ? error.message : String(error),
            code: error?.code ?? 'storage_error',
        });
    }
});

function statusForTrashError(error) {
    switch (error?.code) {
        case 'invalid_input': return 400;
        case 'trash_not_found': return 404;
        case 'target_exists': return 409;
        default: return 500;
    }
}

/** 回收站列表：`.trash` 里还有哪些文件、什么时候删的、多大。 */
router.get('/trash', async (req, res) => {
    try {
        const pilotHome = resolveScopedHome();
        const groupRoot = resolveGroupRoot(
            pilotHome,
            req.query.scope ?? 'workspace',
            req.query.groupId,
            req.query.typeKey,
        );
        const entries = await listTrash(groupRoot);
        res.json({
            entries,
            totals: {
                count: entries.length,
                bytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
            },
        });
    } catch (error) {
        res.status(statusForTrashError(error)).json({
            error: error instanceof Error ? error.message : String(error),
            code: error?.code ?? 'storage_error',
        });
    }
});

/** 恢复：`path` 是回收站里的相对路径（`GET /trash` 返回的 `path`）。 */
router.post('/trash/restore', async (req, res) => {
    try {
        const pilotHome = resolveScopedHome();
        const groupRoot = resolveGroupRoot(
            pilotHome,
            req.body?.scope ?? 'workspace',
            req.body?.groupId,
            req.body?.typeKey,
        );
        const restored = await restoreFromTrash(groupRoot, req.body?.path);
        const snapshot = await scanStorage();
        res.json({ restored, snapshot });
    } catch (error) {
        res.status(statusForTrashError(error)).json({
            error: error instanceof Error ? error.message : String(error),
            code: error?.code ?? 'storage_error',
        });
    }
});

export default router;
