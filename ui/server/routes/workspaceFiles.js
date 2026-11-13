/**
 * 工作区写操作与回收站（第二批）。
 *
 * 为什么从 index.js 搬出来：`index.js` 在 import 时就 listen、起 watcher、开 PTY，
 * 路由只能靠起真服务测。这里做成 `createWorkspaceFilesRouter(deps)`，
 * 注入 `extractProjectDirectory` 就能在测试里用临时工作区跑完整 HTTP 链路，
 * 和 `apiRouter.js` / `routeErrors.js` 的做法一致。
 *
 * 边界（设计书 §5.3.1 / §6.3）：
 * - 写入口只有两个：新建目录、清空回收站；文本编辑走既有的 `PUT /:projectName/file`；
 * - 路径一律相对、无 `..`、无隐藏段、不落在保留项、逐段拒绝软链；
 * - 清空回收站是唯一不可恢复入口，必须 `confirm: true`。
 */
import express from 'express';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { extractProjectDirectory as defaultExtractProjectDirectory } from '../projects.js';
import { cleanScratch } from '../services/scratchRetention.js';
import {
    emptyTrash, listTrash, moveFileToTrash, restoreFromTrash, TRASH_RETENTION_DAYS,
} from '../services/trash.js';
import { appendAudit } from '../../../src/security/audit/auditLog.js';
import { assertNoSymlinkOnPath, normalizeNewPath, resolveInsideRoot } from '../utils/workspacePaths.js';

/** 这三个是工作区骨架，不允许整体拖走（里面的内容可以）。 */
const PINNED_ROOT_NAMES = new Set(['exports', 'inbox', 'scratch']);

function isPinnedRoot(segments) {
    return segments.length === 1 && PINNED_ROOT_NAMES.has(segments[0]);
}

function projectRelativePath(projectRoot, targetPath) {
    const relative = path.relative(path.resolve(projectRoot), path.resolve(targetPath));
    return relative.split(path.sep).join('/');
}

async function statOrNull(target) {
    return fsPromises.lstat(target).catch(() => null);
}

/**
 * @param {{
 *   extractProjectDirectory?: (projectName: string) => Promise<string>,
 * }} [deps]
 */
export function createWorkspaceFilesRouter(deps = {}) {
    const extractProjectDirectory = deps.extractProjectDirectory ?? defaultExtractProjectDirectory;
    const router = express.Router();

    // 新建目录：任意层级，必须落在工作区内
    router.post('/:projectName/files/mkdir', async (req, res) => {
        try {
            const workspaceRoot = await extractProjectDirectory(req.params.projectName);
            const segments = normalizeNewPath(req.body?.path);
            const root = path.resolve(workspaceRoot);
            const target = resolveInsideRoot(root, segments);
            await assertNoSymlinkOnPath(root, target);
            const existing = await fsPromises.lstat(target).catch(() => null);
            if (existing) {
                return res.status(409).json({ error: '同名目录或文件已存在', code: 'target_exists' });
            }
            const parent = await fsPromises.stat(path.dirname(target)).catch(() => null);
            if (!parent?.isDirectory()) {
                return res.status(404).json({ error: '上级目录不存在，请先创建', code: 'parent_missing' });
            }
            await fsPromises.mkdir(target);
            res.status(201).json({ path: projectRelativePath(root, target) });
        } catch (error) {
            const status = error?.httpStatus ?? 500;
            if (status === 500) console.error('[workspace] mkdir failed:', error);
            res.status(status).json({ error: error instanceof Error ? error.message : String(error), code: error?.code });
        }
    });

    // 拖拽移动：把 from 挪进 toDir（工作区内的已存在目录，'' 表示根）
    router.post('/:projectName/files/move', async (req, res) => {
        try {
            const workspaceRoot = await extractProjectDirectory(req.params.projectName);
            const root = path.resolve(workspaceRoot);

            const fromSegments = normalizeNewPath(req.body?.from);
            if (isPinnedRoot(fromSegments)) {
                return res.status(400).json({
                    error: 'exports / inbox / scratch 是工作区骨架，不能整体移动',
                    code: 'pinned_root',
                });
            }

            const rawToDir = req.body?.toDir;
            if (typeof rawToDir !== 'string') {
                return res.status(400).json({ error: '请提供目标目录', code: 'invalid_input' });
            }
            const toSegments = rawToDir.trim() === '' || rawToDir.trim() === '/'
                ? []
                : normalizeNewPath(rawToDir);
            // 允许拖进 scratch：那是用户的明确动作，前端会提示"会被定期清理"，
            // 不做硬性拦截（用户可能就是想把东西挪到临时区）。

            const source = resolveInsideRoot(root, fromSegments);
            const destDir = resolveInsideRoot(root, toSegments);
            await assertNoSymlinkOnPath(root, source);
            await assertNoSymlinkOnPath(root, destDir);

            const sourceStat = await statOrNull(source);
            if (!sourceStat) {
                return res.status(404).json({ error: '要移动的文件或目录不存在', code: 'not_found' });
            }
            const destDirStat = await statOrNull(destDir);
            if (!destDirStat?.isDirectory()) {
                return res.status(404).json({ error: '目标目录不存在', code: 'target_missing' });
            }

            const destination = path.join(destDir, path.basename(source));
            if (destination === source) {
                return res.status(400).json({ error: '已经在目标目录里了', code: 'same_path' });
            }
            if (sourceStat.isDirectory()
                && (destDir === source || destDir.startsWith(source + path.sep))) {
                return res.status(400).json({ error: '不能把目录移动到它自己里面', code: 'move_into_self' });
            }
            if (await statOrNull(destination)) {
                return res.status(409).json({ error: '目标目录里已有同名项', code: 'target_exists' });
            }

            await fsPromises.rename(source, destination);
            appendAudit({
                action: 'file.move',
                decision: 'allow',
                tool: 'workspace.files',
                target: projectRelativePath(root, source),
                reason: 'drag-move',
                meta: { to: projectRelativePath(root, destination) },
            });
            res.json({
                from: projectRelativePath(root, source),
                to: projectRelativePath(root, destination),
            });
        } catch (error) {
            const status = error?.httpStatus ?? (error?.code === 'EXDEV' ? 400 : 500);
            if (status === 500) console.error('[workspace] move failed:', error);
            res.status(status).json({
                error: error?.code === 'EXDEV'
                    ? '不能跨文件系统移动'
                    : (error instanceof Error ? error.message : String(error)),
                code: error?.code,
            });
        }
    });

    // 拖拽到回收站：软删除（rename 进 .trash，7 天自动释放），不硬删
    router.post('/:projectName/files/trash', async (req, res) => {
        try {
            const workspaceRoot = await extractProjectDirectory(req.params.projectName);
            const segments = normalizeNewPath(req.body?.path);
            if (isPinnedRoot(segments)) {
                return res.status(400).json({
                    error: 'exports / inbox / scratch 是工作区骨架，不能整个移入回收站',
                    code: 'pinned_root',
                });
            }
            const relative = segments.join('/');
            const plan = await moveFileToTrash(workspaceRoot, relative, { actor: req.user?.username });
            res.json({ path: relative, trashedPath: plan.trashedPath, deletedAt: plan.deletedAt });
        } catch (error) {
            const status = error?.code === 'invalid_input' ? 400
                : error?.code === 'ENOENT' ? 404
                    : 500;
            if (status === 500) console.error('[workspace] move to trash failed:', error);
            res.status(status).json({ error: error instanceof Error ? error.message : String(error), code: error?.code });
        }
    });

    // 回收站列表：只读，来源是本工作区的 `.trash`
    router.get('/:projectName/trash', async (req, res) => {
        try {
            const workspaceRoot = await extractProjectDirectory(req.params.projectName);
            const entries = await listTrash(workspaceRoot);
            res.setHeader('Cache-Control', 'no-store');
            res.json({
                entries,
                totals: {
                    count: entries.length,
                    bytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
                },
                retentionDays: TRASH_RETENTION_DAYS,
            });
        } catch (error) {
            console.error('[workspace] trash list failed:', error);
            res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    router.post('/:projectName/trash/restore', async (req, res) => {
        try {
            const workspaceRoot = await extractProjectDirectory(req.params.projectName);
            const restored = await restoreFromTrash(workspaceRoot, req.body?.path, {
                actor: req.user?.username,
            });
            res.json({ restored });
        } catch (error) {
            const status = error?.code === 'invalid_input' ? 400
                : error?.code === 'trash_not_found' ? 404
                    : error?.code === 'target_exists' ? 409
                        : 500;
            if (status === 500) console.error('[workspace] trash restore failed:', error);
            res.status(status).json({ error: error instanceof Error ? error.message : String(error), code: error?.code });
        }
    });

    // 清空回收站：全系统唯一不可恢复的入口，必须显式带 confirm: true
    router.post('/:projectName/trash/empty', async (req, res) => {
        try {
            if (req.body?.confirm !== true) {
                return res.status(400).json({ error: '清空回收站不可恢复，需要再次确认', code: 'confirm_required' });
            }
            const workspaceRoot = await extractProjectDirectory(req.params.projectName);
            const result = await emptyTrash(workspaceRoot, { actor: req.user?.username });
            res.json(result);
        } catch (error) {
            console.error('[workspace] trash empty failed:', error);
            res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    // 立即清理 scratch：只清 scratch。
    // - 不带 force：跑一次自动清理规则（TTL + 容量），非破坏性；
    // - 带 force:true：用户明确要腾地方，忽略 TTL/容量，全删（60 秒防抖 + .pinned 仍生效），
    //   不可恢复，因此要求同时带 confirm:true。
    router.post('/:projectName/workspace/scratch/clean', async (req, res) => {
        try {
            const force = req.body?.force === true;
            if (force && req.body?.confirm !== true) {
                return res.status(400).json({
                    error: '彻底清理 scratch 不可恢复，需要再次确认',
                    code: 'confirm_required',
                });
            }
            const workspaceRoot = await extractProjectDirectory(req.params.projectName);
            const result = await cleanScratch(workspaceRoot, { audit: true, force });
            res.json(result);
        } catch (error) {
            console.error('[workspace] scratch clean failed:', error);
            res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    return router;
}
