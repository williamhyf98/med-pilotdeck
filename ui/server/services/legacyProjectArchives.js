/**
 * 一次性清掉"项目归档"时代的存量（2026-11-12 改版）。
 *
 * 删项目现在是真删，不再产生 `<home>/archives/projects/`；整包回收站
 * （`<home>/.trash/groups/`）也失去了写入方。这两处的存量留着就是"没有入口、
 * 也没人删"的死数据，所以启动时清空。
 *
 * **多用户要点**：多用户布局下每个用户各有自己的 home
 * （`<root>/users/<id>/archives/projects`），所以不能只扫根目录 ——
 * 这里复用 `listUserHomes()` 枚举，单用户（没有 `users/`）自然退回根目录本身。
 *
 * 边界（很重要）：
 * - **只动这两个子目录**，`archives/users`（账号归档）与 `<root>/archives/legacy-*`
 *   （迁移备份）都不在这里，属于另一套生命周期；
 * - 符号链接不跟随、不删除（只跳过）；
 * - 失败只记日志，绝不让服务起不来。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { listUserHomes } from './trashRetention.js';

const LEGACY_SUBPATHS = [
    path.join('archives', 'projects'),
    path.join('.trash', 'groups'),
];

async function measureAndRemove(target) {
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
            } else {
                try {
                    bytes += (await fs.lstat(full)).size;
                } catch {
                    // 统计失败不影响删除
                }
            }
        }
    };
    await walk(target);
    await fs.rm(target, { recursive: true, force: true });
    return bytes;
}

/**
 * @param {{ pilotHome?: string, homes?: string[], env?: NodeJS.ProcessEnv,
 *           log?: Pick<Console, 'log' | 'warn'> }} [options]
 * @returns {Promise<{ removed: Array<{ home: string, path: string }>, freedBytes: number }>}
 */
export async function purgeLegacyProjectArchives(options = {}) {
    const log = options.log ?? console;
    const homes = options.homes
        ?? (options.pilotHome ? [options.pilotHome] : await listUserHomes(options.env));
    const removed = [];
    let freedBytes = 0;

    for (const home of homes) {
        for (const relative of LEGACY_SUBPATHS) {
            const root = path.join(home, relative);
            let stat = null;
            try {
                stat = await fs.lstat(root);
            } catch {
                continue;
            }
            if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
            try {
                freedBytes += await measureAndRemove(root);
                removed.push({ home, path: relative });
            } catch (error) {
                log.warn?.(`[legacy-archives] failed to clear ${root}:`, error?.message ?? error);
            }
        }

        // `archives/` 本身若只剩空壳就收掉；`archives/users` 或迁移备份在时它非空，自然保留。
        try {
            await fs.rmdir(path.join(home, 'archives'));
        } catch {
            // ENOTEMPTY / ENOENT 都是正常情况
        }
    }

    if (removed.length > 0) {
        log.log?.(
            `[legacy-archives] cleared ${removed.map((item) => path.join(item.home, item.path)).join(', ')}`
            + ` (${freedBytes} bytes)`,
        );
    }
    return { removed, freedBytes };
}
