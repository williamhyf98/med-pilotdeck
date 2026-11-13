/**
 * 已归档账号。
 *
 * 管理员"删除账号"是**软删除**：账号行留在库里但 `is_active = 0`，整个 home
 * 被 `rename` 到 `<root>/archives/users/<用户ID>-<时间戳>/`。这样误点一下不会
 * 毁掉研究数据，可以在用户管理页面里恢复。
 *
 * 本模块只提供纯粹的路径/时间戳工具，**不碰数据库**：
 *
 * - `archivedStamp()`     删除时用的目录后缀（UTC，`:` / `.` 换成 `-`，可直接字符串排序）
 * - `parseArchivedHome()` 把目录名解析回 `{ userId, archivedAt }`
 * - `listArchivedHomes()` 扫一遍归档根目录
 * - `findArchivedHome()`  某个用户最近一次归档
 * - `getArchivedUserMaxAgeDays()` 保留天数（`multiUser.retention.archivedUserMaxAgeDays`，默认 30）
 *
 * 目录名格式：`<id>-<YYYY-MM-DD>T<HH-MM-SS>-<mmm>Z`。`<id>-` 这一横必须有，
 * 否则用户 1 会吞掉用户 12 的归档。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolvePilotRoot } from '../utils/pilotPaths.js';

export const DEFAULT_ARCHIVED_USER_MAX_AGE_DAYS = 30;
const CONFIG_CACHE_TTL_MS = 60_000;

const ARCHIVED_NAME_RE = /^(\d+)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/** 删除账号时写进目录名的时间戳，与 `parseArchivedHome` 互为逆运算。 */
export function archivedStamp(now = new Date()) {
    return now.toISOString().replace(/[:.]/g, '-');
}

export function archivedUsersRoot() {
    return path.join(resolvePilotRoot(), 'archives', 'users');
}

/**
 * `12-2026-11-12T10-11-12-123Z` → `{ userId: 12, archivedAt: Date }`。
 * 时间戳非法（月/日越界）时返回 null —— 这类目录一律跳过，绝不猜。
 */
export function parseArchivedHome(name) {
    const match = ARCHIVED_NAME_RE.exec(name);
    if (!match) return null;
    const [, id, y, mo, d, h, mi, s, ms] = match;
    const when = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms);
    const date = new Date(when);
    if (
        Number.isNaN(date.getTime())
        || date.getUTCFullYear() !== +y
        || date.getUTCMonth() !== +mo - 1
        || date.getUTCDate() !== +d
    ) {
        return null;
    }
    return { userId: Number(id), archivedAt: date };
}

/**
 * 所有归档 home，按归档时间从新到旧。
 *
 * 非目录、名字不合规的一律跳过（不动手删，只忽略）：归档根目录可能被人塞了
 * `.DS_Store` 之类的东西，清理任务不该因此报错。
 *
 * @returns {Promise<Array<{ userId: number, archivedAt: Date, name: string, dir: string }>>}
 */
export async function listArchivedHomes(root = archivedUsersRoot()) {
    let entries = [];
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    const out = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const parsed = parseArchivedHome(entry.name);
        if (!parsed) continue;
        out.push({ ...parsed, name: entry.name, dir: path.join(root, entry.name) });
    }
    out.sort((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime());
    return out;
}

/** 该用户最近一次归档；没归档过返回 null。 */
export async function findArchivedHome(userId, root = archivedUsersRoot()) {
    const all = await listArchivedHomes(root);
    return all.find((entry) => entry.userId === Number(userId)) ?? null;
}

let configCache = null;

/**
 * `multiUser.retention.archivedUserMaxAgeDays`，默认 30 天。
 * 读不到 / 解析失败 / 非法值一律回落默认值 —— 清理参数写错不该让服务起不来。
 */
export async function getArchivedUserMaxAgeDays({ now = Date.now } = {}) {
    const at = now();
    if (configCache && configCache.expiresAt > at) return configCache.days;
    let days = DEFAULT_ARCHIVED_USER_MAX_AGE_DAYS;
    const configPath = process.env.PILOTDECK_CONFIG_PATH || path.join(resolvePilotRoot(), 'pilotdeck.yaml');
    try {
        const raw = await fs.readFile(configPath, 'utf8');
        const value = parseYaml(raw)?.multiUser?.retention?.archivedUserMaxAgeDays;
        if (Number.isFinite(value) && value > 0) days = value;
    } catch {
        days = DEFAULT_ARCHIVED_USER_MAX_AGE_DAYS;
    }
    configCache = { days, expiresAt: at + CONFIG_CACHE_TTL_MS };
    return days;
}

export function invalidateArchivedUsersConfigCache() {
    configCache = null;
}
