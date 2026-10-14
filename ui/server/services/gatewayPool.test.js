// ui/server/services/gatewayPool.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayPool } from './gatewayPool.js';

let root; let clock; let timers;
function makeFakes({ failUsers = new Set(), connectDelayMs = 0 } = {}) {
  const spawned = []; const closed = [];
  let nextPort = 20000;
  const spawnGateway = vi.fn(({ userId, userHome, port }) => {
    const child = new EventEmitter();
    child.pid = 1000 + spawned.length;
    child.killed = false;
    child.kill = vi.fn(() => { child.killed = true; queueMicrotask(() => child.emit('exit', 0, null)); return true; });
    spawned.push({ userId, userHome, port, child });
    if (failUsers.has(String(userId))) queueMicrotask(() => child.emit('exit', 1, null));
    return child;
  });
  const connectGateway = vi.fn(async ({ url, token }) => {
    if (connectDelayMs) await new Promise((r) => setTimeout(r, connectDelayMs));
    const gw = { url, token, close: vi.fn(() => closed.push(url)) };
    return gw;
  });
  const findFreePort = vi.fn(async () => nextPort++);
  return { spawned, closed, spawnGateway, connectGateway, findFreePort };
}
function makeClock() {
  let now = 1_000_000; const pending = [];
  return {
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; pending.push(t); return t; },
    clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    advance: async (ms) => { now += ms; for (const t of [...pending].filter((t) => t.at <= now)) { pending.splice(pending.indexOf(t), 1); await t.fn(); } },
  };
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pool-')); clock = makeClock(); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const mk = (fakes, config = {}) => createGatewayPool({
  env: { PILOT_HOME: root }, config: { maxInstances: 2, idleTimeoutMs: 1000, startTimeoutMs: 500, maxWaiting: 1, ...config },
  spawnGateway: fakes.spawnGateway, connectGateway: fakes.connectGateway, findFreePort: fakes.findFreePort,
  now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {},
});

describe('gatewayPool', () => {
  it('spawns once per user with that user\'s home, and A/B get different processes', async () => {
    const f = makeFakes(); const pool = mk(f);
    const [a1, a2, b] = await Promise.all([pool.acquire(1), pool.acquire(1), pool.acquire(2)]);
    expect(f.spawnGateway).toHaveBeenCalledTimes(2);
    expect(a1.gateway).toBe(a2.gateway);
    expect(a1.gateway).not.toBe(b.gateway);
    expect(f.spawned[0].userHome).toBe(path.join(root, 'users', '1'));
    expect(f.spawned[1].userHome).toBe(path.join(root, 'users', '2'));
    expect(f.spawned[0].port).not.toBe(f.spawned[1].port);
    expect(fs.statSync(path.join(root, 'users', '1', 'server-token')).mode & 0o777).toBe(0o600);
    a1.release(); a2.release(); b.release();
  });

  it('recycles idle instances after idleTimeoutMs, never busy ones', async () => {
    const f = makeFakes(); const pool = mk(f);
    const lease = await pool.acquire(1);
    await clock.advance(5000);
    expect(f.closed).toHaveLength(0);
    lease.release();
    await clock.advance(1001);
    expect(f.closed).toHaveLength(1);
    expect(f.spawned[0].child.kill).toHaveBeenCalled();
    expect(pool.snapshot()).toEqual([]);
  });

  it('evicts the least recently used idle instance when full', async () => {
    const f = makeFakes(); const pool = mk(f);
    (await pool.acquire(1)).release();
    await clock.advance(10);
    (await pool.acquire(2)).release();
    const c = await pool.acquire(3);
    expect(f.spawnGateway).toHaveBeenCalledTimes(3);
    expect(pool.snapshot().map((s) => s.userId).sort()).toEqual(['2', '3']);
    c.release();
  });

  it('queues when all instances are busy and rejects beyond maxWaiting', async () => {
    const f = makeFakes(); const pool = mk(f);
    const a = await pool.acquire(1); const b = await pool.acquire(2);
    const waiting = pool.acquire(3);
    await expect(pool.acquire(4)).rejects.toMatchObject({ code: 'GATEWAY_POOL_EXHAUSTED', status: 503 });
    a.release();
    const c = await waiting;
    expect(c.gateway).toBeDefined();
    b.release(); c.release();
  });

  it('fails fast when the child exits during start and trips the breaker after 3 failures', async () => {
    const f = makeFakes({ failUsers: new Set(['9']) }); const pool = mk(f);
    for (let i = 0; i < 3; i += 1) {
      await expect(pool.acquire(9)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    }
    await expect(pool.acquire(9)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    expect(f.spawnGateway).toHaveBeenCalledTimes(3);
  });

  it('times out a start that never connects', async () => {
    const f = makeFakes({ connectDelayMs: 10_000 }); const pool = mk(f, { startTimeoutMs: 50 });
    const p = pool.acquire(1);
    await clock.advance(60);
    await expect(p).rejects.toMatchObject({ code: 'GATEWAY_START_TIMEOUT' });
  });

  it('markRevoked stops an idle instance immediately and a busy one on release', async () => {
    const f = makeFakes(); const pool = mk(f);
    const lease = await pool.acquire(1);
    pool.markRevoked(1);
    expect(f.closed).toHaveLength(0);
    lease.release();
    await Promise.resolve();
    expect(f.closed).toHaveLength(1);
  });

  it('shutdown stops everything and clears the pid file', async () => {
    const f = makeFakes(); const pool = mk(f);
    (await pool.acquire(1)).release(); (await pool.acquire(2)).release();
    await pool.shutdown();
    expect(f.closed).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'system', 'gateway-pids.json'), 'utf8'))).toEqual({});
  });
});
