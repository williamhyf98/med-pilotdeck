/**
 * `.rewind-backups` 保留策略。
 *
 * 用户每次"回退到某一轮"时，`rewindSession` 会把**整份对话**复制到
 * `<chatDir>/.rewind-backups/<会话ID>.<ISO 时间戳>-<rand>.jsonl`，
 * 目的是让误操作可以手工捞回来。问题是它只增不减：
 * 同一会话反复回退会堆出很多份完整 transcript（单份可达 2 MB）。
 *
 * 规则（两条同时生效，取更严格的那条）：
 *
 * - **每会话只留最近 3 份**：回退是"操作前保险"，只需要最近几步；
 * - **超过 30 天就删**：太久以前的对话副本已经没有找回价值。
 *
 * 删会话时这些备份会被 `sessionCleanup.js` 立即清掉；这里只是"用户从不删会话"的兜底。
 * 失败只记日志，不影响服务启动。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listUserHomes } from './trashRetention.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DEFAULT_INTERVAL_MS = 6 * HOUR_MS;

export const REWIND_BACKUP_KEEP = 3;
export const REWIND_BACKUP_TTL_DAYS = 30;

/** `web:s_abc.2026-11-12T06-31-00-000Z-ab12cd34.jsonl` → `web:s_abc` */
export function sessionIdFromBackupName(fileName) {
    const match = /^(.*)\.(\d{4}-\d{2}-\d{2}T[^/]*)\.jsonl$/.exec(fileName);
    return match ? match[1] : null;
}

async function removeDirIfEmpty(dirPath) {
    try {
        await fs.rmdir(dirPath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') {
            return false;
        }
        throw error;
    }
}

/** 所有 `<home>/projects/**​/chats/.rewind-backups` 目录。 */
async function findRewindDirs(projectsRoot) {
    const found = [];
    const walk = async (dir, depth) => {
        if (depth > 4) return;
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const full = path.join(dir, entry.name);
            if (entry.name === '.rewind-backups') {
                found.push(full);
                continue;
            }
            await walk(full, depth + 1);
        }
    };
    await walk(projectsRoot, 1);
    return found;
}

/**
 * 跑一次清理。
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   homes?: string[],
 *   now?: Date,
 *   keep?: number,
 *   retentionDays?: number,
 * }} [options]
 * @returns {Promise<Array<{ dir: string, removed: number, freedBytes: number }>>}
 */
export async function runRewindBackupRetention(options = {}) {
    const {
        env = process.env,
        now = new Date(),
        keep = REWIND_BACKUP_KEEP,
        retentionDays = REWIND_BACKUP_TTL_DAYS,
    } = options;
    const homes = options.homes ?? await listUserHomes(env);
    const ttlMs = retentionDays * DAY_MS;
    const results = [];

    for (const home of homes) {
        const dirs = await findRewindDirs(path.join(home, 'projects'));
        for (const dir of dirs) {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                continue;
            }

            // 按会话分组；文件名里的时间戳可直接排序，不依赖 mtime。
            const bySession = new Map();
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
                const sessionId = sessionIdFromBackupName(entry.name);
                if (!sessionId) continue;
                const list = bySession.get(sessionId) ?? [];
                list.push(entry.name);
                bySession.set(sessionId, list);
            }

            let removed = 0;
            let freedBytes = 0;
            for (const names of bySession.values()) {
                names.sort().reverse(); // 最新在前
                for (let index = 0; index < names.length; index += 1) {
                    const fileName = names[index];
                    const filePath = path.join(dir, fileName);
                    let stat;
                    try {
                        stat = await fs.lstat(filePath);
                    } catch {
                        continue;
                    }
                    const tooOld = now.getTime() - stat.mtimeMs > ttlMs;
                    const beyondKeep = index >= keep;
                    if (!tooOld && !beyondKeep) continue;
                    await fs.rm(filePath, { force: true });
                    removed += 1;
                    freedBytes += stat.size;
                }
            }

            await removeDirIfEmpty(dir);
            results.push({ dir, removed, freedBytes });
        }
    }

    return results;
}

/** 启动时跑一次，之后每 6 小时一次；返回停止函数（测试/退出用）。 */
export function startRewindBackupRetention(options = {}) {
    const { intervalMs = DEFAULT_INTERVAL_MS, log = console } = options;
    const run = async () => {
        try {
            const results = await runRewindBackupRetention(options);
            const removed = results.reduce((sum, item) => sum + item.removed, 0);
            const freed = results.reduce((sum, item) => sum + item.freedBytes, 0);
            if (removed > 0) {
                log.log(`[rewind] pruned ${removed} backup${removed === 1 ? '' : 's'} (${freed} bytes)`);
            }
        } catch (error) {
            log.error?.('[rewind] retention failed:', error?.message ?? error);
        }
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
