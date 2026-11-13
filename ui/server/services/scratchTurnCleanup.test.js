// @vitest-environment node
// 回合结束的 scratch 清理：只删本轮目录与本轮 tool-results，不碰跨回合草稿。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTurnScratch, safeScratchSegment } from './scratchTurnCleanup.js';

let root;
let workspace;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-turn-scratch-'));
    workspace = path.join(root, 'ws');
    await fs.mkdir(path.join(workspace, 'scratch', 'work'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'scratch', 'tool-results'), { recursive: true });
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

async function writeFileAt(relative, content = 'x') {
    const absolute = path.join(workspace, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
    return absolute;
}

const exists = async (relative) => {
    try {
        await fs.lstat(path.join(workspace, relative));
        return true;
    } catch {
        return false;
    }
};

describe('cleanTurnScratch', () => {
    it('删本轮的 work/<session>/<turn>，保留同会话的其他回合', async () => {
        await writeFileAt('scratch/work/web-s_1/turn-a/analysis.py');
        await writeFileAt('scratch/work/web-s_1/turn-a/tables/out.csv', 'aaaa');
        await writeFileAt('scratch/work/web-s_1/turn-b/analysis.py');

        const result = await cleanTurnScratch(workspace, {
            sessionId: 'web:s_1',
            turnId: 'turn-a',
        });

        expect(await exists('scratch/work/web-s_1/turn-a')).toBe(false);
        expect(await exists('scratch/work/web-s_1/turn-b/analysis.py')).toBe(true);
        expect(result.removedDirs).toEqual(['scratch/work/web-s_1/turn-a']);
        expect(result.freedBytes).toBeGreaterThan(0);
    });

    it('不碰 qa / docx / data / tmp 这些跨回合草稿', async () => {
        await writeFileAt('scratch/qa/spec.md');
        await writeFileAt('scratch/docx/xiaohua_spec.json');
        await writeFileAt('scratch/data/cleaned.csv');
        await writeFileAt('scratch/tmp/t.bin');
        await writeFileAt('scratch/work/web-s_1/turn-a/a.py');

        await cleanTurnScratch(workspace, { sessionId: 'web:s_1', turnId: 'turn-a' });

        for (const relative of [
            'scratch/qa/spec.md',
            'scratch/docx/xiaohua_spec.json',
            'scratch/data/cleaned.csv',
            'scratch/tmp/t.bin',
        ]) {
            expect(await exists(relative), relative).toBe(true);
        }
    });

    it('删本轮的 tool-results 落盘文件，保留其他回合的', async () => {
        await writeFileAt('scratch/tool-results/turn-a-call_1-text-0-abc.txt', 'big');
        await writeFileAt('scratch/tool-results/turn-b-call_1-text-0-def.txt', 'big');

        const result = await cleanTurnScratch(workspace, {
            sessionId: 'web:s_1',
            turnId: 'turn-a',
        });

        expect(await exists('scratch/tool-results/turn-a-call_1-text-0-abc.txt')).toBe(false);
        expect(await exists('scratch/tool-results/turn-b-call_1-text-0-def.txt')).toBe(true);
        expect(result.removedFiles).toEqual(['scratch/tool-results/turn-a-call_1-text-0-abc.txt']);
    });

    it('删完后收掉空的会话目录', async () => {
        await writeFileAt('scratch/work/web-s_1/turn-a/a.py');
        await cleanTurnScratch(workspace, { sessionId: 'web:s_1', turnId: 'turn-a' });
        expect(await exists('scratch/work/web-s_1')).toBe(false);
    });

    it('会话目录里还有别的回合时，会话目录保留', async () => {
        await writeFileAt('scratch/work/web-s_1/turn-a/a.py');
        await writeFileAt('scratch/work/web-s_1/turn-b/b.py');
        await cleanTurnScratch(workspace, { sessionId: 'web:s_1', turnId: 'turn-a' });
        expect(await exists('scratch/work/web-s_1')).toBe(true);
    });

    it('符号链接不跟随、不删除指向的目标', async () => {
        const outside = path.join(root, 'outside');
        await fs.mkdir(outside, { recursive: true });
        await fs.writeFile(path.join(outside, 'precious.txt'), 'keep me');
        await fs.mkdir(path.join(workspace, 'scratch', 'work', 'web-s_1'), { recursive: true });
        await fs.symlink(outside, path.join(workspace, 'scratch', 'work', 'web-s_1', 'turn-a'));

        await cleanTurnScratch(workspace, { sessionId: 'web:s_1', turnId: 'turn-a' });

        expect(await fs.readFile(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    });

    it('没有 scratch 目录 / 缺少 turnId 时安静返回', async () => {
        const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-bare-'));
        try {
            await expect(cleanTurnScratch(bare, { turnId: 'turn-a' })).resolves.toEqual({
                removedDirs: [],
                removedFiles: [],
                freedBytes: 0,
            });
            await expect(cleanTurnScratch(workspace, {})).resolves.toEqual({
                removedDirs: [],
                removedFiles: [],
                freedBytes: 0,
            });
        } finally {
            await fs.rm(bare, { recursive: true, force: true });
        }
    });
});

describe('safeScratchSegment', () => {
    it('与 buildTurnEnvironment 的目录命名保持一致', () => {
        expect(safeScratchSegment('web:s_abc-123')).toBe('web-s_abc-123');
        expect(safeScratchSegment('   ')).toBe('unknown');
        expect(safeScratchSegment('...')).toBe('unknown');
        expect(safeScratchSegment('a/b')).toBe('a-b');
    });
});
