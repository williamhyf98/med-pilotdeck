// @vitest-environment node
// scratch 自动清理（设计书 §8）：只清 scratch/、按单元删、保护窗与 .pinned 免删。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanScratch, listScratchUnits, SCRATCH_CATEGORIES } from './scratchRetention.js';

const DAY_MS = 86_400_000;

let root;
let workspace;
let systemHome;
let previousSystemHome;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-scratch-'));
    workspace = path.join(root, 'workspaces', 'general_med-example');
    for (const category of SCRATCH_CATEGORIES) {
        await fs.mkdir(path.join(workspace, 'scratch', category), { recursive: true });
    }
    for (const dir of ['inbox', 'exports']) {
        await fs.mkdir(path.join(workspace, dir), { recursive: true });
    }
    systemHome = path.join(root, 'system-home');
    previousSystemHome = process.env.PILOTDECK_SYSTEM_HOME;
    process.env.PILOTDECK_SYSTEM_HOME = systemHome;
});

afterEach(async () => {
    if (previousSystemHome === undefined) delete process.env.PILOTDECK_SYSTEM_HOME;
    else process.env.PILOTDECK_SYSTEM_HOME = previousSystemHome;
    await fs.rm(root, { recursive: true, force: true });
});

/** 在 scratch 下造一个单元（文件或目录），并把 mtime 拨到 `ageDays` 天前。 */
async function makeUnit(relativeDir, name, { bytes = 10, ageDays = 0, directory = false } = {}) {
    const target = path.join(workspace, 'scratch', relativeDir, name);
    const when = new Date(Date.now() - ageDays * DAY_MS);
    if (directory) {
        // 目录单元：里面放两个文件，验证递归计量，且只删这一个 turn。
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, 'a.bin'), Buffer.alloc(Math.ceil(bytes / 2)));
        await fs.writeFile(path.join(target, 'b.txt'), Buffer.alloc(Math.floor(bytes / 2)));
        await fs.utimes(path.join(target, 'a.bin'), when, when);
        await fs.utimes(path.join(target, 'b.txt'), when, when);
    } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, Buffer.alloc(bytes));
        await fs.utimes(target, when, when);
    }
    await fs.utimes(target, when, when);
    return target;
}

async function exists(target) {
    try {
        await fs.lstat(target);
        return true;
    } catch {
        return false;
    }
}

async function readAudit() {
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

const clean = (overrides = {}) => cleanScratch(workspace, {
    scratchMaxBytes: 1024,
    scratchSoftRatio: 0.8,
    scratchTtlDays: 30,
    protectRecentMinutes: 0,
    ...overrides,
});

describe('listScratchUnits', () => {
    it('只列出 scratch/ 下的单元，递归计量目录大小', async () => {
        await makeUnit('tool-results', 'turn-a', { bytes: 40, directory: true });
        await makeUnit('work', 'single.txt', { bytes: 7 });
        await fs.writeFile(path.join(workspace, 'inbox', 'upload.csv'), 'xx');

        const units = await listScratchUnits(workspace);
        expect(units.map((unit) => unit.relativePath).sort()).toEqual([
            'scratch/tool-results/turn-a',
            'scratch/work/single.txt',
        ]);
        const dirUnit = units.find((unit) => unit.relativePath === 'scratch/tool-results/turn-a');
        expect(dirUnit.isDirectory).toBe(true);
        expect(dirUnit.bytes).toBe(40);
        expect(dirUnit.category).toBe(0);
    });

    it('也收 data/docx/tmp/qc 与 scratch 根下散落项，隐藏项除外', async () => {
        await makeUnit('data', 'dedup.csv', { bytes: 12 });
        await makeUnit('docx', 'spec.json', { bytes: 5 });
        await makeUnit('', '_t1.txt', { bytes: 1 });
        await fs.writeFile(path.join(workspace, 'scratch', '.analysis-root.json'), '{}');

        const paths = (await listScratchUnits(workspace)).map((unit) => unit.relativePath).sort();

        expect(paths).toEqual([
            'scratch/_t1.txt',
            'scratch/data/dedup.csv',
            'scratch/docx/spec.json',
        ]);
    });

    it('work/<session>/<turn> 按回合拆成独立单元', async () => {
        await makeUnit('work', 'web-s_1/turn-a/a.txt', { bytes: 4 });
        await makeUnit('work', 'web-s_1/turn-b/b.txt', { bytes: 6 });
        await makeUnit('work', 'flat-skill/analysis.py', { bytes: 8 });

        const paths = (await listScratchUnits(workspace)).map((unit) => unit.relativePath).sort();

        expect(paths).toEqual([
            'scratch/work/flat-skill',
            'scratch/work/web-s_1/turn-a',
            'scratch/work/web-s_1/turn-b',
        ]);
    });

    it('以后新出现的目录无需登记也会被收进来（根下任意名 + 已知目录下的子目录）', async () => {
        await makeUnit('some-new-skill-2027', 'x.bin', { bytes: 9 });
        await makeUnit('preview', 'new-render/nested/y.png', { bytes: 11 });

        const paths = (await listScratchUnits(workspace)).map((unit) => unit.relativePath).sort();

        expect(paths).toEqual([
            'scratch/preview/new-render',
            'scratch/some-new-skill-2027',
        ]);
    });
});

describe('cleanScratch', () => {
    it('只清 scratch，inbox / exports 原封不动', async () => {
        const stale = await makeUnit('work', 'turn-old', { bytes: 32, ageDays: 45 });
        const inbox = path.join(workspace, 'inbox', 'upload.csv');
        const exported = path.join(workspace, 'exports', 'report.md');
        await fs.writeFile(inbox, 'csv');
        await fs.writeFile(exported, 'md');
        const old = new Date(Date.now() - 45 * DAY_MS);
        await fs.utimes(inbox, old, old);
        await fs.utimes(exported, old, old);

        const result = await clean({ audit: false });

        expect(await exists(stale)).toBe(false);
        expect(await exists(inbox)).toBe(true);
        expect(await exists(exported)).toBe(true);
        expect(result.removed).toBe(1);
        expect(result.freedBytes).toBe(32);
    });

    it('超过 TTL 的单元被整体删掉；刚用过的留在保护窗内', async () => {
        const expired = await makeUnit('work', 'turn-expired', { bytes: 24, ageDays: 40 });
        const fresh = await makeUnit('work', 'turn-fresh', { bytes: 24, ageDays: 0 });

        const result = await clean({ audit: false, protectRecentMinutes: 10 });

        expect(await exists(expired)).toBe(false);
        expect(await exists(fresh)).toBe(true);
        expect(result.removed).toBe(1);
    });

    it('超上限时按 tool-results → preview → work → qa 清到软阈值以下', async () => {
        const toolResult = await makeUnit('tool-results', 'r1', { bytes: 400, ageDays: 1 });
        const preview = await makeUnit('preview', 'p1', { bytes: 300, ageDays: 1 });
        const work = await makeUnit('work', 'w1', { bytes: 200, ageDays: 1 });
        const qa = await makeUnit('qa', 'q1', { bytes: 100, ageDays: 1 });

        // 总量 1000 > 600；软阈值 = 600 * 0.5 = 300。
        const result = await clean({
            audit: false,
            scratchMaxBytes: 600,
            scratchSoftRatio: 0.5,
        });

        expect(await exists(toolResult)).toBe(false);
        expect(await exists(preview)).toBe(false);
        expect(await exists(work)).toBe(true);
        expect(await exists(qa)).toBe(true);
        expect(result.usedBefore).toBe(1000);
        expect(result.usedAfter).toBe(300);
        expect(result.removed).toBe(2);
    });

    it('未超上限时不做任何删除', async () => {
        const file = await makeUnit('work', 'w1', { bytes: 100, ageDays: 1 });
        const result = await clean({ audit: false, scratchMaxBytes: 1024 });
        expect(await exists(file)).toBe(true);
        expect(result.removed).toBe(0);
    });

    it('.pinned（JSON 数组）登记的单元不删，其余照常清理', async () => {
        const pinned = await makeUnit('work', 'keep-me', { bytes: 20, ageDays: 40 });
        const other = await makeUnit('tool-results', 'drop-me', { bytes: 20, ageDays: 40 });
        await fs.writeFile(path.join(workspace, '.pinned'), JSON.stringify(['scratch/work/keep-me']));

        const result = await clean({ audit: false });

        expect(await exists(pinned)).toBe(true);
        expect(await exists(other)).toBe(false);
        expect(result.removed).toBe(1);
    });

    it('.pinned（逐行格式 + 注释）同样生效，且按前缀保护子目录', async () => {
        const pinnedChild = await makeUnit('work', 'turn-keep/part.txt', { bytes: 12, ageDays: 40 });
        const other = await makeUnit('work', 'turn-drop', { bytes: 12, ageDays: 40 });
        await fs.writeFile(path.join(workspace, '.pinned'), [
            '# 用户钉住的产物',
            'scratch/work/turn-keep',
            '',
        ].join('\n'));

        await clean({ audit: false });

        expect(await exists(pinnedChild)).toBe(true);
        expect(await exists(other)).toBe(false);
    });

    it('每次删除都写 scratch.clean 审计，带 target 与 category', async () => {
        await makeUnit('tool-results', 'r1', { bytes: 15, ageDays: 40 });
        await clean();

        const events = (await readAudit()).filter((event) => event.action === 'scratch.clean');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            decision: 'allow',
            tool: 'scratch.retention',
            target: 'scratch/tool-results/r1',
            reason: 'expired',
            meta: { bytes: 15, category: 'tool-results' },
        });
    });
});

describe('cleanScratch({ force: true })：立即清理', () => {
    it('不看 TTL、不看容量，未过期的也删；data/docx/根下散文件一并清', async () => {
        const work = await makeUnit('work', 'w1', { bytes: 100, ageDays: 1 });
        const data = await makeUnit('data', 'dedup.csv', { bytes: 50, ageDays: 1 });
        const docx = await makeUnit('docx', 'spec.json', { bytes: 20, ageDays: 1 });
        const loose = await makeUnit('', '_t1.txt', { bytes: 4, ageDays: 1 });

        // 容量上限给得足够大、TTL 给得足够长：自动模式一条都不会删。
        const result = await clean({
            audit: false,
            force: true,
            scratchMaxBytes: 10 * 1024 * 1024,
            scratchTtlDays: 365,
        });

        expect(await exists(work)).toBe(false);
        expect(await exists(data)).toBe(false);
        expect(await exists(docx)).toBe(false);
        expect(await exists(loose)).toBe(false);
        expect(result.removed).toBe(4);
        expect(result.freedBytes).toBe(174);
    });

    it('仍然保护 .pinned 与 1 分钟内写入的单元', async () => {
        const pinned = await makeUnit('work', 'keep-me', { bytes: 10, ageDays: 2 });
        const justWritten = await makeUnit('work', 'running-turn', { bytes: 10, ageDays: 0 });
        const old = await makeUnit('work', 'old-turn', { bytes: 10, ageDays: 2 });
        await fs.writeFile(path.join(workspace, '.pinned'), ['scratch/work/keep-me'].join('\n'));

        const result = await clean({ audit: false, force: true });

        expect(await exists(pinned)).toBe(true);
        expect(await exists(justWritten)).toBe(true);
        expect(await exists(old)).toBe(false);
        expect(result.removed).toBe(1);
        expect(result.skipped).toBe(2);
    });

    it('按回合删：只清旧回合，同会话里新回合保留', async () => {
        const oldTurn = await makeUnit('work', 'web-s_1/old-turn/a.txt', { bytes: 8, ageDays: 3 });
        const newTurn = await makeUnit('work', 'web-s_1/new-turn/b.txt', { bytes: 8, ageDays: 0 });

        const result = await clean({ audit: false, force: true });

        expect(await exists(oldTurn)).toBe(false);
        expect(await exists(newTurn)).toBe(true);
        expect(await exists(path.join(workspace, 'scratch', 'work', 'web-s_1'))).toBe(true);
        expect(result.removed).toBe(1);
    });

    it('会话目录删空后顺手回收，父目录 scratch/work 保留', async () => {
        await makeUnit('work', 'web-s_1/turn-a/a.txt', { bytes: 8, ageDays: 3 });
        await makeUnit('work', 'web-s_1/turn-b/b.txt', { bytes: 8, ageDays: 3 });

        await clean({ audit: false, force: true });

        expect(await exists(path.join(workspace, 'scratch', 'work', 'web-s_1'))).toBe(false);
        expect(await exists(path.join(workspace, 'scratch', 'work'))).toBe(true);
    });

    it('审计里记录 reason=manual', async () => {
        await makeUnit('work', 'w1', { bytes: 3, ageDays: 1 });
        await clean({ force: true });
        const events = (await readAudit()).filter((event) => event.action === 'scratch.clean');
        expect(events[0]).toMatchObject({ reason: 'manual', target: 'scratch/work/w1' });
    });

    it('未登记的新目录同样会被强制删除', async () => {
        const fresh = await makeUnit('brand-new-dir', 'x.bin', { bytes: 12, ageDays: 2 });

        const result = await clean({ audit: false, force: true });

        expect(await exists(fresh)).toBe(false);
        expect(result.removed).toBe(1);
    });
});
