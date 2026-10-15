// ui/server/services/gatewayPool.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayPool, buildGatewayChildEnv } from './gatewayPool.js';

let root; let clock; let timers;
// Any fixed wall-clock instant; only used as the `startedAt` the pid file records.
const clockStartIso = '2026-10-14T12:00:00.000Z';
function makeFakes({ failUsers = new Set(), connectDelayMs = 0, killExitDelayMs = 0, connectFails = false, findFreePort: customFindFreePort } = {}) {
  const spawned = []; const closed = [];
  let nextPort = 20000;
  const spawnGateway = vi.fn(({ userId, userHome, port }) => {
    const child = new EventEmitter();
    child.pid = 1000 + spawned.length;
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      if (killExitDelayMs) clock.setTimer(() => child.emit('exit', 0, null), killExitDelayMs);
      else queueMicrotask(() => child.emit('exit', 0, null));
      return true;
    });
    spawned.push({ userId, userHome, port, child });
    if (failUsers.has(String(userId))) queueMicrotask(() => child.emit('exit', 1, null));
    return child;
  });
  const connectGateway = vi.fn(async ({ url, token }) => {
    if (connectFails) throw new Error('not ready');
    if (connectDelayMs) await new Promise((r) => setTimeout(r, connectDelayMs));
    const gw = { url, token, close: vi.fn(() => closed.push(url)) };
    return gw;
  });
  const findFreePort = customFindFreePort ?? vi.fn(async () => nextPort++);
  return { spawned, closed, spawnGateway, connectGateway, findFreePort };
}
function makeClock() {
  let now = 1_000_000; const pending = [];
  return {
    now: () => now,
    pendingCount: () => pending.length,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; pending.push(t); return t; },
    clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    advance: async (ms) => { now += ms; for (const t of [...pending].filter((t) => t.at <= now)) { pending.splice(pending.indexOf(t), 1); await t.fn(); } },
  };
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pool-')); clock = makeClock(); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const mk = (fakes, config = {}, extra = {}) => createGatewayPool({
  env: { PILOT_HOME: root }, config: { maxInstances: 2, idleTimeoutMs: 1000, startTimeoutMs: 500, maxWaiting: 1, ...config },
  spawnGateway: fakes.spawnGateway, connectGateway: fakes.connectGateway, findFreePort: fakes.findFreePort,
  now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {},
  // Never let a unit test signal a real pid.
  inspectProcess: () => null,
  ...extra,
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
    expect(clock.pendingCount()).toBe(0);
  });

  it('clears the connect-retry timer when the start is stopped', async () => {
    const f = makeFakes({ connectFails: true }); const pool = mk(f);
    const p = pool.acquire(1);
    p.catch(() => {});
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(f.connectGateway).toHaveBeenCalledTimes(1);
    expect(clock.pendingCount()).toBeGreaterThan(0); // start timeout + retry sleep
    await pool.stopUser(1);
    await expect(p).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    expect(clock.pendingCount()).toBe(0);
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

  for (const how of ['stopUser', 'shutdown']) {
    it(`${how} before the port resolves never leaves an orphan child`, async () => {
      let resolvePort;
      const f = makeFakes({ findFreePort: vi.fn(() => new Promise((r) => { resolvePort = r; })) });
      const pool = mk(f);
      const p = pool.acquire(1);
      p.catch(() => {});
      await pool[how](...(how === 'stopUser' ? [1] : []));
      resolvePort(20000);
      await expect(p).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', status: 503 });
      expect(f.spawnGateway).not.toHaveBeenCalled();
      expect(pool.snapshot()).toEqual([]);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'system', 'gateway-pids.json'), 'utf8'))).toEqual({});
    });
  }

  it('holds capacity until the evicted child has actually exited', async () => {
    const f = makeFakes({ killExitDelayMs: 20 }); const pool = mk(f);
    (await pool.acquire(1)).release();
    await clock.advance(10);
    (await pool.acquire(2)).release();
    expect(f.spawnGateway).toHaveBeenCalledTimes(2);
    const p = pool.acquire(3);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(f.spawned[0].child.kill).toHaveBeenCalled();
    expect(f.spawnGateway).toHaveBeenCalledTimes(2);
    await clock.advance(19);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(f.spawnGateway).toHaveBeenCalledTimes(2);
    expect(pool.snapshot().length).toBeLessThanOrEqual(2);
    await clock.advance(1);
    const c = await p;
    expect(f.spawnGateway).toHaveBeenCalledTimes(3);
    expect(pool.snapshot().map((x) => x.userId).sort()).toEqual(['2', '3']);
    c.release();
  });

  it('a racing acquire cannot take the slot of an instance that is still exiting', async () => {
    const f = makeFakes({ killExitDelayMs: 20 }); const pool = mk(f);
    (await pool.acquire(1)).release();
    await clock.advance(10);
    (await pool.acquire(2)).release();
    const p = pool.acquire(3); const q = pool.acquire(4);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(f.spawnGateway).toHaveBeenCalledTimes(2); // nothing new while user 1 is exiting
    await clock.advance(20);
    const first = await Promise.race([p, q]);
    first.release();
    await clock.advance(20); // the other waiter evicts the now-idle instance
    const second = await Promise.all([p, q]);
    expect(second).toHaveLength(2);
    expect(pool.snapshot().filter((x) => x.state !== 'stopping').length).toBeLessThanOrEqual(2);
    second.forEach((l) => l.release());
  });

  describe('port reservation', () => {
    // Mimics bind-then-close probing: always reports the base port unless told it is reserved.
    const stubbornFinder = () => vi.fn(async (_startAt, isReserved = () => false) => (isReserved(20000) ? 20001 : 20000));

    it('gives concurrent first starts for different users different ports', async () => {
      const f = makeFakes({ findFreePort: stubbornFinder() }); const pool = mk(f, { maxInstances: 3 });
      const [a, b] = await Promise.all([pool.acquire(1), pool.acquire(2)]);
      expect(f.spawned.map((x) => x.port).sort()).toEqual([20000, 20001]);
      a.release(); b.release();
    });

    it('releases the reservation once the instance has exited', async () => {
      const f = makeFakes({ findFreePort: stubbornFinder() }); const pool = mk(f, { maxInstances: 3 });
      (await pool.acquire(1)).release();
      await pool.stopUser(1);
      (await pool.acquire(3)).release();
      expect(f.spawned.map((x) => x.port)).toEqual([20000, 20000]);
    });

    it('keeps the reservation while the child is still exiting', async () => {
      const f = makeFakes({ findFreePort: stubbornFinder(), killExitDelayMs: 20 }); const pool = mk(f, { maxInstances: 3 });
      (await pool.acquire(1)).release();
      const stopping = pool.stopUser(1);
      const b = await pool.acquire(2);
      expect(f.spawned[1].port).toBe(20001);
      await clock.advance(20);
      await stopping;
      b.release();
    });

    it('releases the reservation when a start fails', async () => {
      const f = makeFakes({ findFreePort: stubbornFinder(), failUsers: new Set(['9']) }); const pool = mk(f, { maxInstances: 3 });
      await expect(pool.acquire(9)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
      (await pool.acquire(1)).release();
      expect(f.spawned.map((x) => x.port)).toEqual([20000, 20000]);
    });
  });

  describe('post-ready crash', () => {
    // A child that dies only after connectGateway resolved: the entry is
    // already idle/busy, so this is not a start failure.
    function crashAfterReady(f, index) {
      f.spawned[index].child.emit('exit', 1, null);
    }

    it('respawns after an unexpected exit of a ready instance', async () => {
      const f = makeFakes(); const pool = mk(f);
      const lease = await pool.acquire(1);
      expect(pool.snapshot()[0].state).toBe('busy');
      crashAfterReady(f, 0);
      await Promise.resolve();
      expect(pool.snapshot()).toEqual([]);
      lease.release();
      const next = await pool.acquire(1);
      expect(f.spawnGateway).toHaveBeenCalledTimes(2);
      next.release();
    });

    it('counts post-ready crashes towards the breaker and stops respawning', async () => {
      const f = makeFakes(); const pool = mk(f);
      for (let i = 0; i < 3; i += 1) {
        const lease = await pool.acquire(1);
        lease.release();                    // idle
        expect(pool.snapshot()[0].state).toBe('idle');
        crashAfterReady(f, i);
        await Promise.resolve();
        expect(pool.snapshot()).toEqual([]);
      }
      expect(f.spawnGateway).toHaveBeenCalledTimes(3);
      await expect(pool.acquire(1)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', status: 503 });
      expect(f.spawnGateway).toHaveBeenCalledTimes(3); // the breaker, not another child
    });

    it('forgets crashes once the breaker window has passed', async () => {
      const f = makeFakes(); const pool = mk(f, { idleTimeoutMs: 60 * 60_000 });
      for (let i = 0; i < 3; i += 1) {
        (await pool.acquire(1)).release();
        crashAfterReady(f, i);
        await Promise.resolve();
      }
      await expect(pool.acquire(1)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
      await clock.advance(10 * 60_000 + 1);
      const lease = await pool.acquire(1);
      expect(f.spawnGateway).toHaveBeenCalledTimes(4);
      lease.release();
    });
  });

  it('a revocation that lands while the instance is starting never hands out a lease', async () => {
    let resolveConnect;
    const f = makeFakes();
    f.connectGateway.mockImplementation(async ({ url }) => {
      await new Promise((r) => { resolveConnect = r; });
      return { url, close: vi.fn(() => f.closed.push(url)) };
    });
    const pool = mk(f);
    const p = pool.acquire(1);
    p.catch(() => {});
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(pool.snapshot()[0].state).toBe('starting');
    pool.markRevoked(1);
    resolveConnect();
    await expect(p).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', status: 503 });
    expect(f.spawned[0].child.kill).toHaveBeenCalled();
    expect(pool.snapshot()).toEqual([]);
  });

  describe('reapOrphans pid verification', () => {
    function seedPidFile(entry) {
      fs.mkdirSync(path.join(root, 'system'), { recursive: true });
      fs.writeFileSync(path.join(root, 'system', 'gateway-pids.json'), JSON.stringify({ 1: entry }));
    }
    const recordedAt = new Date(clockStartIso).toISOString();

    function reapWith(inspectProcess) {
      const killed = [];
      const realKill = process.kill;
      process.kill = (pid, signal) => { killed.push([pid, signal]); };
      try {
        mk(makeFakes(), {}, { inspectProcess });
      } finally {
        process.kill = realKill;
      }
      return killed;
    }

    it('signals a pid that still looks like the gateway we recorded', () => {
      seedPidFile({ pid: 4242, port: 20000, startedAt: recordedAt });
      const killed = reapWith(() => ({ comm: '/usr/local/bin/node', startedAtMs: Date.parse(recordedAt) + 1000 }));
      expect(killed).toEqual([[4242, 'SIGTERM']]);
    });

    it('skips a pid that is gone', () => {
      seedPidFile({ pid: 4242, port: 20000, startedAt: recordedAt });
      expect(reapWith(() => null)).toEqual([]);
    });

    it('skips a pid that is not a node process', () => {
      seedPidFile({ pid: 4242, port: 20000, startedAt: recordedAt });
      expect(reapWith(() => ({ comm: 'postgres', startedAtMs: Date.parse(recordedAt) }))).toEqual([]);
    });

    it('skips a recycled pid that started before we recorded it', () => {
      seedPidFile({ pid: 4242, port: 20000, startedAt: recordedAt });
      const killed = reapWith(() => ({ comm: 'node', startedAtMs: Date.parse(recordedAt) - 60_000 }));
      expect(killed).toEqual([]);
    });

    it('tolerates whole-second rounding in the reported start time', () => {
      seedPidFile({ pid: 4242, port: 20000, startedAt: recordedAt });
      const killed = reapWith(() => ({ comm: 'node', startedAtMs: Date.parse(recordedAt) - 900 }));
      expect(killed).toEqual([[4242, 'SIGTERM']]);
    });
  });

  it('shutdown stops everything and clears the pid file', async () => {
    const f = makeFakes(); const pool = mk(f);
    (await pool.acquire(1)).release(); (await pool.acquire(2)).release();
    await pool.shutdown();
    expect(f.closed).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'system', 'gateway-pids.json'), 'utf8'))).toEqual({});
  });
});

describe('gatewayPool always-on flag by mode', () => {
  const base = { env: { PILOTDECK_DISABLE_ALWAYS_ON: 'inherited', PILOTDECK_GATEWAY_URL: 'http://x' }, userHome: '/h/users/1', port: 20001, configPath: '/h/pilotdeck.yaml' };

  it('multi-user child env disables always-on / cron / IM', () => {
    const env = buildGatewayChildEnv({ ...base, multiUser: true });
    expect(env.PILOTDECK_DISABLE_ALWAYS_ON).toBe('1');
    expect(env.PILOT_HOME).toBe('/h/users/1');
    expect(env.PILOTDECK_GATEWAY_URL).toBeUndefined();
  });

  it('no-login child env leaves always-on enabled (even if the parent env set the flag)', () => {
    const env = buildGatewayChildEnv({ ...base, multiUser: false });
    expect('PILOTDECK_DISABLE_ALWAYS_ON' in env).toBe(false);
    expect(env.PILOTDECK_GATEWAY_PORT).toBe('20001');
    expect(env.PILOTDECK_CONFIG_PATH).toBe('/h/pilotdeck.yaml');
  });

  it('the pool hands its multiUser mode to spawnGateway (default true)', async () => {
    const seen = [];
    for (const [extra, expected] of [[{}, true], [{ multiUser: true }, true], [{ multiUser: false }, false]]) {
      const f = makeFakes();
      const pool = mk(f, {}, extra);
      const lease = await pool.acquire(1);
      seen.push([expected, f.spawnGateway.mock.calls[0][0].multiUser]);
      lease.release();
      await pool.shutdown();
    }
    for (const [expected, actual] of seen) expect(actual).toBe(expected);
  });
});
