/**
 * 项目归档下线的收尾：启动时清掉 `archives/projects` 与整包回收站 `.trash/groups`，
 * 但**绝不能**碰账号归档 `archives/users`。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { purgeLegacyProjectArchives } from './legacyProjectArchives.js';

const temporaryHomes = [];

async function makePilotHome() {
    const pilotHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-legacy-'));
    temporaryHomes.push(pilotHome);
    return pilotHome;
}

afterEach(async () => {
    await Promise.all(temporaryHomes.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
    ));
});

describe('purgeLegacyProjectArchives', () => {
    it('清掉项目归档与整包回收站，保留账号归档', async () => {
        const pilotHome = await makePilotHome();
        const archiveProject = path.join(pilotHome, 'archives', 'projects', 'general_med-old-20260831T010203Z');
        const groupTrash = path.join(pilotHome, '.trash', 'groups', 'trauma_med-old-20260831T010203Z');
        const userArchive = path.join(pilotHome, 'archives', 'users', '7');
        await fs.mkdir(path.join(archiveProject, 'exports'), { recursive: true });
        await fs.writeFile(path.join(archiveProject, 'exports', 'a.md'), '12345');
        await fs.mkdir(groupTrash, { recursive: true });
        await fs.writeFile(path.join(groupTrash, 'b.md'), '123');
        await fs.mkdir(userArchive, { recursive: true });
        await fs.writeFile(path.join(userArchive, 'user.json'), '{}');

        const result = await purgeLegacyProjectArchives({ pilotHome, log: { log() {}, warn() {} } });

        expect(result.removed.map((item) => item.path).sort()).toEqual(['.trash/groups', 'archives/projects']);
        expect(result.freedBytes).toBe(8);
        await expect(fs.access(path.join(pilotHome, 'archives', 'projects'))).rejects.toThrow();
        await expect(fs.access(path.join(pilotHome, '.trash', 'groups'))).rejects.toThrow();
        // 账号归档还在，`archives/` 也还在
        await expect(fs.readFile(path.join(userArchive, 'user.json'), 'utf8')).resolves.toBe('{}');
    });

    it('archives 只剩空壳时连父目录一起收掉', async () => {
        const pilotHome = await makePilotHome();
        await fs.mkdir(path.join(pilotHome, 'archives', 'projects', 'x'), { recursive: true });

        await purgeLegacyProjectArchives({ pilotHome, log: { log() {}, warn() {} } });

        await expect(fs.access(path.join(pilotHome, 'archives'))).rejects.toThrow();
    });

    it('没有存量时是空操作', async () => {
        const pilotHome = await makePilotHome();
        const result = await purgeLegacyProjectArchives({ pilotHome, log: { log() {}, warn() {} } });
        expect(result).toEqual({ removed: [], freedBytes: 0 });
    });

    it('多用户：每个用户 home 下的存量都要清掉（不能只扫根目录）', async () => {
        const root = await makePilotHome();
        for (const id of ['1', '2']) {
            const archive = path.join(root, 'users', id, 'archives', 'projects', `general_med-x-20260831T010203Z`);
            await fs.mkdir(archive, { recursive: true });
            await fs.writeFile(path.join(archive, 'a.md'), '123');
            await fs.mkdir(path.join(root, 'users', id, '.trash', 'groups'), { recursive: true });
        }
        // 根目录下的迁移备份不该被动
        const legacy = path.join(root, 'archives', 'legacy-2026-10-15T08-53-06-112Z');
        await fs.mkdir(legacy, { recursive: true });
        await fs.writeFile(path.join(legacy, 'keep.bin'), 'x');

        const result = await purgeLegacyProjectArchives({
            homes: await (await import('./trashRetention.js')).listUserHomes({ PILOT_HOME: root }),
            log: { log() {}, warn() {} },
        });

        expect(result.removed).toHaveLength(4);
        expect(result.removed.every((item) => item.home.startsWith(path.join(root, 'users')))).toBe(true);
        for (const id of ['1', '2']) {
            await expect(fs.access(path.join(root, 'users', id, 'archives', 'projects'))).rejects.toThrow();
            await expect(fs.access(path.join(root, 'users', id, '.trash', 'groups'))).rejects.toThrow();
        }
        await expect(fs.readFile(path.join(legacy, 'keep.bin'), 'utf8')).resolves.toBe('x');
    });

    it('不跟随符号链接', async () => {
        const pilotHome = await makePilotHome();
        const outside = path.join(pilotHome, 'outside');
        await fs.mkdir(outside, { recursive: true });
        await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
        await fs.mkdir(path.join(pilotHome, 'archives', 'projects'), { recursive: true });
        await fs.symlink(outside, path.join(pilotHome, 'archives', 'projects', 'link'));

        await purgeLegacyProjectArchives({ pilotHome, log: { log() {}, warn() {} } });

        await expect(fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    });
});
