// @vitest-environment node
// .rewind-backups 保留策略：每会话留最近 3 份 + 30 天过期。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    runRewindBackupRetention,
    sessionIdFromBackupName,
    REWIND_BACKUP_KEEP,
} from './rewindBackupRetention.js';

const DAY_MS = 86_400_000;

let root;
let home;
let chatDir;
let rewindDir;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-rewind-'));
    home = path.join(root, 'users', '1');
    chatDir = path.join(home, 'projects', 'general_med', 'general_med-abc', 'chats');
    rewindDir = path.join(chatDir, '.rewind-backups');
    await fs.mkdir(rewindDir, { recursive: true });
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

async function exists(target) {
    try {
        await fs.lstat(target);
        return true;
    } catch {
        return false;
    }
}

/** 造一份备份；`stamp` 决定同会话内的新旧顺序，`ageDays` 决定 mtime。 */
async function makeBackup(sessionId, stamp, { ageDays = 0, bytes = 32 } = {}) {
    const name = `${sessionId}.2026-11-${stamp}T06-31-00-000Z-abcd1234.jsonl`;
    const file = path.join(rewindDir, name);
    await fs.writeFile(file, 'x'.repeat(bytes));
    if (ageDays > 0) {
        const when = new Date(Date.now() - ageDays * DAY_MS);
        await fs.utimes(file, when, when);
    }
    return file;
}

describe('sessionIdFromBackupName', () => {
    it('拆出会话 ID，且不会把时间戳当会话名', () => {
        expect(sessionIdFromBackupName('web:s_abc.2026-11-12T06-31-00-000Z-ab12cd34.jsonl')).toBe('web:s_abc');
        expect(sessionIdFromBackupName('not-a-backup.jsonl')).toBeNull();
    });
});

describe('runRewindBackupRetention', () => {
    it('同一会话只留最近 3 份', async () => {
        const files = [];
        for (const stamp of ['09', '10', '11', '12', '13']) {
            files.push(await makeBackup('web:s_abc', stamp));
        }

        const results = await runRewindBackupRetention({ homes: [home] });

        const remaining = (await fs.readdir(rewindDir)).sort();
        expect(remaining).toHaveLength(REWIND_BACKUP_KEEP);
        expect(remaining).toEqual([
            'web:s_abc.2026-11-11T06-31-00-000Z-abcd1234.jsonl',
            'web:s_abc.2026-11-12T06-31-00-000Z-abcd1234.jsonl',
            'web:s_abc.2026-11-13T06-31-00-000Z-abcd1234.jsonl',
        ]);
        expect(results.reduce((sum, item) => sum + item.removed, 0)).toBe(2);
    });

    it('不同会话各自计数，互不影响', async () => {
        for (const stamp of ['09', '10', '11', '12']) await makeBackup('web:s_a', stamp);
        const other = await makeBackup('web:s_b', '10');

        await runRewindBackupRetention({ homes: [home] });

        expect(await exists(other)).toBe(true);
        expect((await fs.readdir(rewindDir)).filter((n) => n.startsWith('web:s_a.')).length).toBe(3);
    });

    it('超过 30 天的备份即便不足 3 份也删', async () => {
        const old = await makeBackup('web:s_old', '01', { ageDays: 40 });
        const fresh = await makeBackup('web:s_fresh', '10', { ageDays: 1 });

        await runRewindBackupRetention({ homes: [home] });

        expect(await exists(old)).toBe(false);
        expect(await exists(fresh)).toBe(true);
    });

    it('keep / retentionDays 可覆盖默认值', async () => {
        const a = await makeBackup('web:s_x', '10');
        const b = await makeBackup('web:s_x', '11');

        await runRewindBackupRetention({ homes: [home], keep: 1 });

        expect(await exists(b)).toBe(true);
        expect(await exists(a)).toBe(false);
    });

    it('清空后把空的 .rewind-backups 目录也收掉', async () => {
        await makeBackup('web:s_solo', '01', { ageDays: 60 });

        await runRewindBackupRetention({ homes: [home] });

        expect(await exists(rewindDir)).toBe(false);
        expect(await exists(chatDir)).toBe(true);
    });

    it('没有 .rewind-backups 时不报错', async () => {
        const results = await runRewindBackupRetention({ homes: [path.join(root, 'nobody')] });
        expect(results).toEqual([]);
    });
});
