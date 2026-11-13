// @vitest-environment node
// 删会话时清 L0 原始对话（项目记忆库 control.sqlite 的 l0_sessions）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { purgeSessionMemoryRows, purgeOrphanSessionMemory } from './sessionMemory.js';

let root;
let pilotHome;
const PROJECT_ID = 'general_med-abc';

function memoryDir() {
    return path.join(pilotHome, 'memory', 'general_med', PROJECT_ID);
}

function createControlDb({ withTable = true } = {}) {
    const dir = memoryDir();
    const dbPath = path.join(dir, 'control.sqlite');
    const db = new Database(dbPath);
    if (withTable) {
        db.exec(`CREATE TABLE l0_sessions (
            l0_index_id TEXT PRIMARY KEY,
            session_key TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            messages_json TEXT NOT NULL,
            source TEXT NOT NULL,
            indexed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );`);
    }
    return { db, dbPath };
}

function insertRow(db, id, sessionKey) {
    db.prepare(`INSERT INTO l0_sessions
        (l0_index_id, session_key, timestamp, messages_json, source, indexed, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)`)
        .run(id, sessionKey, '2026-11-12T00:00:00.000Z', '[]', 'web', '2026-11-12T00:00:00.000Z');
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-session-memory-'));
    pilotHome = path.join(root, 'home');
    await fs.mkdir(memoryDir(), { recursive: true });
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe('purgeSessionMemoryRows', () => {
    it('只删这个会话的行，别的会话不动', async () => {
        const { db } = createControlDb();
        insertRow(db, 'a', 'web:s_delete_me');
        insertRow(db, 'b', 'web:s_delete_me');
        insertRow(db, 'c', 'web:s_keep_me');
        insertRow(db, 'd', 'web:s_delete_me.pre-rewind');
        db.close();

        const result = await purgeSessionMemoryRows({
            projectId: PROJECT_ID,
            sessionId: 'web:s_delete_me',
            pilotHome,
        });

        expect(result.deletedRows).toBe(3);
        const check = new Database(path.join(memoryDir(), 'control.sqlite'));
        const rows = check.prepare('SELECT session_key FROM l0_sessions').all();
        check.close();
        expect(rows).toHaveLength(1);
        expect(rows[0].session_key).toBe('web:s_keep_me');
    });

    it('记忆库不存在时返回 0，不报错', async () => {
        await fs.rm(memoryDir(), { recursive: true, force: true });
        const result = await purgeSessionMemoryRows({
            projectId: PROJECT_ID,
            sessionId: 'web:s_x',
            pilotHome,
        });
        expect(result).toEqual({ deletedRows: 0, dbPath: null });
    });

    it('库里没有 l0_sessions 表时返回 0', async () => {
        const { db } = createControlDb({ withTable: false });
        db.exec('CREATE TABLE other (id TEXT)');
        db.close();

        const result = await purgeSessionMemoryRows({
            projectId: PROJECT_ID,
            sessionId: 'web:s_x',
            pilotHome,
        });

        expect(result.deletedRows).toBe(0);
    });

    it('非类型化项目 / 空会话 ID 直接返回 0', async () => {
        await expect(purgeSessionMemoryRows({ projectId: 'loose-id', sessionId: 'web:s_x', pilotHome }))
            .resolves.toEqual({ deletedRows: 0, dbPath: null });
        await expect(purgeSessionMemoryRows({ projectId: PROJECT_ID, sessionId: '', pilotHome }))
            .resolves.toEqual({ deletedRows: 0, dbPath: null });
    });

    it('库文件损坏时只记日志，不抛出（删会话不能半途而废）', async () => {
        await fs.writeFile(path.join(memoryDir(), 'control.sqlite'), 'not a sqlite database');
        const result = await purgeSessionMemoryRows({
            projectId: PROJECT_ID,
            sessionId: 'web:s_x',
            pilotHome,
        });
        expect(result.deletedRows).toBe(0);
    });
});

describe('purgeOrphanSessionMemory', () => {
    it('删掉 transcript 已不存在的行，保留还活着的会话与它的 .pre-rewind', async () => {
        const { db } = createControlDb();
        insertRow(db, 'a', 'web:s_alive');
        insertRow(db, 'b', 'web:s_alive.pre-rewind');
        insertRow(db, 'c', 'web:s_deleted');
        insertRow(db, 'd', 'web:s_deleted.pre-rewind');
        db.close();

        const chatDir = path.join(pilotHome, 'projects', 'general_med', 'general_med-abc', 'chats');
        await fs.mkdir(chatDir, { recursive: true });
        await fs.writeFile(path.join(chatDir, 'web:s_alive.jsonl'), '{}\n');

        const result = await purgeOrphanSessionMemory({ homes: [pilotHome] });

        expect(result.removedRows).toBe(2);
        const check = new Database(path.join(memoryDir(), 'control.sqlite'));
        const keys = check.prepare('SELECT session_key AS k FROM l0_sessions ORDER BY k').all().map((r) => r.k);
        check.close();
        expect(keys).toEqual(['web:s_alive', 'web:s_alive.pre-rewind']);
    });

    it('没有记忆目录时返回 0', async () => {
        const emptyHome = path.join(root, 'empty-home');
        await fs.mkdir(emptyHome, { recursive: true });
        await expect(purgeOrphanSessionMemory({ homes: [emptyHome] }))
            .resolves.toEqual({ removedRows: 0, freedBytes: 0, dbs: 0 });
    });
});
