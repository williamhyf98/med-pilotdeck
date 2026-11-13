/**
 * 已归档账号的保留期清理（默认 30 天）。
 *
 * 管理员删账号 = 软删除：行还在（`is_active = 0`），home 搬到
 * `<root>/archives/users/<id>-<stamp>/`。这里负责"到期真正删除"：
 *
 *   1. 删归档目录；
 *   2. 删账号行及它的附属行（会话名、API key、推送订阅、通知偏好）；
 *   3. 失效存储统计缓存。
 *
 * 三道保护，宁可不删也不误删：
 *
 * - **账号已被恢复**（`is_active = 1`）→ 跳过，只记日志。恢复时目录应该已经搬回去了，
 *   还留着说明是人为复制的副本，不该由清理任务决定去留；
 * - **活跃 home 已存在** → 跳过（恢复正在进行 / 同名目录冲突），留给人工；
 * - **目录删除失败** → 保留账号行与目录，下次再试（不能让"目录还在、账号没了"）。
 *
 * 顺序：先删目录、后删行。反过来的话，目录删失败会留下一个谁都看不见的归档。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { listArchivedHomes, getArchivedUserMaxAgeDays, archivedUsersRoot } from './archivedUsers.js';
import { userDb } from '../database/db.js';
import { resolveUserHome } from '../utils/pilotPaths.js';
import { invalidateStorageCache } from './storageUsage.js';

const DAY_MS = 86_400_000;

async function pathExists(target) {
    try {
        await fs.lstat(target);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function measure(dir) {
    let bytes = 0;
    const walk = async (current) => {
        let entries = [];
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            try {
                bytes += (await fs.lstat(full)).size;
            } catch {
                // 统计失败不影响删除
            }
        }
    };
    await walk(dir);
    return bytes;
}

/**
 * 跑一轮过期清理。
 *
 * @param {{
 *   root?: string,
 *   maxAgeDays?: number,
 *   now?: number,
 *   log?: Pick<Console, 'log' | 'warn'>,
 *   lookupUser?: (id: number) => { is_active?: number } | undefined,
 *   purgeUser?: (id: number) => number,
 *   homeFor?: (id: number) => string,
 * }} [options]
 */
export async function purgeExpiredArchivedUsers(options = {}) {
    const {
        root = archivedUsersRoot(),
        now = Date.now(),
        log = console,
        lookupUser = (id) => userDb.getUserById(id),
        purgeUser = (id) => userDb.purgeUser(id),
        homeFor = (id) => resolveUserHome(id),
    } = options;
    const maxAgeDays = options.maxAgeDays ?? await getArchivedUserMaxAgeDays();
    const cutoff = now - maxAgeDays * DAY_MS;

    const homes = await listArchivedHomes(root);
    let removedDirs = 0;
    let removedUsers = 0;
    let freedBytes = 0;
    let skipped = 0;

    for (const entry of homes) {
        if (entry.archivedAt.getTime() > cutoff) continue;

        const row = lookupUser(entry.userId);
        if (row && Number(row.is_active) === 1) {
            skipped += 1;
            log.warn?.(`[archived-users] skip ${entry.name}: account is active again`);
            continue;
        }
        if (await pathExists(homeFor(entry.userId))) {
            skipped += 1;
            log.warn?.(`[archived-users] skip ${entry.name}: live home already exists`);
            continue;
        }

        const bytes = await measure(entry.dir);
        try {
            await fs.rm(entry.dir, { recursive: true, force: true });
        } catch (error) {
            skipped += 1;
            log.warn?.(`[archived-users] failed to remove ${entry.name}:`, error?.message ?? error);
            continue;
        }
        removedDirs += 1;
        freedBytes += bytes;

        if (row) {
            try {
                purgeUser(entry.userId);
                removedUsers += 1;
                invalidateStorageCache(entry.userId);
            } catch (error) {
                // 行删不掉就留着：下次会以"目录不存在、行还在"的形态被管理员看到，
                // 但绝不能因为一次 SQLite 错误把目录删了又留着行。
                log.warn?.(`[archived-users] purged home but failed to purge row ${entry.userId}:`, error?.message ?? error);
            }
        }
    }

    if (removedDirs > 0 || skipped > 0) {
        log.log?.(`[archived-users] expired ${removedDirs} archive(s), ${removedUsers} account row(s), ${freedBytes} bytes (skipped ${skipped})`);
    }
    return { removedDirs, removedUsers, freedBytes, skipped };
}

/** 启动即跑一次，之后每天一次；返回停止函数（测试/退出用）。 */
export function startArchivedUsersRetention(options = {}) {
    const { intervalMs = DAY_MS, log = console } = options;
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            await purgeExpiredArchivedUsers({ ...options, log });
        } catch (error) {
            log.error?.('[archived-users] sweep failed:', error?.message ?? error);
        } finally {
            running = false;
        }
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
