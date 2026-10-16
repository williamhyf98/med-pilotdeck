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

afterEach(() => { vi.unstubAllEnvs(); });

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
});
