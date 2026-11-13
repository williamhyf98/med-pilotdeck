// @vitest-environment node
// 会话级工具结果缓存（<workspace>/.pilotdeck/tool-results）的保留策略。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runToolResultsRetention } from './toolResultsRetention.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

let root;
let home;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-tool-results-'));
    home = path.join(root, 'users', '1');
    await fs.mkdir(path.join(home, 'projects', 'general_med-example', 'chats'), { recursive: true });
    await fs.mkdir(path.join(home, 'workspaces', 'general_med', 'general_med-abc'), { recursive: true });
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

async function writeTranscript(sessionId) {
    const file = path.join(home, 'projects', 'general_med-example', 'chats', `${sessionId}.jsonl`);
    await fs.writeFile(file, '{}\n');
}

/** 造一个会话缓存目录，返回其路径；`ageDays` 会同时拨目录和文件的 mtime。 */
async function makeSessionDir(workspaceRel, sessionId, { ageDays = 0, bytes = 64 } = {}) {
    const dir = path.join(home, workspaceRel, '.pilotdeck', 'tool-results', sessionId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'call-1-image-0.png.b64');
    await fs.writeFile(file, Buffer.alloc(bytes));
    const when = new Date(Date.now() - ageDays * DAY_MS);
    await fs.utimes(file, when, when);
    await fs.utimes(dir, when, when);
    return dir;
}

const WORKSPACE = path.join('workspaces', 'general_med', 'general_med-abc');

describe('runToolResultsRetention', () => {
    it('会话还活着且没过期 → 保留', async () => {
        await writeTranscript('web:s_alive');
        const unit = await makeSessionDir(WORKSPACE, 'web:s_alive', { ageDays: 1 });

        const results = await runToolResultsRetention({ homes: [home] });

        expect(await exists(unit)).toBe(true);
        expect(results.reduce((sum, item) => sum + item.removed, 0)).toBe(0);
    });

    it('transcript 已不存在 → 删掉孤儿目录', async () => {
        const orphan = await makeSessionDir(WORKSPACE, 'web:s_orphan', { ageDays: 0 });

        const results = await runToolResultsRetention({ homes: [home], now: new Date(Date.now() + HOUR_MS * 2) });

        expect(await exists(orphan)).toBe(false);
        expect(results.reduce((sum, item) => sum + item.removed, 0)).toBe(1);
        expect(results.reduce((sum, item) => sum + item.freedBytes, 0)).toBeGreaterThan(0);
    });

    it('刚建好的目录（宽限期内）即便还没 transcript 也不动', async () => {
        const fresh = await makeSessionDir(WORKSPACE, 'web:s_fresh', { ageDays: 0 });

        await runToolResultsRetention({ homes: [home] });

        expect(await exists(fresh)).toBe(true);
    });

    it('超过 TTL 的存量会话目录被清掉（默认 14 天）', async () => {
        await writeTranscript('web:s_old');
        const old = await makeSessionDir(WORKSPACE, 'web:s_old', { ageDays: 15 });
        await writeTranscript('web:s_recent');
        const recent = await makeSessionDir(WORKSPACE, 'web:s_recent', { ageDays: 13 });

        await runToolResultsRetention({ homes: [home] });

        expect(await exists(old)).toBe(false);
        expect(await exists(recent)).toBe(true);
    });

    it('retentionDays 可覆盖默认值', async () => {
        await writeTranscript('web:s_mid');
        const mid = await makeSessionDir(WORKSPACE, 'web:s_mid', { ageDays: 3 });

        await runToolResultsRetention({ homes: [home], retentionDays: 2 });

        expect(await exists(mid)).toBe(false);
    });

    it('refs 不看 transcript，只按 TTL 过期', async () => {
        const refs = path.join(home, WORKSPACE, '.pilotdeck', 'tool-results', 'refs');
        await fs.mkdir(refs, { recursive: true });
        const alias = path.join(refs, 'result-0001.txt');
        await fs.writeFile(alias, 'x');
        await fs.utimes(alias, new Date(Date.now() - 20 * DAY_MS), new Date(Date.now() - 20 * DAY_MS));
        await fs.utimes(refs, new Date(Date.now() - 20 * DAY_MS), new Date(Date.now() - 20 * DAY_MS));

        await runToolResultsRetention({ homes: [home] });

        expect(await exists(refs)).toBe(false);
    });

    it('删空之后把空的 tool-results 与 .pilotdeck 一并收掉，但不动非空的 .pilotdeck', async () => {
        await makeSessionDir(WORKSPACE, 'web:s_orphan', { ageDays: 1 });
        await runToolResultsRetention({ homes: [home], now: new Date(Date.now() + HOUR_MS * 2) });
        expect(await exists(path.join(home, WORKSPACE, '.pilotdeck'))).toBe(false);

        // 带 skills 的 .pilotdeck 必须保留
        const skills = path.join(home, WORKSPACE, '.pilotdeck', 'skills', 'demo.md');
        await fs.mkdir(path.dirname(skills), { recursive: true });
        await fs.writeFile(skills, '# demo');
        await makeSessionDir(WORKSPACE, 'web:s_orphan2', { ageDays: 1 });
        await runToolResultsRetention({ homes: [home], now: new Date(Date.now() + HOUR_MS * 2) });
        expect(await exists(skills)).toBe(true);
    });

    it('用户主目录级的 .pilotdeck/tool-results 也会被扫到', async () => {
        const homeLevel = path.join(home, '.pilotdeck', 'tool-results', 'web:s_legacy');
        await fs.mkdir(homeLevel, { recursive: true });
        await fs.writeFile(path.join(homeLevel, 'a.json'), '{}');

        await runToolResultsRetention({ homes: [home], now: new Date(Date.now() + HOUR_MS * 2) });

        expect(await exists(homeLevel)).toBe(false);
        expect(await exists(path.join(home, '.pilotdeck'))).toBe(false);
    });

    it('目录不存在时不报错', async () => {
        const results = await runToolResultsRetention({ homes: [path.join(root, 'nobody')] });
        expect(results).toEqual([]);
    });

    it('plans/ 同样按 14 天 TTL：整目录很久没动就清掉，新鲜的原样保留', async () => {
        const deck = path.join(home, WORKSPACE, '.pilotdeck');
        const oldPlans = path.join(deck, 'plans');
        const freshPlans = path.join(home, 'workspaces', 'general_med', 'general_med-fresh', '.pilotdeck', 'plans');
        for (const dir of [oldPlans, freshPlans]) {
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path.join(dir, 'p.md'), '# plan');
        }
        const old = new Date(Date.now() - 20 * DAY_MS);
        await fs.utimes(path.join(oldPlans, 'p.md'), old, old);
        await fs.utimes(oldPlans, old, old);

        await runToolResultsRetention({ homes: [home] });

        expect(await exists(oldPlans)).toBe(false);
        expect(await exists(path.join(freshPlans, 'p.md'))).toBe(true);
    });

    it('.pilotdeck 下任何自定义子项过期都清（不只 tool-results / plans）', async () => {
        const scratchish = path.join(home, WORKSPACE, '.pilotdeck', 'tmp-notes', 'a.txt');
        await fs.mkdir(path.dirname(scratchish), { recursive: true });
        await fs.writeFile(scratchish, 'x');
        const old = new Date(Date.now() - 20 * DAY_MS);
        await fs.utimes(scratchish, old, old);
        await fs.utimes(path.dirname(scratchish), old, old);

        await runToolResultsRetention({ homes: [home] });

        expect(await exists(path.join(home, WORKSPACE, '.pilotdeck', 'tmp-notes'))).toBe(false);
    });

    it('人工配置（skills/commands/mcp.json）即使很旧也不删', async () => {
        const deck = path.join(home, WORKSPACE, '.pilotdeck');
        const skill = path.join(deck, 'skills', 'demo', 'SKILL.md');
        await fs.mkdir(path.dirname(skill), { recursive: true });
        await fs.writeFile(skill, '# demo');
        const mcp = path.join(deck, 'mcp.json');
        await fs.writeFile(mcp, '{}');
        const old = new Date(Date.now() - 60 * DAY_MS);
        await fs.utimes(skill, old, old);
        await fs.utimes(path.dirname(skill), old, old);
        await fs.utimes(mcp, old, old);

        await runToolResultsRetention({ homes: [home] });

        expect(await exists(skill)).toBe(true);
        expect(await exists(mcp)).toBe(true);
    });

    it('全部清空后 .pilotdeck 目录本身也被收掉', async () => {
        const deck = path.join(home, WORKSPACE, '.pilotdeck');
        const plan = path.join(deck, 'plans', 'p.md');
        await fs.mkdir(path.dirname(plan), { recursive: true });
        await fs.writeFile(plan, '# p');
        const old = new Date(Date.now() - 30 * DAY_MS);
        await fs.utimes(plan, old, old);
        await fs.utimes(path.dirname(plan), old, old);

        await runToolResultsRetention({ homes: [home] });

        expect(await exists(deck)).toBe(false);
    });

    it('主目录级的 .pilotdeck 只清 tool-results，不动它的其它子目录', async () => {
        const homeDeck = path.join(home, '.pilotdeck');
        const legacy = path.join(homeDeck, 'tool-results', 'web:s_legacy');
        await fs.mkdir(legacy, { recursive: true });
        await fs.writeFile(path.join(legacy, 'a.json'), '{}');
        const config = path.join(homeDeck, 'skills', 'keep.md');
        await fs.mkdir(path.dirname(config), { recursive: true });
        await fs.writeFile(config, '# keep');
        const old = new Date(Date.now() - 60 * DAY_MS);
        await fs.utimes(config, old, old);

        await runToolResultsRetention({ homes: [home], now: new Date(Date.now() + HOUR_MS * 2) });

        expect(await exists(legacy)).toBe(false);
        expect(await exists(config)).toBe(true);
    });
});
