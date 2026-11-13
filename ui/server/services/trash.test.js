/**
 * 文件级回收站（A1/A2）：删除 = rename 进 `.trash`，可恢复，7 天后物理删除。
 *
 * 2026-11-12 起「存储页删单文件 / 整包归档」两条入口都下线了，写入方只剩工作区面板
 * （`routes/workspaceFiles.js`），所以这里直接测 `services/trash.js` 本身。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    emptyTrash,
    listTrash,
    moveFileToTrash,
    parseTrashedRelative,
    purgeExpiredTrash,
    restoreFromTrash,
} from './trash.js';

const temporaryHomes = [];
let previousSystemHome;

async function makePilotHome() {
    const pilotHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-trash-'));
    temporaryHomes.push(pilotHome);
    return pilotHome;
}

async function makeWorkspace(pilotHome, relativePath, content = 'report') {
    const projectId = 'general_med-example';
    const workspace = path.join(pilotHome, 'workspaces', 'general_med', projectId);
    const target = path.join(workspace, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    return { projectId, workspace, target };
}

async function readAudit(systemHome) {
    const directory = path.join(systemHome, 'system', 'audit');
    let files = [];
    try {
        files = await fs.readdir(directory);
    } catch {
        return [];
    }
    const lines = [];
    for (const file of files) {
        const raw = await fs.readFile(path.join(directory, file), 'utf8');
        for (const line of raw.split('\n')) {
            if (line.trim()) lines.push(JSON.parse(line));
        }
    }
    return lines;
}

beforeEach(async () => {
    // 审计写到独立目录，别污染开发机真实的 ~/.pilotdeck
    const systemHome = await makePilotHome();
    previousSystemHome = process.env.PILOTDECK_SYSTEM_HOME;
    process.env.PILOTDECK_SYSTEM_HOME = systemHome;
});

afterEach(async () => {
    if (previousSystemHome === undefined) delete process.env.PILOTDECK_SYSTEM_HOME;
    else process.env.PILOTDECK_SYSTEM_HOME = previousSystemHome;
    await Promise.all(temporaryHomes.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
    ));
});

describe('文件级回收站', () => {
    it('把文件 rename 进 .trash 而不是真删，并留一条审计', async () => {
        const pilotHome = await makePilotHome();
        const { workspace, target } = await makeWorkspace(pilotHome, 'exports/report.md', 'hello');

        const moved = await moveFileToTrash(workspace, 'exports/report.md');

        await expect(fs.access(target)).rejects.toThrow();
        expect(moved.trashedPath).toMatch(/^\.trash\/exports\/report\.md\./);

        const entries = await listTrash(workspace);
        expect(entries).toHaveLength(1);
        expect(entries[0].originalPath).toBe('exports/report.md');
        await expect(fs.readFile(path.join(workspace, entries[0].path), 'utf8')).resolves.toBe('hello');

        const audit = await readAudit(process.env.PILOTDECK_SYSTEM_HOME);
        expect(audit.map((item) => item.action)).toContain('file.trash');
        expect(audit.find((item) => item.action === 'file.trash').target).toBe('exports/report.md');
    });

    it('系统保留项不能删（.trash / .usage.json / .pinned / .tmp）', async () => {
        const pilotHome = await makePilotHome();
        const { workspace } = await makeWorkspace(pilotHome, 'exports/report.md');

        for (const reserved of ['.trash/old.md.20260101T000000000Z', '.usage.json', '.pinned', '.tmp/x']) {
            await expect(moveFileToTrash(workspace, reserved)).rejects.toThrow(/reserved system path/);
        }
    });

    it('不能借 ../ 逃出工作区', async () => {
        const pilotHome = await makePilotHome();
        const { workspace } = await makeWorkspace(pilotHome, 'exports/report.md');
        const outside = path.join(pilotHome, 'keep.txt');
        await fs.writeFile(outside, 'keep');

        await expect(moveFileToTrash(workspace, '../../../keep.txt')).rejects.toThrow();
        await expect(fs.readFile(outside, 'utf8')).resolves.toBe('keep');
    });

    it('rename 失败只报错，绝不退化成 rm', async () => {
        const pilotHome = await makePilotHome();
        const { workspace, target } = await makeWorkspace(pilotHome, 'exports/report.md', 'keep-me');
        // 把 .trash 占成普通文件，mkdir/rename 必然失败
        await fs.writeFile(path.join(workspace, '.trash'), 'not a directory');

        await expect(moveFileToTrash(workspace, 'exports/report.md'))
            .rejects.toThrow(/无法移入回收站/);
        await expect(fs.readFile(target, 'utf8')).resolves.toBe('keep-me');

        const audit = await readAudit(process.env.PILOTDECK_SYSTEM_HOME);
        expect(audit.map((item) => item.action)).toContain('file.trash_failed');
    });

    it('恢复回到原路径；再恢复一次报 trash_not_found；原路径被占用报 target_exists', async () => {
        const pilotHome = await makePilotHome();
        const { workspace, target } = await makeWorkspace(pilotHome, 'exports/report.md', 'restore-me');

        const moved = await moveFileToTrash(workspace, 'exports/report.md');
        const restored = await restoreFromTrash(workspace, moved.trashedPath);
        expect(restored.path).toBe('exports/report.md');
        await expect(fs.readFile(target, 'utf8')).resolves.toBe('restore-me');
        expect(await listTrash(workspace)).toEqual([]);

        await expect(restoreFromTrash(workspace, moved.trashedPath))
            .rejects.toThrow(/no longer exists/);

        const second = await moveFileToTrash(workspace, 'exports/report.md');
        await fs.writeFile(target, 'newer');
        await expect(restoreFromTrash(workspace, second.trashedPath))
            .rejects.toMatchObject({ code: 'target_exists' });
        await expect(fs.readFile(target, 'utf8')).resolves.toBe('newer');
    });

    it('回收站条目解析：只有 .trash/<路径>.<stamp> 才算，保留项不行', async () => {
        expect(parseTrashedRelative('.trash/exports/a.md.20260101T000000000Z'))
            .toMatchObject({ originalPath: 'exports/a.md' });
        expect(parseTrashedRelative('.trash/exports/a.md')).toBeNull();
        expect(parseTrashedRelative('exports/a.md.20260101T000000000Z')).toBeNull();
        expect(parseTrashedRelative('.trash/.usage.json.20260101T000000000Z')).toBeNull();
        expect(parseTrashedRelative('.trash/../escape.md.20260101T000000000Z')).toBeNull();
    });

    it('过期清理只删超过 7 天的，删完写审计', async () => {
        const pilotHome = await makePilotHome();
        const { workspace } = await makeWorkspace(pilotHome, 'exports/old.md', 'old');
        await fs.writeFile(path.join(workspace, 'exports', 'fresh.md'), 'fresh');
        const old = await moveFileToTrash(workspace, 'exports/old.md', { now: new Date('2026-01-01T00:00:00.000Z') });
        await moveFileToTrash(workspace, 'exports/fresh.md', { now: new Date('2026-01-07T00:00:00.000Z') });

        const result = await purgeExpiredTrash(workspace, { now: new Date('2026-01-08T00:00:00.000Z') });
        expect(result.purged).toBe(1);

        const entries = await listTrash(workspace);
        expect(entries.map((entry) => entry.originalPath)).toEqual(['exports/fresh.md']);
        await expect(fs.access(path.join(workspace, old.trashedPath))).rejects.toThrow();

        const audit = await readAudit(process.env.PILOTDECK_SYSTEM_HOME);
        const purge = audit.find((item) => item.action === 'trash.purge');
        expect(purge.target).toBe('exports/old.md');
        expect(purge.meta.retentionDays).toBe(7);
    });

    it('emptyTrash 连目录条目一起清掉，并写 manual 审计', async () => {
        const pilotHome = await makePilotHome();
        const { workspace } = await makeWorkspace(pilotHome, 'exports/report.md', 'hello');
        await fs.mkdir(path.join(workspace, '我的资料', '2026'), { recursive: true });
        await fs.writeFile(path.join(workspace, '我的资料', '2026', 'a.csv'), '1234');
        await moveFileToTrash(workspace, 'exports/report.md');
        await moveFileToTrash(workspace, '我的资料');
        expect(await listTrash(workspace)).toHaveLength(2);

        const result = await emptyTrash(workspace, { actor: 'admin' });
        expect(result.purged).toBe(2);
        expect(result.freedBytes).toBe(5 + 4);
        expect(await listTrash(workspace)).toEqual([]);
        await expect(fs.access(path.join(workspace, '.trash', '我的资料'))).rejects.toThrow();

        const audit = await readAudit(process.env.PILOTDECK_SYSTEM_HOME);
        const purges = audit.filter((item) => item.action === 'trash.purge');
        expect(purges).toHaveLength(2);
        expect(purges.every((item) => item.reason === 'manual' && item.actor === 'admin')).toBe(true);
        expect(purges.map((item) => item.meta.kind).sort()).toEqual(['directory', 'file']);
    });

    it('过期清理能把过期的目录条目整棵删掉', async () => {
        const pilotHome = await makePilotHome();
        const { workspace } = await makeWorkspace(pilotHome, 'exports/report.md', 'hello');
        await fs.mkdir(path.join(workspace, '我的资料', '2026'), { recursive: true });
        await fs.writeFile(path.join(workspace, '我的资料', '2026', 'a.csv'), '1234');
        await moveFileToTrash(workspace, '我的资料', { now: new Date(Date.now() - 10 * 86_400_000) });

        const result = await purgeExpiredTrash(workspace, { now: new Date() });
        expect(result.purged).toBe(1);
        expect(result.freedBytes).toBe(4);
        expect(await listTrash(workspace)).toEqual([]);
    });
});
