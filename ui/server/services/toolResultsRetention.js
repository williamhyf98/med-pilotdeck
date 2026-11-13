/**
 * `<工作区>/.pilotdeck/` 的保留策略（**整目录 14 天**，2026-11-12 扩展）。
 *
 * 这个目录里全是**过程性**数据，都属于"会话/计划"的附属物，不该长期留存：
 *
 * - `tool-results/<会话>/`：超出内联预算的大工具输出（图片 base64、长文本、大 JSON）。
 *   模型上下文里只留预览 + 路径，完整内容落盘，agent 需要时用 `read_file` 回读。
 *   它跟 scratch 不是一回事：scratch 是**回合级**的（回合结束就清）；
 *   `.pilotdeck` 是**会话级**的 —— 历史消息里"查看完整结果"要回读它，所以要留到会话结束。
 * - `plans/`：计划模式写的 markdown 草稿。
 * - 其它任何子项：一律按 14 天 TTL 处理（用户明确要求"全部内容都加 TTL"）。
 *
 * 三档删除：
 * 1. **孤儿**（只对 `tool-results/<会话>`）：transcript 已不存在 → 宽限 1 小时后删；
 * 2. **过期**：该项最新 mtime 超过 `toolResultsTtlDays`（默认 14 天）→ 删；
 * 3. **空壳**：删空后把 `tool-results/`、以及空掉的 `.pilotdeck/` 收掉。
 *
 * 例外（保守起见不动）：`skills/` `commands/` `mcp.json` `settings.json` ——
 * 这些是**人工配置**而不是过程数据，误删了没法自动恢复。工作区里通常不存在，
 * 但真有人手工放进去就保留。
 *
 * 边界：只扫**工作区级** `.pilotdeck`（`<home>/workspaces/**`）。用户主目录下那个
 * `.pilotdeck/tool-results` 是早期布局的遗留，只按老规则清 `tool-results`，
 * 不去碰主目录 `.pilotdeck` 的其它内容（单用户模式下它就是应用主目录本身）。
 *
 * 失败一律只记日志，不抛给调用方 —— 这是旁路任务，不能影响启动。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listUserHomes } from './trashRetention.js';
import { getWorkspaceLimits } from './workspaceLimits.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** 新会话的宽限期：目录建好但 transcript 还没落盘的窗口。 */
const ORPHAN_GRACE_MS = HOUR_MS;
/** 自动清理间隔：每 6 小时扫一次（都是小目录，成本可忽略）。 */
const DEFAULT_INTERVAL_MS = 6 * HOUR_MS;

export const TOOL_RESULTS_TTL_DAYS = 14;

/** 人工配置项：不是过程数据，TTL 不碰（工作区里通常也没有）。 */
const CONFIG_ENTRY_NAMES = new Set(['skills', 'commands', 'mcp.json', 'settings.json']);

async function statOrNull(target) {
    try {
        return await fs.lstat(target);
    } catch {
        return null;
    }
}

/**
 * 单元大小 + 最新 mtime。目录取子项 mtime 的最大值：
 * 覆盖写文件不会改父目录 mtime，只看目录本身会误判过期。
 */
async function measureUnit(absolute) {
    const stat = await statOrNull(absolute);
    if (!stat) return { bytes: 0, lastUsedAt: 0 };
    if (!stat.isDirectory()) return { bytes: stat.size, lastUsedAt: stat.mtimeMs };

    let bytes = 0;
    let lastUsedAt = stat.mtimeMs;
    let entries = [];
    try {
        entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
        return { bytes: 0, lastUsedAt };
    }
    for (const entry of entries) {
        const child = await measureUnit(path.join(absolute, entry.name));
        bytes += child.bytes;
        if (child.lastUsedAt > lastUsedAt) lastUsedAt = child.lastUsedAt;
    }
    return { bytes, lastUsedAt };
}

/** 所有 transcript 的基名（去掉 `.jsonl`），用来判断会话是否还活着。 */
async function collectTranscriptNames(projectsRoot, into = new Set()) {
    let entries;
    try {
        entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    } catch {
        return into;
    }
    for (const entry of entries) {
        const full = path.join(projectsRoot, entry.name);
        if (entry.isDirectory()) {
            await collectTranscriptNames(full, into);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            into.add(entry.name.slice(0, -'.jsonl'.length));
        }
    }
    return into;
}

/**
 * 找出要巡检的 `.pilotdeck` 目录：
 * - `workspaces/**` 下每个工作区自己的（`scope: 'workspace'`，整目录都管）；
 * - 用户主目录下的（`scope: 'home'`，只清 `tool-results`，见文件头注释）。
 */
async function findPilotdeckRoots(home) {
    const roots = [];
    const pushIfPresent = async (candidate, scope) => {
        const stat = await statOrNull(candidate);
        if (stat?.isDirectory()) roots.push({ dir: candidate, scope });
    };

    await pushIfPresent(path.join(home, '.pilotdeck'), 'home');

    const walk = async (dir, depth) => {
        if (depth > 3) return;
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const full = path.join(dir, entry.name);
            if (entry.name === '.pilotdeck') {
                await pushIfPresent(full, 'workspace');
                continue;
            }
            await walk(full, depth + 1);
        }
    };
    await walk(path.join(home, 'workspaces'), 1);
    return roots;
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

/**
 * `tool-results/` 下按会话算：孤儿（transcript 没了）+ TTL。
 * `refs/` 是 read_file 的别名副本，没有 transcript 关联，只按 TTL。
 */
async function sweepToolResults(toolResultsDir, { transcripts, now, ttlMs, graceMs }) {
    let entries;
    try {
        entries = await fs.readdir(toolResultsDir, { withFileTypes: true });
    } catch {
        return { removed: 0, freedBytes: 0 };
    }

    let removed = 0;
    let freedBytes = 0;
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const unitPath = path.join(toolResultsDir, entry.name);
        const { bytes, lastUsedAt } = await measureUnit(unitPath);
        const age = now.getTime() - lastUsedAt;

        const isRefs = entry.name === 'refs';
        const orphan = !isRefs && !transcripts.has(entry.name) && age > graceMs;
        const expired = age > ttlMs;
        if (!orphan && !expired) continue;

        await fs.rm(unitPath, { recursive: true, force: true });
        removed += 1;
        freedBytes += bytes;
    }

    // 空的 tool-results 也收掉（`.pilotdeck` 由调用方按需收）
    await removeDirIfEmpty(toolResultsDir);
    return { removed, freedBytes };
}

/** `.pilotdeck/` 下除 `tool-results` 之外的子项：不看 transcript，只按 TTL。 */
async function sweepSiblings(deckDir, { now, ttlMs }) {
    let entries;
    try {
        entries = await fs.readdir(deckDir, { withFileTypes: true });
    } catch {
        return { removed: 0, freedBytes: 0 };
    }

    let removed = 0;
    let freedBytes = 0;
    for (const entry of entries) {
        if (entry.name === 'tool-results') continue;
        if (CONFIG_ENTRY_NAMES.has(entry.name)) continue;
        const unitPath = path.join(deckDir, entry.name);
        const { bytes, lastUsedAt } = await measureUnit(unitPath);
        if (now.getTime() - lastUsedAt <= ttlMs) continue;
        await fs.rm(unitPath, { recursive: true, force: true });
        removed += 1;
        freedBytes += bytes;
    }
    return { removed, freedBytes };
}

/**
 * 跑一次清理。
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   homes?: string[],
 *   now?: Date,
 *   retentionDays?: number,
 *   graceMs?: number,
 * }} [options]
 * @returns {Promise<Array<{root: string, removed: number, freedBytes: number}>>}
 */
export async function runToolResultsRetention(options = {}) {
    const {
        env = process.env,
        now = new Date(),
        graceMs = ORPHAN_GRACE_MS,
    } = options;
    let retentionDays = options.retentionDays;
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
        try {
            retentionDays = (await getWorkspaceLimits()).toolResultsTtlDays;
        } catch {
            retentionDays = TOOL_RESULTS_TTL_DAYS;
        }
    }
    const ttlMs = retentionDays * DAY_MS;
    const homes = options.homes ?? await listUserHomes(env);
    const results = [];

    for (const home of homes) {
        const transcripts = await collectTranscriptNames(path.join(home, 'projects'));
        const roots = await findPilotdeckRoots(home);

        for (const { dir: deckDir, scope } of roots) {
            const toolResults = path.join(deckDir, 'tool-results');
            const first = await sweepToolResults(toolResults, { transcripts, now, ttlMs, graceMs });
            // 主目录级的 `.pilotdeck` 只清 tool-results：它可能就是应用主目录，
            // 下面的其它子目录不属于"会话过程数据"。
            const second = scope === 'workspace'
                ? await sweepSiblings(deckDir, { now, ttlMs })
                : { removed: 0, freedBytes: 0 };

            // 整个 `.pilotdeck` 空了才收掉（还有人用就留着）。
            await removeDirIfEmpty(deckDir);

            results.push({
                root: deckDir,
                removed: first.removed + second.removed,
                freedBytes: first.freedBytes + second.freedBytes,
            });
        }
    }

    return results;
}

/** 启动时跑一次，之后每 6 小时一次；返回停止函数（测试/退出用）。 */
export function startToolResultsRetention(options = {}) {
    const { intervalMs = DEFAULT_INTERVAL_MS, log = console } = options;
    const run = async () => {
        try {
            const results = await runToolResultsRetention(options);
            const removed = results.reduce((sum, item) => sum + item.removed, 0);
            const freed = results.reduce((sum, item) => sum + item.freedBytes, 0);
            if (removed > 0) {
                log.log(`[tool-results] removed ${removed} stale cache dir${removed === 1 ? '' : 's'} (${freed} bytes)`);
            }
        } catch (error) {
            log.error?.('[tool-results] retention failed:', error?.message ?? error);
        }
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
