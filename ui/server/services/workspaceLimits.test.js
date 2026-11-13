// @vitest-environment node
// 工作区配额（设计书 §8.2 / §9.5）：配置文件为唯一来源，缺配置/坏配置一律回落默认值。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GiB = 1024 ** 3;

let root;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-limits-'));
    vi.stubEnv('PILOT_HOME', root);
    vi.stubEnv('PILOTDECK_CONFIG_PATH', path.join(root, 'pilotdeck.yaml'));
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(text) {
    fs.writeFileSync(path.join(root, 'pilotdeck.yaml'), text);
}

describe('getWorkspaceLimits', () => {
    it('没有配置文件时全部走默认值', async () => {
        const { getWorkspaceLimits, DEFAULT_WORKSPACE_LIMITS } = await import('./workspaceLimits.js');
        await expect(getWorkspaceLimits()).resolves.toEqual({ ...DEFAULT_WORKSPACE_LIMITS });
    });

    it('部分覆盖：只改写的字段，其余保持默认', async () => {
        const { getWorkspaceLimits, DEFAULT_WORKSPACE_LIMITS } = await import('./workspaceLimits.js');
        writeConfig([
            'workspace:',
            '  quota:',
            `    workspaceWarnBytes: ${2 * GiB}`,
            '    scratchTtlDays: 7',
        ].join('\n'));

        const limits = await getWorkspaceLimits();
        expect(limits.workspaceWarnBytes).toBe(2 * GiB);
        expect(limits.scratchTtlDays).toBe(7);
        expect(limits.scratchMaxBytes).toBe(DEFAULT_WORKSPACE_LIMITS.scratchMaxBytes);
        expect(limits.userTotalMaxBytes).toBe(DEFAULT_WORKSPACE_LIMITS.userTotalMaxBytes);
    });

    it('默认 scratch TTL 是 7 天，回合结束清理默认开启', async () => {
        const { getWorkspaceLimits, DEFAULT_WORKSPACE_LIMITS } = await import('./workspaceLimits.js');
        expect(DEFAULT_WORKSPACE_LIMITS.scratchTtlDays).toBe(7);
        expect(DEFAULT_WORKSPACE_LIMITS.cleanOnTurnEnd).toBe(true);

        const limits = await getWorkspaceLimits();
        expect(limits.scratchTtlDays).toBe(7);
        expect(limits.cleanOnTurnEnd).toBe(true);
    });

    it('cleanOnTurnEnd 可以在 yaml 里关掉；非布尔值回落默认 true', async () => {
        const { getWorkspaceLimits, invalidateWorkspaceLimitsCache } = await import('./workspaceLimits.js');
        writeConfig('workspace:\n  quota:\n    cleanOnTurnEnd: false\n');
        expect((await getWorkspaceLimits()).cleanOnTurnEnd).toBe(false);

        invalidateWorkspaceLimitsCache();
        writeConfig('workspace:\n  quota:\n    cleanOnTurnEnd: "no"\n');
        expect((await getWorkspaceLimits()).cleanOnTurnEnd).toBe(true);
    });

    it('非法值（负数、越界比例、字符串）逐项回落到默认值，不抛错', async () => {
        const { getWorkspaceLimits, DEFAULT_WORKSPACE_LIMITS } = await import('./workspaceLimits.js');
        writeConfig([
            'workspace:',
            '  quota:',
            '    scratchMaxBytes: -1',
            '    scratchSoftRatio: 1.5',
            '    protectRecentMinutes: not-a-number',
            '    workspaceWarnBytes: 0',
        ].join('\n'));

        const limits = await getWorkspaceLimits();
        expect(limits.scratchMaxBytes).toBe(DEFAULT_WORKSPACE_LIMITS.scratchMaxBytes);
        expect(limits.scratchSoftRatio).toBe(DEFAULT_WORKSPACE_LIMITS.scratchSoftRatio);
        expect(limits.protectRecentMinutes).toBe(DEFAULT_WORKSPACE_LIMITS.protectRecentMinutes);
        expect(limits.workspaceWarnBytes).toBe(DEFAULT_WORKSPACE_LIMITS.workspaceWarnBytes);
    });

    it('YAML 语法错误时整体回落默认值', async () => {
        const { getWorkspaceLimits, DEFAULT_WORKSPACE_LIMITS } = await import('./workspaceLimits.js');
        writeConfig('workspace: [unclosed');
        await expect(getWorkspaceLimits()).resolves.toEqual({ ...DEFAULT_WORKSPACE_LIMITS });
    });

    it('影像工作区覆盖只影响 imagingScratchMaxBytes，不动通用 scratchMaxBytes', async () => {
        const { getWorkspaceLimits, DEFAULT_WORKSPACE_LIMITS } = await import('./workspaceLimits.js');
        writeConfig([
            'workspace:',
            '  quota:',
            '    overrides:',
            '      imaging:',
            `        scratchMaxBytes: ${3 * GiB}`,
        ].join('\n'));

        const limits = await getWorkspaceLimits();
        expect(limits.imagingScratchMaxBytes).toBe(3 * GiB);
        expect(limits.scratchMaxBytes).toBe(DEFAULT_WORKSPACE_LIMITS.scratchMaxBytes);
    });

    it('缓存 60 秒：期间改配置不生效，手动失效或过期后才重新读取', async () => {
        const {
            getWorkspaceLimits,
            invalidateWorkspaceLimitsCache,
        } = await import('./workspaceLimits.js');

        const t = 1_000_000;
        writeConfig('workspace:\n  quota:\n    scratchMaxBytes: 100\n');
        expect((await getWorkspaceLimits({ now: () => t })).scratchMaxBytes).toBe(100);

        writeConfig('workspace:\n  quota:\n    scratchMaxBytes: 200\n');
        expect((await getWorkspaceLimits({ now: () => t + 1_000 })).scratchMaxBytes).toBe(100);

        invalidateWorkspaceLimitsCache();
        expect((await getWorkspaceLimits({ now: () => t + 1_000 })).scratchMaxBytes).toBe(200);

        // 上一次读取把有效期推到 t+1000+60_000；跨过它就应该重新读盘。
        writeConfig('workspace:\n  quota:\n    scratchMaxBytes: 300\n');
        expect((await getWorkspaceLimits({ now: () => t + 1_000 + 60_001 })).scratchMaxBytes).toBe(300);
    });
});
