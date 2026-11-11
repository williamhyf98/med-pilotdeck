// A1 软删除：删除文件 = 移进 `.trash`，可恢复，7 天后才物理删除。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteStorageTargets, scanStorage } from './storage.js';
import {
    listTrash,
    moveFileToTrash,
    parseTrashedRelative,
    purgeExpiredTrash,
    restoreFromTrash,
} from '../services/trash.js';

const temporaryHomes = [];
let previousSystemHome;

async function makePilotHome() {
    const pilotHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-trash-'));
    temporaryHomes.push(pilotHome);
    return pilotHome;
}

async function makeWorkspace(pilotHome, relativeFile, content = 'report') {
    const projectId = 'general_med-example';
    const workspace = path.join(pilotHome, 'workspaces', 'general_med', projectId);
    const target = path.join(workspace, relativeFile);
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

describe('A1 软删除', () => {
    it('把文件 rename 进 .trash 而不是真删，并留一条审计', async () => {
        const pilotHome = await makePilotHome();
        const { projectId, workspace, target } = await makeWorkspace(pilotHome, 'exports/report.md', 'hello');

        const result = await deleteStorageTargets([{
            kind: 'file',
            scope: 'workspace',
            groupId: projectId,
            typeKey: 'general_med',
            path: 'exports/report.md',
        }], pilotHome);

        expect(result.failed).toEqual([]);
        await expect(fs.access(target)).rejects.toThrow();

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
        const { projectId } = await makeWorkspace(pilotHome, 'exports/report.md');

        for (const reserved of ['.trash/old.md.20260101T000000000Z', '.usage.json', '.pinned', '.tmp/x']) {
            await expect(deleteStorageTargets([{
                kind: 'file',
                scope: 'workspace',
                groupId: projectId,
                typeKey: 'general_med',
                path: reserved,
            }], pilotHome)).rejects.toThrow(/reserved system path/);
        }
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

    it('扫描口径：回收站文件不再出现在文件列表，但计入 trashBytes', async () => {
        const pilotHome = await makePilotHome();
        const { projectId } = await makeWorkspace(pilotHome, 'exports/report.md', '12345');
        await deleteStorageTargets([{
            kind: 'file',
            scope: 'workspace',
            groupId: projectId,
            typeKey: 'general_med',
            path: 'exports/report.md',
        }], pilotHome);

        const snapshot = await scanStorage(pilotHome);
        expect(snapshot.workspaces[0].files).toEqual([]);
        expect(snapshot.workspaces[0].trashCount).toBe(1);
        expect(snapshot.totals.trashBytes).toBe(5);
        expect(snapshot.totals.workspaceBytes).toBe(0);
        expect(snapshot.totals.totalBytes).toBe(5);
    });
});
