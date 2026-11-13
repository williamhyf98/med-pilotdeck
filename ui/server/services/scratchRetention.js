/**
 * scratch 自动清理（设计书 §8）。
 *
 * 三条硬规则，任何一条被破坏都会变成"用户的文件自己消失"级别的事故：
 * 1. **只清 `scratch/`**。`inbox/`、`exports/`、用户自建目录永远不动。
 * 2. **按任务单元删**（`scratch/work/<turnId>/` 这类目录整体），不按单文件删：
 *    一个任务产出的 3–5 个中间文件互相依赖，删一半留一半只会让后续命令莫名报错。
 * 3. **保护窗内不动**：最近 `protectRecentMinutes` 分钟被读写过的不清；
 *    `.pinned` 里登记的单元不清。
 *
 * 两种模式：
 * - 自动（`force: false`，默认）：TTL + 容量两道闸门，见下面"触发条件"；
 * - 手动（`force: true`，工作区页"立即清理"）：不看 TTL/容量，能删的全删，
 *   只保留 60 秒防抖窗和 `.pinned`。
 *
 * 触发条件（§8.4）：
 * - 时间：单元 `lastUsedAt` 超过 `scratchTtlDays` 天 → 清；
 * - 大小：`scratch` 总量超过 `scratchMaxBytes` → 按
 *   (类别 0..3, lastUsedAt) 升序清到 `scratchMaxBytes * scratchSoftRatio` 以下。
 *   类别顺序：tool-results（可重跑）→ preview（可再生）→ work → qa（预留）。
 *
 * 失败一律只记日志/审计，不抛给调用方：这是旁路任务。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendAudit } from '../../../src/security/audit/auditLog.js';
import { listUserHomes } from './trashRetention.js';
import { getWorkspaceLimits } from './workspaceLimits.js';

/**
 * 清理顺序 = 数组下标；数字越小越先删。
 *
 * 前四类是设计书 §8.2 的原始分层；`tmp` / `qc` / `docx` / `data` 是技能实际写出来的目录
 * （2026-11-12 补：此前不在这张表里，等于永远清不到）。`data` 放最后 —— 它最接近"成品"，
 * 真到按容量清理时也应该最后才动。
 */
export const SCRATCH_CATEGORIES = Object.freeze([
    'tool-results', 'preview', 'work', 'qa', 'tmp', 'qc', 'docx', 'data',
]);

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/**
 * 强制清理（用户点"立即清理"）的保护窗：只跳过最近 1 分钟还在写的单元，
 * 避免把正在跑的回合删掉。常规自动清理仍用 `protectRecentMinutes`（默认 10 分钟）。
 */
const FORCE_PROTECT_MS = MINUTE_MS;

async function statOrNull(target) {
    try {
        return await fs.lstat(target);
    } catch {
        return null;
    }
}

/**
 * 单元大小 + 最新 mtime（不跟随软链）。
 *
 * 目录自身的 mtime 只反映"最后一次增删条目"，文件被覆盖时它不会变；
 * 反过来，把旧文件复制进新目录又会让它变新。两种方向都会误判，
 * 所以目录一律取**子项 mtime 的最大值**，空目录才回落到目录自己的 mtime。
 */
async function measureUnit(absolute) {
    const stat = await statOrNull(absolute);
    if (!stat) return { bytes: 0, lastUsedAt: 0 };
    if (!stat.isDirectory()) return { bytes: stat.size, lastUsedAt: stat.mtimeMs };
    let bytes = 0;
    let lastUsedAt = 0;
    let entries = [];
    try {
        entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
        return { bytes: 0, lastUsedAt: stat.mtimeMs };
    }
    for (const entry of entries) {
        const child = await measureUnit(path.join(absolute, entry.name));
        bytes += child.bytes;
        if (child.lastUsedAt > lastUsedAt) lastUsedAt = child.lastUsedAt;
    }
    return { bytes, lastUsedAt: lastUsedAt || stat.mtimeMs };
}

/**
 * `.pinned` 保护清单。支持两种格式，读不出来就当没有：
 * - JSON 数组：`["scratch/work/turn-1", …]`
 * - 每行一个路径
 */
async function readPinned(workspaceRoot) {
    const pinned = [];
    let raw;
    try {
        raw = await fs.readFile(path.join(workspaceRoot, '.pinned'), 'utf8');
    } catch {
        return pinned;
    }
    const trimmed = raw.trim();
    if (!trimmed) return pinned;
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                if (typeof item === 'string' && item.trim()) pinned.push(item.trim());
            }
            return pinned;
        }
    } catch {
        // 不是 JSON：按行读。
    }
    for (const line of trimmed.split(/\r?\n/)) {
        const value = line.trim();
        if (value && !value.startsWith('#')) pinned.push(value);
    }
    return pinned;
}

function isPinned(relativePath, pinned) {
    return pinned.some((entry) => {
        const normalized = entry.replace(/\\/g, '/').replace(/\/+$/, '');
        return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
    });
}

async function unitOf(absolute, workspaceRoot, categoryName, category, isDirectory) {
    const { bytes, lastUsedAt } = await measureUnit(absolute);
    return {
        absolute,
        relativePath: path.relative(workspaceRoot, absolute).split(path.sep).join('/'),
        category,
        categoryName,
        bytes,
        lastUsedAt,
        isDirectory,
    };
}

/**
 * `work/` 的单位是**回合**，不是会话：
 * - `work/<session>/<turn>/`（子层全是目录）→ 每个 turn 一个单元，删一个回合不牵连兄弟回合；
 * - `work/<name>/`（自身直接放文件，例如技能自己 mkdir 的 `mwbs19p9/`）→ 整个目录一个单元；
 * - `work/<file>` → 单文件一个单元。
 */
async function listWorkUnits(workDir, workspaceRoot, category) {
    const units = [];
    let entries = [];
    try {
        entries = await fs.readdir(workDir, { withFileTypes: true });
    } catch {
        return units;
    }
    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(workDir, entry.name);
        if (!entry.isDirectory()) {
            units.push(await unitOf(absolute, workspaceRoot, 'work', category, false));
            continue;
        }
        let children = [];
        try {
            children = await fs.readdir(absolute, { withFileTypes: true });
        } catch {
            children = [];
        }
        const childDirs = children.filter((child) => child.isDirectory() && !child.isSymbolicLink());
        const childOthers = children.filter((child) => !child.isDirectory());
        if (childDirs.length > 0 && childOthers.length === 0) {
            for (const child of childDirs) {
                units.push(await unitOf(path.join(absolute, child.name), workspaceRoot, 'work', category, true));
            }
        } else {
            units.push(await unitOf(absolute, workspaceRoot, 'work', category, true));
        }
    }
    return units;
}

/**
 * 列表某个工作区 `scratch/` 下的清理单元。只走 `scratch/`，绝不越界。
 *
 * 除八类目录外，也收 `scratch/` 根下散落的文件/目录（隐藏项除外）——
 * 技能偶尔会直接往根下写 `_t1.txt`、`arch_diagram/` 这类东西，不收就永远清不掉。
 */
export async function listScratchUnits(workspaceRoot) {
    const scratchRoot = path.join(workspaceRoot, 'scratch');
    const units = [];
    for (let category = 0; category < SCRATCH_CATEGORIES.length; category += 1) {
        const categoryName = SCRATCH_CATEGORIES[category];
        const categoryDir = path.join(scratchRoot, categoryName);
        if (categoryName === 'work') {
            units.push(...await listWorkUnits(categoryDir, workspaceRoot, category));
            continue;
        }
        let entries = [];
        try {
            entries = await fs.readdir(categoryDir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const absolute = path.join(categoryDir, entry.name);
            units.push(await unitOf(absolute, workspaceRoot, categoryName, category, entry.isDirectory()));
        }
    }

    // scratch 根下散落项（`_t1.txt`、技能自建目录）；跳过 8 个受管目录与所有隐藏项
    // （`.analysis-cache`、`.analysis-root.json`、`.usage.json` 等都靠前缀排除）。
    let rootEntries = [];
    try {
        rootEntries = await fs.readdir(scratchRoot, { withFileTypes: true });
    } catch {
        rootEntries = [];
    }
    for (const entry of rootEntries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.name.startsWith('.')) continue;
        if (SCRATCH_CATEGORIES.includes(entry.name)) continue;
        const absolute = path.join(scratchRoot, entry.name);
        units.push(await unitOf(
            absolute,
            workspaceRoot,
            'root',
            SCRATCH_CATEGORIES.length,
            entry.isDirectory(),
        ));
    }
    return units;
}

/** 单元所属的目录名（审计用；根下散落项记 `root`）。 */
function categoryOf(unit) {
    return unit.categoryName ?? SCRATCH_CATEGORIES[unit.category] ?? 'root';
}

/**
 * 删完一个回合后，父会话目录若空了就顺手收掉（只 rmdir 空目录）。
 * 到 `scratch/<category>` 这一层就停 —— 骨架目录要留着。
 */
async function pruneEmptyParent(unit, scratchRoot) {
    if (!unit.isDirectory) return;
    let parent = path.dirname(unit.absolute);
    while (path.dirname(parent) !== scratchRoot) {
        const relative = path.relative(scratchRoot, parent);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
        try {
            const left = await fs.readdir(parent);
            if (left.length > 0) return;
            await fs.rmdir(parent);
        } catch {
            return;
        }
        parent = path.dirname(parent);
    }
}

async function removeUnit(unit) {
    await fs.rm(unit.absolute, { recursive: true, force: true });
}

/**
 * 跑一次清理。
 *
 * @param {string} workspaceRoot 工作区根目录
 * @param {{
 *   now?: Date,
 *   scratchMaxBytes?: number,
 *   scratchSoftRatio?: number,
 *   scratchTtlDays?: number,
 *   protectRecentMinutes?: number,
 *   force?: boolean,
 *   audit?: boolean,
 * }} [options]
 * @returns {Promise<{removed: number, freedBytes: number, usedBefore: number, usedAfter: number, skipped: number}>}
 */
export async function cleanScratch(workspaceRoot, options = {}) {
    const {
        now = new Date(),
        force = false,
        audit = true,
    } = options;
    const limits = await getWorkspaceLimits();
    const scratchMaxBytes = options.scratchMaxBytes ?? limits.scratchMaxBytes;
    const softRatio = options.scratchSoftRatio ?? limits.scratchSoftRatio;
    const ttlDays = options.scratchTtlDays ?? limits.scratchTtlDays;
    const protectMinutes = options.protectRecentMinutes ?? limits.protectRecentMinutes;
    const scratchRoot = path.resolve(workspaceRoot, 'scratch');

    const nowMs = now.getTime();
    const ttlCutoff = nowMs - ttlDays * DAY_MS;
    // 强制清理是用户的明确指令：只留 1 分钟防手抖，不再受 TTL / 容量 / 10 分钟保护窗约束。
    const protectCutoff = nowMs - (force ? FORCE_PROTECT_MS : protectMinutes * MINUTE_MS);
    const target = Math.floor(scratchMaxBytes * softRatio);

    const units = await listScratchUnits(workspaceRoot);
    const pinned = await readPinned(workspaceRoot);
    const usedBefore = units.reduce((sum, unit) => sum + unit.bytes, 0);

    const removable = units.filter((unit) => unit.lastUsedAt <= protectCutoff
        && !isPinned(unit.relativePath, pinned));
    const skipped = units.length - removable.length;

    let removed = 0;
    let freedBytes = 0;
    const doomed = new Set();

    const purge = async (unit, reason) => {
        if (doomed.has(unit.relativePath)) return;
        try {
            await removeUnit(unit);
            await pruneEmptyParent(unit, scratchRoot);
            doomed.add(unit.relativePath);
            removed += 1;
            freedBytes += unit.bytes;
            if (audit) {
                appendAudit({
                    action: 'scratch.clean',
                    decision: 'allow',
                    tool: 'scratch.retention',
                    target: unit.relativePath,
                    reason,
                    meta: {
                        bytes: unit.bytes,
                        category: categoryOf(unit),
                        lastUsedAt: new Date(unit.lastUsedAt).toISOString(),
                    },
                });
            }
        } catch (error) {
            if (audit) {
                appendAudit({
                    action: 'scratch.clean_failed',
                    decision: 'error',
                    tool: 'scratch.retention',
                    target: unit.relativePath,
                    reason: error?.code ?? 'clean_failed',
                    meta: { message: error instanceof Error ? error.message : String(error) },
                });
            }
        }
    };

    let used = usedBefore;

    if (force) {
        // 用户手动触发：不看 TTL、不看容量，能删的全删（保护窗与 .pinned 仍然生效）。
        for (const unit of removable) {
            await purge(unit, 'manual');
            if (doomed.has(unit.relativePath)) used -= unit.bytes;
        }
    } else {
        // 1) 时间维度：超过 TTL 的单元。
        for (const unit of removable) {
            if (unit.lastUsedAt <= ttlCutoff) await purge(unit, 'expired');
        }

        // 2) 大小维度：只在上限之上动手，按 (类别, 最近使用) 顺序清到软阈值以下。
        used = usedBefore
            - removable.filter((unit) => doomed.has(unit.relativePath))
                .reduce((sum, unit) => sum + unit.bytes, 0);
        if (used > scratchMaxBytes) {
            const queue = removable
                .filter((unit) => !doomed.has(unit.relativePath))
                .sort((left, right) => (left.category - right.category) || (left.lastUsedAt - right.lastUsedAt));
            for (const unit of queue) {
                if (used <= target) break;
                await purge(unit, 'over-limit');
                if (doomed.has(unit.relativePath)) used -= unit.bytes;
            }
        }
    }

    return { removed, freedBytes, usedBefore, usedAfter: Math.max(0, used), skipped };
}

/** 逐个用户 home、逐个工作区跑一次；返回每个工作区的结果。 */
export async function cleanScratchInHomes(homes, options = {}) {
    const results = [];
    for (const pilotHome of homes) {
        const workspaceRoot = path.join(pilotHome, 'workspaces');
        let typeEntries = [];
        try {
            typeEntries = await fs.readdir(workspaceRoot, { withFileTypes: true });
        } catch {
            continue;
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
                const root = path.join(typeRoot, groupEntry.name);
                try {
                    results.push({ root, ...(await cleanScratch(root, options)) });
                } catch (error) {
                    results.push({ root, error: error instanceof Error ? error.message : String(error) });
                }
            }
        }
    }
    return results;
}

/** 启动时跑一次，之后每 6 小时一次（§8.5 的校准节奏）；返回停止函数。 */
export function startScratchRetention(options = {}) {
    const { intervalMs = 6 * 60 * MINUTE_MS, log = console } = options;
    const run = async () => {
        try {
            const homes = options.homes ?? await listUserHomes(options.env ?? process.env);
            const results = await cleanScratchInHomes(homes, options);
            const removed = results.reduce((sum, item) => sum + (item.removed ?? 0), 0);
            const freed = results.reduce((sum, item) => sum + (item.freedBytes ?? 0), 0);
            if (removed > 0) {
                log.log?.(`[scratch] removed ${removed} unit(s), freed ${freed} bytes`);
            }
        } catch (error) {
            log.error?.('[scratch] retention failed:', error?.message ?? error);
        }
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
