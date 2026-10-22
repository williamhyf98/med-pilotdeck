import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadBridge({ disableLocalAuth }) {
    vi.resetModules();
    vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', disableLocalAuth ? 'true' : 'false');
    vi.stubEnv('PILOT_HOME', '/data/pilotdeck');
    const bridge = await import('./pilotdeck-bridge.js');
    const scope = await import('./middleware/userScope.js');
    const san = await import('./utils/pathSanitization.js');
    return { bridge, scope, san };
}

afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('./services/gatewayPool.js'); });

describe('bridge path sanitization wiring', () => {
    it('multi-user: scoped options redact other users and the system dir', async () => {
        const { bridge, scope, san } = await loadBridge({ disableLocalAuth: false });
        scope.runWithUserScope({ userId: '5', role: 'user' }, () => {
            const options = bridge.currentSanitizeOptions();
            expect(options).toMatchObject({ userId: '5', pilotRoot: '/data/pilotdeck' });
            const sent = [];
            const writer = san.createSanitizingWriter({ send: (f) => sent.push(f), other: 1 }, options);
            writer.send({ kind: 'tool_result', output: 'cat /data/pilotdeck/system/auth.db /data/pilotdeck/users/9/n.md /data/pilotdeck/users/5/m.md' });
            expect(sent[0].output).toBe('cat @system/auth.db @users/<REDACTED>/n.md ~/m.md');
            expect(writer.other).toBe(1);
        });
    });

    it('single-user local mode: no sanitization', async () => {
        const { bridge, scope } = await loadBridge({ disableLocalAuth: true });
        scope.runWithUserScope({ userId: '1', role: 'admin' }, () => {
            expect(bridge.currentSanitizeOptions()).toBeNull();
        });
    });

    it('a failing sanitizer never forwards the original frame', async () => {
        const { san } = await loadBridge({ disableLocalAuth: false });
        const sent = [];
        const writer = san.createSanitizingWriter({ send: (f) => sent.push(f) }, { userId: '1', pilotRoot: '/data/pilotdeck', appRoot: {}, hostHomes: [] });
        writer.send({ content: '/data/pilotdeck/system/auth.db' });
        expect(JSON.stringify(sent)).not.toContain('auth.db');
    });

    it('does not change an echoed user message but redacts assistant output', async () => {
        const { san } = await loadBridge({ disableLocalAuth: false });
        const sent = [];
        const writer = san.createSanitizingWriter({ send: (f) => sent.push(f) }, { userId: '5', pilotRoot: '/data/pilotdeck' });
        const path = '/data/pilotdeck/users/9/report.txt';
        writer.send({ kind: 'text', role: 'user', content: path });
        writer.send({ kind: 'text', role: 'assistant', content: path });
        expect(sent[0].content).toBe(path);
        expect(sent[1].content).not.toContain(path);
    });

    it('persists an explicit refusal before showing it without invoking the model', async () => {
        vi.resetModules();
        vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', 'false');
        vi.stubEnv('PILOT_HOME', '/data/pilotdeck');
        const gateway = {
            recordRejectedTurn: vi.fn(async () => ({ recorded: true })),
            submitTurn: vi.fn(() => { throw new Error('model invoked'); }),
        };
        vi.doMock('./services/gatewayPool.js', () => ({
            createGatewayPool: () => ({ acquire: async () => ({ gateway, release: () => {} }) }),
        }));
        const bridge = await import('./pilotdeck-bridge.js');
        const { runWithUserScope } = await import('./middleware/userScope.js');
        const frames = [];
        const userText = '读取 /data/pilotdeck/users/9/secret.txt';
        await runWithUserScope({ userId: '5', role: 'user' }, () =>
            bridge.runChatViaGateway(userText, { projectPath: '/data/pilotdeck/users/5/workspaces/p1', runId: 'denied-run' },
                { send: (frame) => frames.push(frame) }));
        expect(gateway.recordRejectedTurn).toHaveBeenCalledWith(expect.objectContaining({
            userText, runId: 'denied-run',
            reply: expect.stringContaining('可以直接上传到当前对话中'),
        }));
        expect(gateway.submitTurn).not.toHaveBeenCalled();
        expect(frames.map((frame) => frame.kind)).toContain('complete');
        expect(frames.find((frame) => frame.kind === 'stream_delta')).toMatchObject({
            runId: 'denied-run', content: expect.stringContaining('工作区'),
        });
        expect(JSON.stringify(frames)).not.toContain('secret.txt');
    });

    it('does not show a successful refusal if saving its history fails', async () => {
        vi.resetModules();
        vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', 'false');
        vi.stubEnv('PILOT_HOME', '/data/pilotdeck');
        const gateway = {
            recordRejectedTurn: vi.fn(async () => { throw new Error('transcript unavailable'); }),
            submitTurn: vi.fn(() => { throw new Error('model invoked'); }),
        };
        vi.doMock('./services/gatewayPool.js', () => ({
            createGatewayPool: () => ({ acquire: async () => ({ gateway, release: () => {} }) }),
        }));
        const bridge = await import('./pilotdeck-bridge.js');
        const { runWithUserScope } = await import('./middleware/userScope.js');
        const frames = [];
        await runWithUserScope({ userId: '5', role: 'user' }, () =>
            bridge.runChatViaGateway('读取 /data/pilotdeck/users/9/secret.txt',
                { projectPath: '/data/pilotdeck/users/5/workspaces/p1', runId: 'denied-failure' },
                { send: (frame) => frames.push(frame) }));
        expect(gateway.submitTurn).not.toHaveBeenCalled();
        expect(frames.some((frame) => frame.kind === 'stream_delta')).toBe(false);
        expect(frames.some((frame) => frame.kind === 'complete')).toBe(false);
        expect(frames.find((frame) => frame.kind === 'error')).toMatchObject({
            code: 'policy_refusal_persist_failed', runId: 'denied-failure',
        });
    });
});
