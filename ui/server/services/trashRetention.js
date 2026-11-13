/**
 * 回收站保留期（清单 A1：每日过期清理，7 天，物理删除，写审计）。
 *
 * 多用户下每个用户的文件在 `<PILOT_HOME>/users/<id>/workspaces/<type>/<group>/`，
 * 而清理任务跑在没有请求上下文的启动阶段（拿不到 user scope），
 * 所以这里直接在根目录枚举用户 home；单用户（没有 `users/`）就退回根目录本身。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolvePilotRoot } from '../utils/pilotPaths.js';
import { purgeExpiredTrashInHomes, TRASH_RETENTION_DAYS } from './trash.js';

const DAY_MS = 86_400_000;

export async function listUserHomes(env = process.env) {
    const root = resolvePilotRoot(env);
    const usersRoot = path.join(root, 'users');
    try {
        const entries = await fs.readdir(usersRoot, { withFileTypes: true });
        const homes = entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => path.join(usersRoot, entry.name));
        if (homes.length > 0) return homes;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    return [root];
}

/** 跑一次清理；返回每个工作区的 `{root, purged, freedBytes}`。 */
export async function runTrashRetention(options = {}) {
    const {
        env = process.env,
        now = new Date(),
        retentionDays = TRASH_RETENTION_DAYS,
    } = options;
    const homes = options.homes ?? await listUserHomes(env);
    // 整包回收站（`<home>/.trash/groups`）随项目归档一起下线，存量由启动时
    // `purgeLegacyProjectArchives()` 清掉，这里只处理工作区里的文件级回收站。
    return purgeExpiredTrashInHomes(homes, { now, retentionDays });
}

/** 启动时跑一次，之后每 24 小时一次；返回停止函数（测试/退出用）。 */
export function startTrashRetention(options = {}) {
    const { intervalMs = DAY_MS, log = console } = options;
    const run = async () => {
        try {
            const results = await runTrashRetention(options);
            const purged = results.reduce((sum, item) => sum + (item.purged ?? 0), 0);
            const freed = results.reduce((sum, item) => sum + (item.freedBytes ?? 0), 0);
            if (purged > 0) {
                log.log(`[trash] purged ${purged} expired entr${purged === 1 ? 'y' : 'ies'} (${freed} bytes)`);
            }
        } catch (error) {
            // 清理是旁路任务：失败只记日志，不能影响服务启动。
            log.error?.('[trash] retention failed:', error?.message ?? error);
        }
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
