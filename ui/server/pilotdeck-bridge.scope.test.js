import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root; const acquired = []; const released = []; let acquireError = null;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bridge-'));
  vi.stubEnv('PILOT_HOME', root);
  vi.resetModules();
  acquired.length = 0; released.length = 0; acquireError = null;
  vi.doMock('./services/gatewayPool.js', () => ({
    createGatewayPool: () => ({
      acquire: async (userId) => {
        if (acquireError) throw acquireError;
        acquired.push(String(userId));
        const gateway = { userId: String(userId), abortTurn: vi.fn(async () => {}), close: vi.fn() };
        return { gateway, runtimeId: `${userId}:1`, release: () => released.push(String(userId)) };
      },
      markRevoked: vi.fn(), shutdown: vi.fn(async () => {}), snapshot: () => [],
    }),
  }));
  vi.doMock('./services/pilotdeckConfig.js', async (importOriginal) => ({ ...(await importOriginal()), readMultiUserConfig: () => ({ gatewayPool: {} }) }));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('pilotdeck-bridge under user scope', () => {
  it('getPilotDeckGateway acquires the scoped user\'s gateway and releases the lease', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { getPilotDeckGateway } = await import('./pilotdeck-bridge.js');
    const gw = await runWithUserScope({ userId: 5, role: 'user' }, () => getPilotDeckGateway());
    expect(gw.userId).toBe('5');
    expect(acquired).toEqual(['5']);
    expect(released).toEqual(['5']);
  });
  it('refuses without a scope', async () => {
    const { getPilotDeckGateway } = await import('./pilotdeck-bridge.js');
    await expect(getPilotDeckGateway()).rejects.toMatchObject({ code: 'USER_SCOPE_MISSING' });
  });
  it('keeps session state apart per user for the same sessionKey', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const bridge = await import('./pilotdeck-bridge.js');
    const key = 'web:s_11111111-2222-3333-4444-555555555555';
    await runWithUserScope({ userId: 1, role: 'user' }, () => bridge.__testing.touchSession(key, { active: true }));
    const forA = await runWithUserScope({ userId: 1, role: 'user' }, () => bridge.isSessionActiveViaGateway(key));
    const forB = await runWithUserScope({ userId: 2, role: 'user' }, () => bridge.isSessionActiveViaGateway(key));
    expect(forA).toBe(true);
    expect(forB).toBe(false);
  });
  it('lists only the scoped user\'s active sessions', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const bridge = await import('./pilotdeck-bridge.js');
    const keyA = 'web:s_aaaaaaaa-2222-3333-4444-555555555555';
    const keyB = 'web:s_bbbbbbbb-2222-3333-4444-555555555555';
    await runWithUserScope({ userId: 1, role: 'user' }, () => bridge.__testing.touchSession(keyA, { active: true }));
    await runWithUserScope({ userId: 2, role: 'user' }, () => bridge.__testing.touchSession(keyB, { active: true }));
    expect(await runWithUserScope({ userId: 1, role: 'user' }, () => bridge.getActiveSessionIdsViaGateway())).toEqual([keyA]);
    expect(await runWithUserScope({ userId: 2, role: 'user' }, () => bridge.getActiveSessionIdsViaGateway())).toEqual([keyB]);
  });
  it('withUserGateway releases the lease when the callback throws', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { withUserGateway } = await import('./pilotdeck-bridge.js');
    await expect(runWithUserScope({ userId: 7, role: 'user' }, () => withUserGateway(async () => { throw new Error('boom'); }))).rejects.toThrow('boom');
    expect(released).toEqual(['7']);
  });
  it('runChatViaGateway surfaces a pool 503 as a visible gateway_unavailable status', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { runChatViaGateway } = await import('./pilotdeck-bridge.js');
    acquireError = Object.assign(new Error('Too many active users right now'), { code: 'GATEWAY_POOL_EXHAUSTED', status: 503 });
    const frames = [];
    await runWithUserScope({ userId: 3, role: 'user' }, () => runChatViaGateway('hi', {}, { send: (f) => frames.push(f) }));
    const status = frames.find((f) => f.kind === 'agent_status' || f.event === 'gateway_unavailable' || JSON.stringify(f).includes('gateway_unavailable'));
    expect(status).toBeTruthy();
    expect(JSON.stringify(frames)).toContain('gateway_unavailable');
  });
});
