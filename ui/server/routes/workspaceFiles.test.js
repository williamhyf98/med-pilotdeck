// @vitest-environment node
// 第二批工作区路由的 HTTP 级验收：express + 临时工作区 + 真实 fetch。
// 校验规则本身在 utils/workspacePaths.test.js 里单测；这里断言的是
// "状态码 + 磁盘副作用"——两者都通过才算这条路由真的能用。
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceFilesRouter } from './workspaceFiles.js';
import { moveFileToTrash } from '../services/trash.js';

let root;
let workspace;
let systemHome;
let previousSystemHome;
let server;
let base;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-wsfiles-'));
    workspace = path.join(root, 'workspaces', 'general_med-example');
    for (const dir of ['inbox', 'exports', 'scratch/work']) {
        await fs.mkdir(path.join(workspace, dir), { recursive: true });
    }
    systemHome = path.join(root, 'system-home');
    previousSystemHome = process.env.PILOTDECK_SYSTEM_HOME;
    process.env.PILOTDECK_SYSTEM_HOME = systemHome;

    const app = express();
    app.use(express.json());
    app.use('/api/projects', (req, _res, next) => {
        req.user = { username: 'tester' };
        next();
    }, createWorkspaceFilesRouter({
        extractProjectDirectory: async (projectName) => {
            if (projectName !== 'demo') {
                const error = new Error('Project not found');
                error.code = 'ENOENT';
                throw error;
            }
            return workspace;
        },
    }));

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (previousSystemHome === undefined) delete process.env.PILOTDECK_SYSTEM_HOME;
    else process.env.PILOTDECK_SYSTEM_HOME = previousSystemHome;
    await fs.rm(root, { recursive: true, force: true });
});

async function call(method, route, body) {
    const response = await fetch(`${base}/api/projects/demo${route}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, payload };
}

const exists = async (target) => {
    try {
        await fs.lstat(target);
        return true;
    } catch {
        return false;
    }
};

describe('POST /files/mkdir', () => {
    it('建出多级目录并返回相对路径', async () => {
        await fs.mkdir(path.join(workspace, '我的资料', '2026'), { recursive: true });
        const { status, payload } = await call('POST', '/files/mkdir', { path: '我的资料/2026/随访' });

        expect(status).toBe(201);
        expect(payload.path).toBe('我的资料/2026/随访');
        expect(await exists(path.join(workspace, '我的资料', '2026', '随访'))).toBe(true);
    });

    it.each([
        ['绝对路径', '/etc/passwd'],
        ['盘符', 'C:\\Windows'],
        ['上跳', 'a/../../etc'],
        ['隐藏名', '.hidden'],
        ['系统保留项', '.trash'],
        ['非法字符', 'a:b'],
    ])('拒绝%s → 400 invalid_input', async (_label, value) => {
        const { status, payload } = await call('POST', '/files/mkdir', { path: value });
        expect(status).toBe(400);
        expect(payload.code).toBe('invalid_input');
    });

    it('同名已存在 → 409 target_exists', async () => {
        const { status, payload } = await call('POST', '/files/mkdir', { path: 'exports' });
        expect(status).toBe(409);
        expect(payload.code).toBe('target_exists');
    });

    it('上级目录不存在 → 404 parent_missing', async () => {
        const { status, payload } = await call('POST', '/files/mkdir', { path: 'nope/child' });
        expect(status).toBe(404);
        expect(payload.code).toBe('parent_missing');
    });

    it('路径穿过软链 → 400，且不会在工作区外建目录', async () => {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-wsfiles-out-'));
        try {
            await fs.symlink(outside, path.join(workspace, 'link'), 'dir');
            const { status } = await call('POST', '/files/mkdir', { path: 'link/evil' });
            expect(status).toBe(400);
            expect(await exists(path.join(outside, 'evil'))).toBe(false);
        } finally {
            await fs.rm(outside, { recursive: true, force: true });
        }
    });
});

describe('回收站路由', () => {
    it('空回收站返回空列表与 7 天保留口径', async () => {
        const { status, payload } = await call('GET', '/trash');
        expect(status).toBe(200);
        expect(payload).toMatchObject({
            entries: [],
            totals: { count: 0, bytes: 0 },
            retentionDays: 7,
        });
    });

    it('列出条目 → 恢复回到原路径', async () => {
        await fs.writeFile(path.join(workspace, 'exports', 'report.md'), '# hi');
        await moveFileToTrash(workspace, 'exports/report.md');

        const listed = await call('GET', '/trash');
        expect(listed.payload.totals.count).toBe(1);
        const entryPath = listed.payload.entries[0].path;

        const restored = await call('POST', '/trash/restore', { path: entryPath });
        expect(restored.status).toBe(200);
        expect(await exists(path.join(workspace, 'exports', 'report.md'))).toBe(true);
    });

    it('恢复不存在的条目 → 404 trash_not_found', async () => {
        const { status, payload } = await call('POST', '/trash/restore', {
            path: '.trash/exports/ghost.md.20260101T000000000Z',
        });
        expect(status).toBe(404);
        expect(payload.code).toBe('trash_not_found');
    });

    it('原路径被占用时恢复 → 409 target_exists，不覆盖现有文件', async () => {
        await fs.writeFile(path.join(workspace, 'exports', 'report.md'), 'old');
        await moveFileToTrash(workspace, 'exports/report.md');
        await fs.writeFile(path.join(workspace, 'exports', 'report.md'), 'new');

        const listed = await call('GET', '/trash');
        const { status, payload } = await call('POST', '/trash/restore', {
            path: listed.payload.entries[0].path,
        });

        expect(status).toBe(409);
        expect(payload.code).toBe('target_exists');
        expect(await fs.readFile(path.join(workspace, 'exports', 'report.md'), 'utf8')).toBe('new');
    });

    it('清空缺 confirm → 400，且删不掉任何东西', async () => {
        await fs.writeFile(path.join(workspace, 'exports', 'report.md'), 'x');
        await moveFileToTrash(workspace, 'exports/report.md');

        const { status, payload } = await call('POST', '/trash/empty', {});
        expect(status).toBe(400);
        expect(payload.code).toBe('confirm_required');
        expect((await call('GET', '/trash')).payload.totals.count).toBe(1);
    });

    it('confirm:true 才真清空', async () => {
        await fs.writeFile(path.join(workspace, 'exports', 'report.md'), 'x');
        await moveFileToTrash(workspace, 'exports/report.md');

        const { status, payload } = await call('POST', '/trash/empty', { confirm: true });
        expect(status).toBe(200);
        expect(payload.purged).toBe(1);
        expect((await call('GET', '/trash')).payload.totals.count).toBe(0);
    });
});

describe('POST /files/move（拖拽移动）', () => {
    it('把文件移进另一个目录', async () => {
        await fs.mkdir(path.join(workspace, '我的资料'));
        await fs.mkdir(path.join(workspace, 'exports'), { recursive: true });
        await fs.writeFile(path.join(workspace, 'exports', 'a.docx'), 'x');

        const { status, payload } = await call('POST', '/files/move', {
            from: 'exports/a.docx',
            toDir: '我的资料',
        });

        expect(status).toBe(200);
        expect(payload.to).toBe('我的资料/a.docx');
        expect(await exists(path.join(workspace, '我的资料', 'a.docx'))).toBe(true);
        expect(await exists(path.join(workspace, 'exports', 'a.docx'))).toBe(false);
    });

    it('可以移到工作区根目录（toDir 为空串）', async () => {
        await fs.mkdir(path.join(workspace, '我的资料'));
        await fs.writeFile(path.join(workspace, '我的资料', 'b.txt'), 'y');

        const { status, payload } = await call('POST', '/files/move', {
            from: '我的资料/b.txt',
            toDir: '',
        });

        expect(status).toBe(200);
        expect(payload.to).toBe('b.txt');
        expect(await exists(path.join(workspace, 'b.txt'))).toBe(true);
    });

    it('拒绝移动 exports / inbox / scratch 本身；允许把东西移进 scratch', async () => {
        const pinned = await call('POST', '/files/move', { from: 'exports', toDir: '' });
        expect(pinned.status).toBe(400);
        expect(pinned.payload.code).toBe('pinned_root');

        await fs.writeFile(path.join(workspace, 'a.txt'), 'z');
        const intoScratch = await call('POST', '/files/move', { from: 'a.txt', toDir: 'scratch' });
        expect(intoScratch.status).toBe(200);
        expect(intoScratch.payload.to).toBe('scratch/a.txt');
        expect(await exists(path.join(workspace, 'scratch', 'a.txt'))).toBe(true);
    });

    it('同名冲突 409、移进自己 400', async () => {
        await fs.mkdir(path.join(workspace, '我的资料', 'sub'), { recursive: true });
        await fs.writeFile(path.join(workspace, 'a.txt'), 'z');
        await fs.writeFile(path.join(workspace, '我的资料', 'a.txt'), 'z');

        const conflict = await call('POST', '/files/move', { from: 'a.txt', toDir: '我的资料' });
        expect(conflict.status).toBe(409);

        const intoSelf = await call('POST', '/files/move', { from: '我的资料', toDir: '我的资料/sub' });
        expect(intoSelf.status).toBe(400);
        expect(intoSelf.payload.code).toBe('move_into_self');
    });
});

describe('POST /files/trash（拖到回收站）', () => {
    it('软删除进 .trash，可从回收站列表看到', async () => {
        await fs.mkdir(path.join(workspace, 'exports'), { recursive: true });
        await fs.writeFile(path.join(workspace, 'exports', 'a.docx'), 'x');

        const { status, payload } = await call('POST', '/files/trash', { path: 'exports/a.docx' });

        expect(status).toBe(200);
        expect(payload.trashedPath).toMatch(/^\.trash\/exports\/a\.docx\./);
        expect(await exists(path.join(workspace, 'exports', 'a.docx'))).toBe(false);

        const list = await call('GET', '/trash');
        expect(list.payload.entries.some((entry) => entry.originalPath === 'exports/a.docx')).toBe(true);
    });

    it('拒绝把 exports 整体移入回收站', async () => {
        const { status, payload } = await call('POST', '/files/trash', { path: 'exports' });
        expect(status).toBe(400);
        expect(payload.code).toBe('pinned_root');
        expect(await exists(path.join(workspace, 'exports'))).toBe(true);
    });
});

describe('POST /workspace/scratch/clean', () => {
    it('空 scratch 返回 0，不动其它目录', async () => {
        await fs.writeFile(path.join(workspace, 'inbox', 'upload.csv'), 'a,b');
        const { status, payload } = await call('POST', '/workspace/scratch/clean', {});
        expect(status).toBe(200);
        expect(payload.removed).toBe(0);
        expect(await exists(path.join(workspace, 'inbox', 'upload.csv'))).toBe(true);
    });

    it('force 必须带 confirm，否则 400 且不删东西', async () => {
        const turn = path.join(workspace, 'scratch', 'work', 'turn-a');
        await fs.mkdir(turn, { recursive: true });
        await fs.writeFile(path.join(turn, 'a.py'), 'print(1)');

        const { status, payload } = await call('POST', '/workspace/scratch/clean', { force: true });

        expect(status).toBe(400);
        expect(payload.code).toBe('confirm_required');
        expect(await exists(path.join(turn, 'a.py'))).toBe(true);
    });

    it('force + confirm 删掉未过期、未超限的中间产物', async () => {
        const turn = path.join(workspace, 'scratch', 'work', 'turn-a');
        await fs.mkdir(turn, { recursive: true });
        await fs.writeFile(path.join(turn, 'a.py'), 'print(1)');
        const old = new Date(Date.now() - 3_600_000);
        await fs.utimes(path.join(turn, 'a.py'), old, old);
        await fs.utimes(turn, old, old);
        const exported = path.join(workspace, 'exports', 'report.md');
        await fs.writeFile(exported, 'md');

        const { status, payload } = await call('POST', '/workspace/scratch/clean', { force: true, confirm: true });

        expect(status).toBe(200);
        expect(payload.removed).toBe(1);
        expect(await exists(turn)).toBe(false);
        expect(await exists(exported)).toBe(true);
    });
});

describe('未知项目', () => {
    it('提取工作区失败 → 500（路由把异常交回，不误报 200）', async () => {
        const response = await fetch(`${base}/api/projects/ghost/trash`);
        expect(response.status).toBe(500);
    });
});
