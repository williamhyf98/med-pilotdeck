/**
 * 软删除（spec §6.3 / 清单 A1）。
 *
 * 约定：删除**文件**不是 `rm`，而是 `rename` 到同一个工作区根下的
 * `.trash/<原相对路径>.<YYYYMMDDTHHMMSSmmmZ>`；7 天后由过期任务物理删除。
 *
 * 为什么用 rename 而不是"复制一份再删"：
 * - 同一文件系统内 rename 是原子的，不会出现"删了但没进回收站"的中间态；
 * - 不占双倍空间（用户目录本身可能已经很大）。
 *
 * 硬约束：
 * - rename 失败**绝不退化成 rm**（磁盘满、权限、跨设备都只报错）；
 * - `.trash` / `.usage.json` / `.pinned` / `.tmp` 是系统保留项，不允许被删除，
 *   也不允许作为恢复目标；
 * - 恢复时原路径已被占用 → 报 `target_exists`，不覆盖。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendAudit } from '../../../src/security/audit/auditLog.js';

export const TRASH_DIR_NAME = '.trash';
export const TRASH_RETENTION_DAYS = 7;

/** 与 `src/tool/builtin/filesystem/pathSafety.ts` 的 RESERVED_WORKSPACE_ENTRIES 保持一致。 */
export const RESERVED_WORKSPACE_ENTRIES = new Set([
    TRASH_DIR_NAME,
    '.usage.json',
    '.pinned',
    '.tmp',
]);

const STAMP_PATTERN = /^(\d{8})T(\d{6})(\d{3})Z$/;
const TRAILING_STAMP = /^(.*)\.(\d{8}T\d{9}Z)$/s;

function pad(value, width = 2) {
    return String(value).padStart(width, '0');
}

/** `20261111T101500123Z`（UTC，毫秒精度，可直接字符串排序）。 */
export function trashStamp(now = new Date()) {
    return [
        `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`,
        'T',
        `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`,
        pad(now.getUTCMilliseconds(), 3),
        'Z',
    ].join('');
}

export function parseTrashStamp(value) {
    const match = STAMP_PATTERN.exec(String(value ?? ''));
    if (!match) return null;
    const iso = `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}`
        + `T${match[2].slice(0, 2)}:${match[2].slice(2, 4)}:${match[2].slice(4, 6)}.${match[3]}Z`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** 工作区相对路径归一成 posix 形式；绝对路径、`..`、控制字符一律拒绝。 */
export function normalizeRelativePath(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.replace(/\\/g, '/').trim();
    if (raw.includes('\0') || path.posix.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return null;
    const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0 || segments.some((segment) => segment === '..')) return null;
    return segments.join('/');
}

export function isReservedRelativePath(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return false;
    return RESERVED_WORKSPACE_ENTRIES.has(normalized.split('/')[0]);
}

function toPosix(absolutePath, root) {
    return path.relative(root, absolutePath).split(path.sep).join('/');
}

/**
 * `<groupRoot>/.trash/<相对路径>.<stamp>`；同一毫秒重复删除同一路径时，
 * 时间戳往后挪 1ms（最多 5 次），而不是加随机后缀——恢复时要能靠后缀还原路径。
 */
export async function planTrashDestination(groupRoot, relativePath, now = new Date()) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) throw new Error('Invalid path for the trash');
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const stamp = trashStamp(new Date(now.getTime() + attempt));
        const trashedPath = `${TRASH_DIR_NAME}/${normalized}.${stamp}`;
        const absolute = path.join(groupRoot, trashedPath);
        try {
            await fs.lstat(absolute);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return {
                    trashedPath,
                    absolute,
                    deletedAt: new Date(now.getTime() + attempt),
                };
            }
            throw error;
        }
    }
    throw new Error('Too many files were trashed in the same millisecond');
}

function trashError(message, cause) {
    const error = new Error(message);
    error.code = 'trash_failed';
    if (cause) error.cause = cause;
    return error;
}

/** 把 `relativePath` 移进 `.trash`；失败只报错，绝不做 rm。 */
export async function moveFileToTrash(groupRoot, relativePath, options = {}) {
    const { now = new Date(), audit = true } = options;
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) throw trashError('Invalid file path');
    if (isReservedRelativePath(normalized)) {
        const error = new Error(`"${normalized.split('/')[0]}" is a reserved system path`);
        error.code = 'invalid_input';
        throw error;
    }
    const source = path.join(groupRoot, normalized);
    let plan;
    try {
        plan = await planTrashDestination(groupRoot, normalized, now);
        await fs.mkdir(path.dirname(plan.absolute), { recursive: true });
        await fs.rename(source, plan.absolute);
    } catch (error) {
        if (audit) {
            appendAudit({
                action: 'file.trash_failed',
                decision: 'error',
                tool: 'storage.delete',
                target: normalized,
                reason: error?.code ?? 'trash_failed',
                meta: { message: error instanceof Error ? error.message : String(error) },
            });
        }
        throw trashError(
            `无法移入回收站（原文件未删除）：${error instanceof Error ? error.message : String(error)}`,
            error,
        );
    }
    if (audit) {
        appendAudit({
            action: 'file.trash',
            decision: 'allow',
            tool: 'storage.delete',
            target: normalized,
            reason: 'moved-to-trash',
            meta: { trashedPath: plan.trashedPath, deletedAt: plan.deletedAt.toISOString() },
        });
    }
    return plan;
}

/** `.trash/<原路径>.<stamp>` → `{ originalPath, deletedAt }`；不是回收站条目返回 null。 */
export function parseTrashedRelative(trashedRelative) {
    const normalized = normalizeRelativePath(trashedRelative);
    if (!normalized || !normalized.startsWith(`${TRASH_DIR_NAME}/`)) return null;
    // 先剥掉 `.trash/` 再看后缀：原路径本身不能是保留项（`.trash` 就在保留表里）。
    const match = TRAILING_STAMP.exec(normalized.slice(TRASH_DIR_NAME.length + 1));
    if (!match) return null;
    const deletedAt = parseTrashStamp(match[2]);
    if (!deletedAt) return null;
    const originalPath = normalizeRelativePath(match[1]);
    if (!originalPath || isReservedRelativePath(originalPath)) return null;
    return { originalPath, deletedAt };
}

async function removeEmptyParents(trashRoot, absolutePath) {
    let current = path.dirname(absolutePath);
    while (current.startsWith(trashRoot) && current !== trashRoot) {
        try {
            await fs.rmdir(current);
        } catch {
            return;
        }
        current = path.dirname(current);
    }
}

/** 恢复一条回收站条目；原路径已存在时抛 `target_exists`，不覆盖。 */
export async function restoreFromTrash(groupRoot, trashedRelative, options = {}) {
    const { audit = true, actor } = options;
    const parsed = parseTrashedRelative(trashedRelative);
    if (!parsed) {
        const error = new Error('Not a trash entry');
        error.code = 'invalid_input';
        throw error;
    }
    const trashRoot = path.join(groupRoot, TRASH_DIR_NAME);
    const source = path.join(groupRoot, normalizeRelativePath(trashedRelative));
    const destination = path.join(groupRoot, parsed.originalPath);
    try {
        await fs.lstat(source);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            const missing = new Error('Trash entry no longer exists');
            missing.code = 'trash_not_found';
            throw missing;
        }
        throw error;
    }
    try {
        await fs.lstat(destination);
        const conflict = new Error('目标位置已有同名文件，请先改名或移走它再恢复');
        conflict.code = 'target_exists';
        throw conflict;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
        await fs.rename(source, destination);
    } catch (error) {
        if (audit) {
            appendAudit({
                action: 'trash.restore_failed',
                decision: 'error',
                tool: 'trash.restore',
                target: parsed.originalPath,
                reason: error?.code ?? 'restore_failed',
                ...(actor ? { actor } : {}),
                meta: { message: error instanceof Error ? error.message : String(error) },
            });
        }
        throw trashError(
            `恢复失败：${error instanceof Error ? error.message : String(error)}`,
            error,
        );
    }
    await removeEmptyParents(trashRoot, source);
    if (audit) {
        appendAudit({
            action: 'trash.restore',
            decision: 'allow',
            tool: 'trash.restore',
            target: parsed.originalPath,
            reason: 'restored',
            ...(actor ? { actor } : {}),
            meta: { deletedAt: parsed.deletedAt.toISOString() },
        });
    }
    return { path: parsed.originalPath, deletedAt: parsed.deletedAt.toISOString() };
}

/** 目录/文件大小（不跟随软链），给"整目录进回收站"的条目录大小。 */
async function measureEntry(absolute) {
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat) return 0;
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    let dirents = [];
    try {
        dirents = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const dirent of dirents) {
        total += await measureEntry(path.join(absolute, dirent.name));
    }
    return total;
}

/**
 * 列出回收站条目（只走 `.trash` 内部）。
 *
 * 一个条目既可以是文件（`.trash/inbox/a.csv.<stamp>`），也可以是**整个目录**
 * （`.trash/我的资料.<stamp>`，来自"清空工作区"）。先判断当前项自身是否带
 * 时间戳后缀：带后缀就是条目、不再往里走；不带才是回收站的中间层级，继续递归。
 */
export async function listTrash(groupRoot) {
    const trashRoot = path.join(groupRoot, TRASH_DIR_NAME);
    const entries = [];
    async function visit(directory) {
        let dirents;
        try {
            dirents = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of dirents) {
            const absolute = path.join(directory, entry.name);
            const trashedPath = toPosix(absolute, groupRoot);
            const parsed = parseTrashedRelative(trashedPath);
            if (parsed) {
                entries.push({
                    path: trashedPath,
                    originalPath: parsed.originalPath,
                    deletedAt: parsed.deletedAt.toISOString(),
                    sizeBytes: await measureEntry(absolute),
                    kind: entry.isDirectory() ? 'directory' : 'file',
                });
                continue;
            }
            if (entry.isDirectory()) await visit(absolute);
        }
    }
    await visit(trashRoot);
    return entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

/**
 * 一次性物理删除若干条目（过期清理 / 手动清空共用）。
 * 目录条目必须 `recursive: true`，否则 `fs.rm` 会 EISDIR 失败。
 */
async function purgeEntries(groupRoot, entries, { reason, audit, actor, retentionDays }) {
    let purged = 0;
    let freedBytes = 0;
    for (const entry of entries) {
        try {
            await fs.rm(path.join(groupRoot, entry.path), { recursive: true, force: true });
            purged += 1;
            freedBytes += entry.sizeBytes;
            if (audit) {
                appendAudit({
                    action: 'trash.purge',
                    decision: 'allow',
                    tool: reason === 'manual' ? 'trash.empty' : 'trash.retention',
                    target: entry.originalPath,
                    reason,
                    ...(actor ? { actor } : {}),
                    meta: {
                        deletedAt: entry.deletedAt,
                        ...(retentionDays !== undefined ? { retentionDays } : {}),
                        bytes: entry.sizeBytes,
                        kind: entry.kind ?? 'file',
                    },
                });
            }
        } catch (error) {
            if (audit) {
                appendAudit({
                    action: 'trash.purge_failed',
                    decision: 'error',
                    tool: reason === 'manual' ? 'trash.empty' : 'trash.retention',
                    target: entry.originalPath,
                    reason: error?.code ?? 'purge_failed',
                    ...(actor ? { actor } : {}),
                    meta: { message: error instanceof Error ? error.message : String(error) },
                });
            }
        }
    }
    return { purged, freedBytes };
}

/** 物理删除超过保留期的条目；返回 `{ purged, freedBytes }`。 */
export async function purgeExpiredTrash(groupRoot, options = {}) {
    const {
        now = new Date(),
        retentionDays = TRASH_RETENTION_DAYS,
        audit = true,
    } = options;
    const cutoff = now.getTime() - retentionDays * 86_400_000;
    const entries = (await listTrash(groupRoot))
        .filter((entry) => new Date(entry.deletedAt).getTime() <= cutoff);
    return purgeEntries(groupRoot, entries, { reason: 'expired', audit, retentionDays });
}

/**
 * 手动清空回收站——**整个系统唯一不可恢复的入口**（设计书 §6.3）。
 * 调用方必须先做二次确认；这里只负责删干净并写审计。
 */
export async function emptyTrash(groupRoot, options = {}) {
    const { audit = true, actor } = options;
    const entries = await listTrash(groupRoot);
    return purgeEntries(groupRoot, entries, { reason: 'manual', audit, actor });
}

async function listGroupRoots(pilotHome) {
    const roots = [];
    const workspaceRoot = path.join(pilotHome, 'workspaces');
    let typeEntries = [];
    try {
        typeEntries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    for (const typeEntry of typeEntries) {
        if (!typeEntry.isDirectory()) continue;
        const typeRoot = path.join(workspaceRoot, typeEntry.name);
        let groupEntries = [];
        try {
            groupEntries = await fs.readdir(typeRoot, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const groupEntry of groupEntries) {
            if (!groupEntry.isDirectory()) continue;
            roots.push(path.join(typeRoot, groupEntry.name));
        }
    }
    return roots;
}

/** 逐个用户 home、逐个工作区跑过期清理；`homes` 由调用方给。 */
export async function purgeExpiredTrashInHomes(homes, options = {}) {
    const results = [];
    for (const pilotHome of homes) {
        for (const root of await listGroupRoots(pilotHome)) {
            results.push({
                root,
                ...(await purgeExpiredTrash(root, options)),
            });
        }
    }
    return results;
}
