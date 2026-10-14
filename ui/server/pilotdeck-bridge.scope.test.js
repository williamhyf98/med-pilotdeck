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

describe('gateway errors become 503, never 500', () => {
  function fakeRes() {
    const captured = {};
    return {
      captured,
      status(code) { captured.status = code; return this; },
      json(body) { captured.body = body; return this; },
    };
  }

  // A lease whose socket was closed underneath it (revoke / LRU evict / crashed
  // child) throws a plain Error with no status: it must still read as 503.
  it('a closed gateway socket surfaces through sendRouteError as 503', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { withUserGateway } = await import('./pilotdeck-bridge.js');
    const { sendRouteError } = await import('./utils/routeErrors.js');

    const error = await runWithUserScope({ userId: 7, role: 'user' }, () => withUserGateway(async (gw) => {
      gw.listProjects = () => { throw new Error('gateway websocket closed'); };
      return gw.listProjects();
    })).then(() => null, (e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBeUndefined();   // the pool never saw this one
    expect(released).toEqual(['7']);        // the lease is still returned

    const res = fakeRes();
    sendRouteError(res, error);
    expect(res.captured.status).toBe(503);
    expect(res.captured.body).toEqual({ error: 'gateway websocket closed', code: 'GATEWAY_UNAVAILABLE' });
  });

  it('keeps the pool error code when the pool itself refused', async () => {
    const { toGatewayHttpError } = await import('./pilotdeck-bridge.js');
    const { sendRouteError } = await import('./utils/routeErrors.js');
    const poolError = Object.assign(new Error('Too many active users; please try again shortly'), {
      code: 'GATEWAY_POOL_EXHAUSTED', status: 503,
    });
    expect(toGatewayHttpError(poolError)).toMatchObject({ status: 503, code: 'GATEWAY_POOL_EXHAUSTED' });
    const res = fakeRes();
    sendRouteError(res, poolError);
    expect(res.captured.status).toBe(503);
    expect(res.captured.body.code).toBe('GATEWAY_POOL_EXHAUSTED');
  });

  it('leaves non-gateway failures alone', async () => {
    const { toGatewayHttpError } = await import('./pilotdeck-bridge.js');
    const { sendRouteError } = await import('./utils/routeErrors.js');
    expect(toGatewayHttpError(new Error('ENOENT: no such file'))).toBeNull();
    const res = fakeRes();
    sendRouteError(res, new Error('ENOENT: no such file'));
    expect(res.captured.status).toBe(500);
    expect(res.captured.body).toEqual({ error: 'ENOENT: no such file' });

    const notFound = Object.assign(new Error('nope'), { status: 404, code: 'PROJECT_NOT_FOUND' });
    const res2 = fakeRes();
    sendRouteError(res2, notFound);
    expect(res2.captured.status).toBe(404);
    expect(res2.captured.body).toEqual({ error: 'nope', code: 'PROJECT_NOT_FOUND' });
  });
});

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
