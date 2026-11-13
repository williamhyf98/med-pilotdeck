/**
 * 存储页数据源（2026-11-12 改版）：**项目视角**，不再有归档 tab。
 *
 * 断言的是快照口径：
 *   - 只列 `workspaces/<类型>/<项目>` 下的在用项目；
 *   - `files[]` 不含 `.trash`（软删文件不算"当前文件"），但 `trashBytes` 单独记账；
 *   - 不跟随符号链接；
 *   - 预览只允许落在在用项目工作区内、不允许 `../` 逃逸。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePreviewTarget, scanStorage } from './storage.js';

const temporaryHomes = [];

async function makePilotHome() {
    const pilotHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-storage-'));
    temporaryHomes.push(pilotHome);
    return pilotHome;
}

afterEach(async () => {
    await Promise.all(temporaryHomes.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
    ));
});

describe('存储快照', () => {
    it('按项目聚合：文件、用量、会话数、回收站分开记账，且不跟随符号链接', async () => {
        const pilotHome = await makePilotHome();
        const projectId = 'general_med-example';
        const workspace = path.join(pilotHome, 'workspaces', 'general_med', projectId);
        const projectDir = path.join(pilotHome, 'projects', 'general_med', projectId);
        await fs.mkdir(path.join(workspace, 'exports'), { recursive: true });
        await fs.mkdir(path.join(workspace, 'inbox'), { recursive: true });
        await fs.mkdir(path.join(workspace, '.trash', 'exports'), { recursive: true });
        await fs.mkdir(path.join(projectDir, 'chats'), { recursive: true });
        await fs.writeFile(path.join(workspace, 'exports', 'report.pdf'), Buffer.alloc(13));
        await fs.writeFile(path.join(workspace, 'inbox', 'scan.csv'), '1234');
        await fs.writeFile(path.join(workspace, '.trash', 'exports', 'gone.md.20260101T000000000Z'), '12345');
        await fs.writeFile(
            path.join(projectDir, 'meta.json'),
            JSON.stringify({ displayName: '病例讨论', type: 'general_medicine' }),
        );
        await fs.writeFile(path.join(projectDir, 'chats', 's1.jsonl'), '{}');
        await fs.writeFile(path.join(projectDir, 'chats', 's1.jsonl.pre-rewind-20260101'), '{}');
        await fs.symlink('/etc/passwd', path.join(workspace, 'exports', 'outside.txt'));

        const result = await scanStorage(pilotHome);

        expect(result.totals).toEqual({
            totalBytes: 13 + 4 + 5,
            workspaceBytes: 13 + 4,
            trashBytes: 5,
            projectCount: 1,
        });
        expect(result.projects[0]).toMatchObject({
            id: projectId,
            displayName: '病例讨论',
            projectType: 'general_medicine',
            typeKey: 'general_med',
            sizeBytes: 17,
            usage: { inboxBytes: 4, exportsBytes: 13, scratchBytes: 0, totalBytes: 17 },
            trashBytes: 5,
            trashCount: 1,
            sessionCount: 1,
        });
        expect(result.projects[0].files.map((file) => file.path).sort())
            .toEqual(['exports/report.pdf', 'inbox/scan.csv']);
        expect(result.projects[0].files.find((file) => file.path === 'exports/report.pdf').previewKind)
            .toBe('pdf');
    });

    it('只列已知类型的项目；没有 meta 时用目录名兜底，空项目也出现', async () => {
        const pilotHome = await makePilotHome();
        await fs.mkdir(path.join(pilotHome, 'workspaces', 'trauma_med', 'plain'), { recursive: true });
        await fs.mkdir(path.join(pilotHome, 'workspaces', 'not_a_type', 'skipme'), { recursive: true });
        // 旧扁平布局（workspaces/<项目>）不再作为项目出现
        await fs.mkdir(path.join(pilotHome, 'workspaces', 'legacy-flat'), { recursive: true });

        const result = await scanStorage(pilotHome);

        expect(result.projects).toHaveLength(1);
        expect(result.projects[0]).toMatchObject({
            id: 'plain',
            displayName: 'plain',
            projectType: 'war_trauma',
            sessionCount: 0,
            lastActivityAt: null,
            sizeBytes: 0,
        });
        expect(result.totals.projectCount).toBe(1);
    });

    it('archives/projects 里的存量不再计入快照（项目归档已下线）', async () => {
        const pilotHome = await makePilotHome();
        const archive = path.join(pilotHome, 'archives', 'projects', 'general_med-old-20260831T010203Z');
        await fs.mkdir(archive, { recursive: true });
        await fs.writeFile(path.join(archive, 'report.md'), '12345');

        const result = await scanStorage(pilotHome);

        expect(result.projects).toEqual([]);
        expect(result.totals).toEqual({
            totalBytes: 0,
            workspaceBytes: 0,
            trashBytes: 0,
            projectCount: 0,
        });
    });
});

describe('只读预览的路径校验', () => {
    async function setup() {
        const pilotHome = await makePilotHome();
        const workspace = path.join(pilotHome, 'workspaces', 'general_med', 'demo');
        await fs.mkdir(path.join(workspace, 'exports'), { recursive: true });
        await fs.writeFile(path.join(workspace, 'exports', 'report.md'), 'hello');
        await fs.writeFile(path.join(pilotHome, 'secret.txt'), 'nope');
        return { pilotHome, workspace };
    }

    it('允许项目内相对路径', async () => {
        const { pilotHome } = await setup();
        const resolved = await resolvePreviewTarget(pilotHome, {
            typeKey: 'general_med',
            groupId: 'demo',
            path: 'exports/report.md',
        });
        await expect(fs.readFile(resolved.target, 'utf8')).resolves.toBe('hello');
    });

    it('拒绝 ../ 逃逸、未知类型、绝对路径', async () => {
        const { pilotHome } = await setup();
        await expect(resolvePreviewTarget(pilotHome, {
            typeKey: 'general_med',
            groupId: 'demo',
            path: '../../secret.txt',
        })).rejects.toThrow(/outside the managed storage root/);

        await expect(resolvePreviewTarget(pilotHome, {
            typeKey: 'nope',
            groupId: 'demo',
            path: 'exports/report.md',
        })).rejects.toThrow(/Invalid project type/);

        await expect(resolvePreviewTarget(pilotHome, {
            typeKey: 'general_med',
            groupId: 'demo',
            path: '/etc/passwd',
        })).rejects.toThrow(/relative file path/);
    });
});

describe('存储页与工作区页一致的目录清单', () => {
    it('隐藏目录不出现在文件树里：.pilotdeck 既不计入占用，也不列文件', async () => {
        const pilotHome = await makePilotHome();
        const projectId = 'general_med-hidden';
        const workspace = path.join(pilotHome, 'workspaces', 'general_med', projectId);
        await fs.mkdir(path.join(workspace, 'exports'), { recursive: true });
        await fs.writeFile(path.join(workspace, 'exports', 'report.md'), '123456');
        const cache = path.join(workspace, '.pilotdeck', 'tool-results', 'web:s1');
        await fs.mkdir(cache, { recursive: true });
        await fs.writeFile(path.join(cache, 'big.b64'), Buffer.alloc(1024));
        await fs.mkdir(path.join(workspace, '.pilotdeck', 'plans'), { recursive: true });
        await fs.writeFile(path.join(workspace, '.pilotdeck', 'plans', 'p.md'), 'plan');
        await fs.writeFile(path.join(workspace, '.usage.json'), '{}');

        const result = await scanStorage(pilotHome);

        expect(result.projects[0].files.map((file) => file.path)).toEqual(['exports/report.md']);
        expect(result.projects[0].sizeBytes).toBe(6);
        expect(result.totals.workspaceBytes).toBe(6);
        // 目录清单里也没有它
        expect(result.projects[0].folders.map((folder) => folder.name)).toEqual(['inbox', 'exports', 'scratch']);
    });

    it('目录清单与工作区页面一致：三个默认目录常在，自建目录（含空目录）也列出来', async () => {
        const pilotHome = await makePilotHome();
        const projectId = 'general_med-folders';
        const workspace = path.join(pilotHome, 'workspaces', 'general_med', projectId);
        await fs.mkdir(path.join(workspace, 'exports'), { recursive: true });
        await fs.writeFile(path.join(workspace, 'exports', 'a.pdf'), Buffer.alloc(10));
        await fs.mkdir(path.join(workspace, '我的资料', '2026'), { recursive: true });
        await fs.writeFile(path.join(workspace, '我的资料', '2026', 'b.csv'), '1234');
        // scratch 还不存在：也要列出来
        await fs.rm(path.join(workspace, 'scratch'), { recursive: true, force: true });

        const result = await scanStorage(pilotHome);
        const folders = result.projects[0].folders;

        expect(folders.map((folder) => folder.name)).toEqual(['inbox', 'exports', 'scratch', '我的资料']);
        expect(folders.find((folder) => folder.name === 'exports')).toEqual({
            name: 'exports', fileCount: 1, sizeBytes: 10,
        });
        expect(folders.find((folder) => folder.name === '我的资料')).toEqual({
            name: '我的资料', fileCount: 1, sizeBytes: 4,
        });
        expect(folders.find((folder) => folder.name === 'scratch')).toEqual({
            name: 'scratch', fileCount: 0, sizeBytes: 0,
        });
    });

    it('顶层散落文件也给它一行，不会从页面上消失', async () => {
        const pilotHome = await makePilotHome();
        const workspace = path.join(pilotHome, 'workspaces', 'general_med', 'general_med-loose');
        await fs.mkdir(path.join(workspace, 'exports'), { recursive: true });
        await fs.writeFile(path.join(workspace, 'notes.md'), '12345');

        const result = await scanStorage(pilotHome);
        const folders = result.projects[0].folders;

        expect(result.projects[0].files.map((file) => file.path)).toEqual(['notes.md']);
        expect(folders.map((folder) => folder.name)).toEqual(['inbox', 'exports', 'scratch', 'notes.md']);
        expect(folders.find((folder) => folder.name === 'notes.md')).toEqual({
            name: 'notes.md', fileCount: 1, sizeBytes: 5,
        });
    });
});
