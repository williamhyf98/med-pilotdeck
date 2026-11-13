/**
 * 删项目 = 真删（2026-11-12 起）。这里只测文件系统那一层：
 * 五处目录必须全部消失，且绝不能因为 projectId 里带 `../` 删到别人头上。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { purgeProjectStorage } from './projectDelete.js';

const temporaryHomes = [];

async function makePilotHome() {
    const pilotHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-purge-'));
    temporaryHomes.push(pilotHome);
    return pilotHome;
}

async function seedProject(pilotHome, projectId) {
    const typeKey = 'general_med';
    const paths = {
        workspace: path.join(pilotHome, 'workspaces', typeKey, projectId),
        projectDir: path.join(pilotHome, 'projects', typeKey, projectId),
        legacyProjectDir: path.join(pilotHome, 'projects', projectId),
        memory: path.join(pilotHome, 'memory', typeKey, projectId),
        alwaysOn: path.join(pilotHome, 'always-on', 'projects', projectId),
    };
    for (const [label, dir] of Object.entries(paths)) {
        await fs.mkdir(path.join(dir, 'inner'), { recursive: true });
        await fs.writeFile(path.join(dir, 'inner', `${label}.bin`), 'x');
    }
    await fs.mkdir(path.join(paths.projectDir, 'chats'), { recursive: true });
    await fs.writeFile(path.join(paths.projectDir, 'chats', 's1.jsonl'), '{}');
    return paths;
}

afterEach(async () => {
    await Promise.all(temporaryHomes.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
    ));
});

describe('purgeProjectStorage', () => {
    it('把项目相关的五处目录全部物理删除', async () => {
        const pilotHome = await makePilotHome();
        const projectId = 'general_med-demo';
        const paths = await seedProject(pilotHome, projectId);

        const result = await purgeProjectStorage({ pilotHome, projectId });

        expect(result.success).toBe(true);
        expect(result.deleted).toEqual({
            workspace: true,
            projectDir: true,
            legacyProjectDir: true,
            memory: true,
            alwaysOn: true,
        });
        for (const dir of Object.values(paths)) {
            await expect(fs.access(dir)).rejects.toThrow();
        }
    });

    it('只删目标项目，旁边的项目与账号归档不动', async () => {
        const pilotHome = await makePilotHome();
        const keep = await seedProject(pilotHome, 'general_med-keep');
        await seedProject(pilotHome, 'general_med-drop');
        const userArchive = path.join(pilotHome, 'archives', 'users', '5');
        await fs.mkdir(userArchive, { recursive: true });
        await fs.writeFile(path.join(userArchive, 'user.json'), '{}');

        await purgeProjectStorage({ pilotHome, projectId: 'general_med-drop' });

        for (const dir of Object.values(keep)) {
            await expect(fs.access(dir)).resolves.toBeUndefined();
        }
        await expect(fs.readFile(path.join(userArchive, 'user.json'), 'utf8')).resolves.toBe('{}');
    });

    it('项目本来就不存在时返回 success:false 而不报错；force 时视为成功', async () => {
        const pilotHome = await makePilotHome();
        const projectId = 'general_med-ghost';

        const result = await purgeProjectStorage({ pilotHome, projectId });
        expect(result.success).toBe(false);
        expect(result.deleted).toEqual({
            workspace: false,
            projectDir: false,
            legacyProjectDir: false,
            memory: false,
            alwaysOn: false,
        });

        const forced = await purgeProjectStorage({ pilotHome, projectId, force: true });
        expect(forced.success).toBe(true);
    });

    it('projectId 里带路径分量一律拒绝，不会删到目录外面', async () => {
        const pilotHome = await makePilotHome();
        const outside = path.join(pilotHome, 'keep.txt');
        await fs.writeFile(outside, 'keep');

        for (const projectId of ['', '..', '.', '../keep.txt', 'a/b', 'a\\b']) {
            await expect(purgeProjectStorage({ pilotHome, projectId }))
                .rejects.toMatchObject({ code: 'INVALID_PROJECT_ID' });
        }
        await expect(fs.readFile(outside, 'utf8')).resolves.toBe('keep');
    });
});
