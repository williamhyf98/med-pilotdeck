/**
 * 删会话时清掉它留在**项目记忆库**里的原始记录（L0 层）。
 *
 * EdgeClaw 记忆分两层：
 *
 * - **L0**（`<memory>/<类型>/<项目>/control.sqlite` 的 `l0_sessions`）：
 *   按 `session_key` 存**原始对话消息**（`messages_json`），是"提炼记忆"的输入；
 * - **L1/L2**（同目录的 `memory/*.md` + 索引）：从 L0 提炼出的长期事实。
 *
 * 用户删掉一个会话时的预期是"这段对话没了"。L1/L2 是**项目级的提炼结论**，
 * 删除整个会话不应把项目已经学到的知识一起抹掉（设计书里长期记忆按项目存活），
 * 但 L0 存的是原文，留着就等于"删了会话，内容还在库里"，所以这里必须清。
 *
 * 只删这一条 `session_key` 的行，外加它回退时产生的 `<id>.pre-rewind` 影子会话
 * （rewind 会用一个独立 session_key 记录回退前的状态，内容同样来自这段对话）。
 * 表不存在（老项目 / 没跑过记忆）视为成功。
 */
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveTypedProjectMemoryDir } from '../utils/pilotPaths.js';
import { listUserHomes } from './trashRetention.js';

const DAY_MS = 86_400_000;
const PRE_REWIND_SUFFIX = '.pre-rewind';

/**
 * @param {{
 *   projectId: string,
 *   sessionId: string,
 *   pilotHome?: string,
 * }} input
 * @returns {Promise<{ deletedRows: number, dbPath: string | null }>}
 */
export async function purgeSessionMemoryRows({ projectId, sessionId, pilotHome }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { deletedRows: 0, dbPath: null };
    }

    let memoryDir;
    try {
        memoryDir = resolveTypedProjectMemoryDir(projectId, pilotHome);
    } catch {
        // 非类型化项目（没有 memory 目录）——没有可清的记忆。
        return { deletedRows: 0, dbPath: null };
    }

    const dbPath = path.join(memoryDir, 'control.sqlite');
    if (!existsSync(dbPath)) return { deletedRows: 0, dbPath: null };

    let db;
    try {
        db = new Database(dbPath);
        db.pragma('busy_timeout = 5000');
        const hasTable = db
            .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'l0_sessions'")
            .get();
        if (!hasTable) return { deletedRows: 0, dbPath };
        const result = db
            .prepare('DELETE FROM l0_sessions WHERE session_key IN (?, ?)')
            .run(sessionId, `${sessionId}${PRE_REWIND_SUFFIX}`);
        return { deletedRows: Number(result.changes ?? 0), dbPath };
    } catch (error) {
        // 记忆库被 gateway 持有 / 文件损坏都只记日志：删会话不能因此半途而废。
        console.error('[session-memory] failed to purge L0 rows:', error?.message ?? error);
        return { deletedRows: 0, dbPath };
    } finally {
        try {
            db?.close();
        } catch { /* already closed */ }
    }
}

/** 某用户 home 下所有 transcript 的基名（去掉 `.jsonl`）。 */
async function collectTranscriptNames(root, into = new Set()) {
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return into;
    }
    for (const entry of entries) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            await collectTranscriptNames(full, into);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            into.add(entry.name.slice(0, -'.jsonl'.length));
        }
    }
    return into;
}

/** 某用户 home 下所有项目记忆库。 */
async function findControlDbs(root, into = []) {
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return into;
    }
    for (const entry of entries) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            await findControlDbs(full, into);
        } else if (entry.isFile() && entry.name === 'control.sqlite') {
            into.push(full);
        }
    }
    return into;
}

/**
 * 兜底扫描：删掉"transcript 已经不存在"的 L0 行。
 *
 * 正常路径由 `purgeSessionMemoryRows` 在删会话时处理；这里覆盖历史遗留
 * （本功能上线前删掉的会话）以及绕过接口的删除。
 *
 * @param {{ env?: Record<string, string|undefined>, homes?: string[] }} [options]
 * @returns {Promise<{ removedRows: number, freedBytes: number, dbs: number }>}
 */
export async function purgeOrphanSessionMemory(options = {}) {
    const { env = process.env } = options;
    const homes = options.homes ?? await listUserHomes(env);
    let removedRows = 0;
    let freedBytes = 0;
    let dbs = 0;

    for (const home of homes) {
        const alive = await collectTranscriptNames(path.join(home, 'projects'));
        for (const dbPath of await findControlDbs(path.join(home, 'memory'))) {
            let db;
            try {
                db = new Database(dbPath);
                db.pragma('busy_timeout = 5000');
            } catch {
                continue;
            }
            dbs += 1;
            try {
                const rows = db
                    .prepare('SELECT session_key AS k, COUNT(*) AS c, SUM(LENGTH(messages_json)) AS b FROM l0_sessions GROUP BY session_key')
                    .all();
                const del = db.prepare('DELETE FROM l0_sessions WHERE session_key = ?');
                for (const row of rows) {
                    const key = String(row.k ?? '');
                    const base = key.endsWith(PRE_REWIND_SUFFIX)
                        ? key.slice(0, -PRE_REWIND_SUFFIX.length)
                        : key;
                    if (!base || alive.has(base)) continue;
                    del.run(key);
                    removedRows += Number(row.c ?? 0);
                    freedBytes += Number(row.b ?? 0);
                }
            } catch {
                // 老库没有 l0_sessions 表：跳过。
            } finally {
                try { db.close(); } catch { /* already closed */ }
            }
        }
    }

    return { removedRows, freedBytes, dbs };
}

/** 启动时跑一次，之后每天一次；返回停止函数（测试/退出用）。 */
export function startSessionMemorySweep(options = {}) {
    const { intervalMs = DAY_MS, log = console } = options;
    const run = async () => {
        try {
            const result = await purgeOrphanSessionMemory(options);
            if (result.removedRows > 0) {
                log.log(`[session-memory] purged ${result.removedRows} orphan L0 row(s) (${result.freedBytes} bytes)`);
            }
        } catch (error) {
            log.error?.('[session-memory] sweep failed:', error?.message ?? error);
        }
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
