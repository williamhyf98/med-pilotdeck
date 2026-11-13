// @vitest-environment node
// 新建目录的路径校验：相对路径、无 ..、无隐藏名/保留项、无软链、不越界。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    assertNoSymlinkOnPath,
    normalizeNewPath,
    normalizeWritePath,
    resolveInsideRoot,
    WORKSPACE_MAX_PATH_SEGMENTS,
} from './workspacePaths.js';

let root;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-wspaths-'));
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

const expectInvalid = (value, code = 'invalid_input') => {
    expect(() => normalizeNewPath(value)).toThrow(expect.objectContaining({ httpStatus: 400, code }));
};

describe('normalizeNewPath', () => {
    it('拆分多级相对路径，忽略空段与 .', () => {
        expect(normalizeNewPath('reports/2026')).toEqual(['reports', '2026']);
        expect(normalizeNewPath('reports//2026/./')).toEqual(['reports', '2026']);
        expect(normalizeNewPath('reports\\2026')).toEqual(['reports', '2026']);
        expect(normalizeNewPath('  单目录  ')).toEqual(['单目录']);
    });

    it('拒绝空值与非字符串', () => {
        expectInvalid(undefined);
        expectInvalid(null);
        expectInvalid(42);
        expectInvalid('   ');
        expectInvalid('/');
    });

    it('拒绝绝对路径与盘符', () => {
        expectInvalid('/etc/passwd');
        expectInvalid('C:\\Windows');
    });

    it('拒绝 ..（任意层级）', () => {
        expectInvalid('..');
        expectInvalid('a/../../etc');
        expectInvalid('a/..');
    });

    it('拒绝任何以 . 开头的段——包括系统保留项', () => {
        expectInvalid('.trash');
        expectInvalid('.tmp/x');
        expectInvalid('.pinned');
        expectInvalid('reports/.hidden');
    });

    it('拒绝非法字符', () => {
        expectInvalid('a:b');
        expectInvalid('a|b');
        expectInvalid('a?b');
        expectInvalid('a\u0000b');
    });

    it('限制层级与单段长度', () => {
        const tooDeep = Array.from({ length: WORKSPACE_MAX_PATH_SEGMENTS + 1 }, (_, i) => `d${i}`).join('/');
        expectInvalid(tooDeep);
        const atLimit = Array.from({ length: WORKSPACE_MAX_PATH_SEGMENTS }, (_, i) => `d${i}`).join('/');
        expect(normalizeNewPath(atLimit)).toHaveLength(WORKSPACE_MAX_PATH_SEGMENTS);
        expectInvalid('x'.repeat(121));
        expect(normalizeNewPath('x'.repeat(120))).toHaveLength(1);
    });
});

describe('normalizeWritePath', () => {
    it('用户本人可以改 inbox（agent 的只读规则在 pathSafety.ts，不在这里）', () => {
        expect(normalizeWritePath('inbox/a.csv')).toEqual(['inbox', 'a.csv']);
        expect(normalizeWritePath('exports/a.csv')).toEqual(['exports', 'a.csv']);
        expect(normalizeWritePath('我的资料/inbox/a.csv')).toEqual(['我的资料', 'inbox', 'a.csv']);
        expect(normalizeWritePath('scratch/work/x.py')).toEqual(['scratch', 'work', 'x.py']);
    });

    it('系统保留项与隐藏名仍旧拒绝', () => {
        expect(() => normalizeWritePath('.trash/a.txt'))
            .toThrow(expect.objectContaining({ code: 'invalid_input', httpStatus: 400 }));
        expect(() => normalizeWritePath('.pinned'))
            .toThrow(expect.objectContaining({ code: 'invalid_input' }));
    });
});

describe('resolveInsideRoot', () => {
    it('拼出工作区内的绝对路径', () => {
        expect(resolveInsideRoot(root, ['reports', '2026']))
            .toBe(path.join(path.resolve(root), 'reports', '2026'));
    });

    it('即使调用方绕过 normalizeNewPath 传入 ..，也拒绝越界', () => {
        expect(() => resolveInsideRoot(root, ['..', 'escape']))
            .toThrow(expect.objectContaining({ code: 'path_out_of_bounds', httpStatus: 400 }));
    });
});

describe('assertNoSymlinkOnPath', () => {
    it('路径上任意一段是软链就拒绝', async () => {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-wspaths-out-'));
        try {
            await fs.symlink(outside, path.join(root, 'link'), 'dir');
            await expect(assertNoSymlinkOnPath(root, path.join(root, 'link', 'deep')))
                .rejects.toMatchObject({ httpStatus: 400 });
        } finally {
            await fs.rm(outside, { recursive: true, force: true });
        }
    });

    it('尾部尚不存在的普通路径放行（新建目录的常态）', async () => {
        await fs.mkdir(path.join(root, 'reports'));
        await expect(assertNoSymlinkOnPath(root, path.join(root, 'reports', '2026')))
            .resolves.toBeUndefined();
    });
});
