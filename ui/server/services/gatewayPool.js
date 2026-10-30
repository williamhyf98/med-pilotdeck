// ui/server/services/gatewayPool.js
//
// Per-user Gateway process pool: one Gateway child process per user with
// PILOT_HOME=<root>/users/<userId>. Hands out leases, recycles idle
// instances, evicts LRU when full, queues when busy, trips a breaker after
// repeated start failures, records pids, and shuts everything down.
//
// Every timer goes through the injected setTimer/clearTimer so tests can
// drive a fake clock. Never call the global setTimeout from this file
// except as the default for that injection.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolvePilotRoot, ensureUserHomeSkeleton } from '../utils/pilotPaths.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULTS = { maxInstances: 30, idleTimeoutMs: 30 * 60_000, startTimeoutMs: 60_000, maxWaiting: 20, portBase: 18800, healthyAfterMs: 5 * 60_000 };
const BREAKER_FAILURES = 3;
const BREAKER_WINDOW_MS = 10 * 60_000;
const STOP_GRACE_MS = 5_000;
const SHUTDOWN_MAX_MS = 15_000;
const CONNECT_RETRY_MS = 250;

function poolError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  return error;
}

export function defaultFindFreePort(startAt, isReserved = () => false) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (isReserved(port)) {
        if (port < 65000) tryPort(port + 1);
        else reject(new Error('No free gateway port available'));
        return;
      }
      const srv = net.createServer();
      srv.once('error', (err) => (err.code === 'EADDRINUSE' && port < 65000 ? tryPort(port + 1) : reject(err)));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    tryPort(startAt);
  });
}

/** Start times reported by `ps` are whole seconds; allow for rounding plus clock skew. */
const PID_START_SLACK_MS = 5_000;

/**
 * Describe a pid the way `reapOrphans` needs it: is it still there, what is the
 * executable called, and when did it start. `ps -o lstart=,comm=` is available
 * on both macOS and Linux. Returns null when the process is gone (or when ps is
 * unavailable, in which case we refuse to signal rather than guess).
 */
export function defaultInspectProcess(pid) {
  let result;
  try {
    result = spawnSync('ps', ['-o', 'lstart=,comm=', '-p', String(pid)], { encoding: 'utf8' });
  } catch {
    return null;
  }
  if (result.error || result.status !== 0) return null;
  const line = String(result.stdout ?? '').trim().split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  // `lstart` is a fixed 5-field date ("Tue Oct 14 20:19:30 2026"); whatever
  // follows is the command name.
  const parts = line.trim().split(/\s+/);
  if (parts.length < 6) return null;
  const startedAt = Date.parse(parts.slice(0, 5).join(' '));
  const comm = parts.slice(5).join(' ');
  return { comm, startedAtMs: Number.isNaN(startedAt) ? null : startedAt };
}

// The auth token is NOT passed through the environment: the engine reads it
// from `$PILOT_HOME/server-token`, which is exactly where `ensureToken` writes
// it (<userHome>/server-token). A documented deviation from spec §4, which
// placed it under system/.
/**
 * Environment for a pooled gateway child. `PILOTDECK_DISABLE_ALWAYS_ON` keeps
 * the shared-pilotdeck.yaml background subsystems (always-on, cron, IM) from
 * being started once per user, so it is only set in multi-user mode; in
 * no-login mode the single admin gateway keeps them.
 */
export function buildGatewayChildEnv({ env, userHome, port, configPath, multiUser = true }) {
  const childEnv = {
    ...env,
    PILOT_HOME: userHome,
    PILOTDECK_DISABLE_LOCAL_AUTH: multiUser === true ? '0' : '1',
    PILOTDECK_GATEWAY_PORT: String(port),
    PILOTDECK_CONFIG_PATH: configPath,
    // Each user's git identity lives in their own home, so a commit made by
    // this gateway is signed by its user — never by the server account's
    // ~/.gitconfig, and never by whoever saved their identity last.
    GIT_CONFIG_GLOBAL: path.join(userHome, '.gitconfig'),
  };
  if (multiUser === true) childEnv.PILOTDECK_DISABLE_ALWAYS_ON = '1';
  else delete childEnv.PILOTDECK_DISABLE_ALWAYS_ON;
  delete childEnv.PILOTDECK_GATEWAY_URL;
  return childEnv;
}

export function defaultSpawnGateway({ userHome, port, env, configPath, multiUser = true }) {
  const distEntry = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'pilotdeck.js');
  const args = fs.existsSync(distEntry)
    ? [distEntry, 'server']
    : ['--import', './scripts/register-deploy-env.mjs', '--import', 'tsx', 'src/cli/pilotdeck.ts', 'server'];
  const childEnv = buildGatewayChildEnv({ env, userHome, port, configPath, multiUser });
  return spawn(process.execPath, args, { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
}

// Loaded lazily so tests (and callers that inject their own connect) never
// pull the whole gateway client graph in.
async function defaultConnectGateway(options) {
  const { createRemoteGateway } = await import('../../../src/gateway/index.js');
  return createRemoteGateway({ ...options, clientName: 'web' });
}

export function createGatewayPool(options = {}) {
  const env = options.env ?? process.env;
  const config = { ...DEFAULTS, ...(options.config ?? {}) };
  const spawnGateway = options.spawnGateway ?? defaultSpawnGateway;
  // Multi-user by default; the bridge passes `false` in no-login mode.
  const multiUser = options.multiUser !== false;
  const connectGateway = options.connectGateway ?? defaultConnectGateway;
  const findFreePort = options.findFreePort ?? defaultFindFreePort;
  const inspectProcess = options.inspectProcess ?? defaultInspectProcess;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const log = options.log ?? console.log;

  const root = resolvePilotRoot(env);
  const pidFile = path.join(root, 'system', 'gateway-pids.json');
  const configPath = path.join(root, 'pilotdeck.yaml');

  /** userId → entry */
  const entries = new Map();
  /** Entries removed from `entries` whose child process may still be alive. */
  const stoppingEntries = new Set();
  /** Ports handed to a gateway child that is starting/running/exiting. Bind-then-close probing
   *  cannot see these until the child has bound, so concurrent starts would collide. */
  const reservedPorts = new Set();
  const isPortReserved = (port) => reservedPorts.has(port);
  function releasePort(entry) {
    if (entry.reservedPort != null) {
      reservedPorts.delete(entry.reservedPort);
      entry.reservedPort = null;
    }
  }
  /** userId → { count, until } */
  const failures = new Map();
  /** FIFO of { userId, resolve, reject } */
  const waiting = [];
  let shuttingDown = false;

  function writePidFile() {
    const data = {};
    for (const e of [...entries.values(), ...stoppingEntries]) {
      if (e.child?.pid && !e.exited) data[e.userId] = { pid: e.child.pid, port: e.port, startedAt: e.startedAt };
    }
    try {
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, JSON.stringify(data, null, 2));
    } catch (error) {
      log(`[gateway-pool] failed to write pid file: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * A pid recorded in a previous run may have been recycled by the OS and now
   * belong to something else entirely, so never signal one without checking
   * that it still looks like the gateway we recorded: same kind of process
   * (node) and started no earlier than we wrote it down.
   */
  function isReapableGatewayPid(pid, startedAt) {
    const info = inspectProcess(pid);
    if (!info) {
      log(`[gateway-pool] skipped orphan pid ${pid}: process is gone`);
      return false;
    }
    const comm = path.basename(String(info.comm ?? '').trim());
    if (!/^node/.test(comm)) {
      log(`[gateway-pool] skipped orphan pid ${pid}: not a node process (comm=${comm || 'unknown'})`);
      return false;
    }
    const recordedMs = Date.parse(String(startedAt ?? ''));
    if (!Number.isNaN(recordedMs) && info.startedAtMs != null && info.startedAtMs < recordedMs - PID_START_SLACK_MS) {
      log(`[gateway-pool] skipped orphan pid ${pid}: started before we recorded it (pid is recycled)`);
      return false;
    }
    return true;
  }

  function reapOrphans() {
    try {
      const data = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      for (const { pid, startedAt } of Object.values(data)) {
        if (!Number.isInteger(pid) || pid <= 1) continue;
        if (!isReapableGatewayPid(pid, startedAt)) continue;
        try { process.kill(pid, 'SIGTERM'); log(`[gateway-pool] reaped orphan gateway pid ${pid}`); } catch { /* already gone */ }
      }
    } catch { /* no pid file */ }
    writePidFile();
  }

  function ensureToken(userHome) {
    const tokenPath = path.join(userHome, 'server-token');
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing) {
        fs.chmodSync(tokenPath, 0o600);
        return { token: existing, tokenPath };
      }
    }
    const token = randomBytes(32).toString('base64url');
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600);
    return { token, tokenPath };
  }

  function breakerOpen(userId) {
    const f = failures.get(userId);
    return Boolean(f && f.count >= BREAKER_FAILURES && f.until > now());
  }
  function recordFailure(userId) {
    const prev = failures.get(userId);
    // An expired breaker window starts a fresh count.
    const f = prev && prev.until > now() ? prev : { count: 0, until: 0 };
    f.count += 1;
    f.until = now() + BREAKER_WINDOW_MS;
    failures.set(userId, f);
  }

  function scheduleIdleCheck(entry) {
    if (entry.idleTimer) clearTimer(entry.idleTimer);
    entry.idleTimer = setTimer(() => {
      entry.idleTimer = null;
      if (entry.leases === 0 && entries.get(entry.userId) === entry) void stopEntry(entry, 'idle-timeout');
    }, config.idleTimeoutMs);
  }

  /** Instances that still hold a slot: running ones plus ones not yet confirmed exited. */
  function liveCount() {
    return entries.size + stoppingEntries.size;
  }

  function stopEntry(entry, reason) {
    if (entry.cancelRetry) entry.cancelRetry();
    if (entry.state === 'stopping') return entry.stopped ?? Promise.resolve();
    entry.state = 'stopping';
    if (entry.idleTimer) { clearTimer(entry.idleTimer); entry.idleTimer = null; }
    if (entries.get(entry.userId) === entry) entries.delete(entry.userId);
    stoppingEntries.add(entry);
    entry.stopped = (async () => {
      try { entry.gateway?.close?.(); } catch { /* ignore */ }
      if (entry.child && !entry.exited) {
        await new Promise((resolve) => {
          const force = setTimer(() => { try { entry.child.kill('SIGKILL'); } catch { /* ignore */ } }, STOP_GRACE_MS);
          entry.child.once('exit', () => { clearTimer(force); resolve(); });
          try { entry.child.kill('SIGTERM'); } catch { clearTimer(force); resolve(); }
        });
      }
      stoppingEntries.delete(entry);
      releasePort(entry);
      writePidFile();
      log(`[gateway-pool] stopped gateway for user ${entry.userId} (${reason})`);
      drainWaiting();
    })();
    return entry.stopped;
  }

  function hasIdleInstance() {
    for (const e of entries.values()) if (e.state === 'idle') return true;
    return false;
  }

  function drainWaiting() {
    // An instance that merely turned idle (release) does not shrink the live
    // count, but `acquire` can evict it, so it counts as room too. Slots of
    // instances still being stopped stay occupied until their exit is confirmed.
    while (waiting.length && (liveCount() < config.maxInstances || hasIdleInstance())) {
      const next = waiting.shift();
      acquire(next.userId).then(next.resolve, next.reject);
    }
  }

  function pickIdleVictim() {
    let victim = null;
    for (const e of entries.values()) {
      if (e.state === 'idle' && (!victim || e.idleSince < victim.idleSince)) victim = e;
    }
    return victim;
  }

  function startEntry(userId) {
    const entry = {
      userId, state: 'starting', port: null, leases: 0, idleSince: null,
      startedAt: new Date().toISOString(), child: null, gateway: null,
      exited: false, revoked: false, idleTimer: null, starting: null, stopped: null, cancelRetry: null, reservedPort: null,
    };
    // Registered before the first await so a concurrent acquire for the same
    // user sees the `starting` entry instead of spawning a second process.
    entries.set(userId, entry);
    const run = startEntryAsync(entry);
    entry.starting = run;
    return run;
  }

  async function startEntryAsync(entry) {
    const { userId } = entry;
    // One budget for the whole start (port lookup + spawn + connect).
    let timer;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => {
        timedOut = true;
        reject(poolError('GATEWAY_START_TIMEOUT', `Gateway for user ${userId} did not become ready within ${config.startTimeoutMs}ms`));
      }, config.startTimeoutMs);
    });
    timeout.catch(() => {}); // may reject before the race below attaches
    const deadline = now() + config.startTimeoutMs;
    let url = null;

    try {
      const userHome = ensureUserHomeSkeleton(userId, env);
      let port = await Promise.race([findFreePort(config.portBase, isPortReserved), timeout]);
      // A concurrent start may have probed the same port before either child bound it.
      while (reservedPorts.has(port)) {
        if (port >= 65000) throw poolError('GATEWAY_UNAVAILABLE', 'No free gateway port available');
        port = await Promise.race([findFreePort(port + 1, isPortReserved), timeout]);
      }
      if (timedOut) throw poolError('GATEWAY_START_TIMEOUT', `Gateway for user ${userId} did not become ready within ${config.startTimeoutMs}ms`);
      // stopUser/shutdown may have landed while we awaited the port: never spawn then.
      if (entry.state === 'stopping' || shuttingDown) throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} was stopped before it started`);
      // No await between the last reservedPorts check and this add.
      reservedPorts.add(port);
      entry.reservedPort = port;
      entry.port = port;
      const { token, tokenPath } = ensureToken(userHome);

      entry.child = spawnGateway({ userId, userHome, port: entry.port, tokenPath, env, configPath, multiUser });
      if (entry.state === 'stopping') {
        // Defensive: a child that appeared after stopEntry resolved is never left running.
        try { entry.child.kill('SIGTERM'); } catch { /* ignore */ }
        throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} was stopped before it started`);
      }
      const onGone = () => {
        entry.exited = true;
        if (entries.get(userId) === entry && entry.state !== 'stopping' && entry.state !== 'starting') {
          // Unexpected exit of a ready instance. It counts towards the breaker
          // exactly like a failed start: a gateway that crashes on every first
          // request would otherwise be respawned forever.
          entry.state = 'stopping';
          if (entry.idleTimer) { clearTimer(entry.idleTimer); entry.idleTimer = null; }
          entries.delete(userId);
          releasePort(entry); // the child is gone, its port is free
          try { entry.gateway?.close?.(); } catch { /* ignore */ }
          recordFailure(userId);
          log(`[gateway-pool] gateway for user ${userId} exited unexpectedly`);
        }
        writePidFile();
        drainWaiting();
      };
      entry.child.on('exit', onGone);
      entry.child.on?.('error', (error) => {
        log(`[gateway-pool] gateway process error for user ${userId}: ${error instanceof Error ? error.message : error}`);
        if (entry.child.pid === undefined) onGone();
      });
      writePidFile();

      url = `ws://127.0.0.1:${entry.port}/ws`;
      const connect = (async () => {
        let lastError;
        while (now() < deadline) {
          if (entry.exited) throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} exited during startup`);
          if (entry.state === 'stopping') throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} was stopped during startup`);
          try {
            const gw = await connectGateway({ url, token });
            if (entry.state === 'stopping') {
              try { gw?.close?.(); } catch { /* ignore */ }
              throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} was stopped during startup`);
            }
            return gw;
          } catch (error) {
            if (error?.code === 'GATEWAY_UNAVAILABLE') throw error;
            lastError = error;
          }
          await new Promise((resolve) => {
            const t = setTimer(() => { entry.cancelRetry = null; resolve(); }, CONNECT_RETRY_MS);
            entry.cancelRetry = () => { clearTimer(t); entry.cancelRetry = null; resolve(); };
          });
        }
        throw lastError ?? poolError('GATEWAY_START_TIMEOUT', 'Gateway start timed out');
      })();
      connect.catch(() => {}); // the race may already be lost
      entry.gateway = await Promise.race([connect, timeout]);
    } catch (error) {
      const externallyStopped = entry.state === 'stopping';
      if (!externallyStopped) recordFailure(userId);
      await stopEntry(entry, 'start-failed');
      if (!entry.child || entry.exited) releasePort(entry);
      throw error?.code ? error : poolError('GATEWAY_UNAVAILABLE', error?.message ?? 'Gateway failed to start');
    } finally {
      clearTimer(timer);
    }

    if (entry.state === 'stopping') {
      // stopUser/shutdown ran while connecting.
      try { entry.gateway?.close?.(); } catch { /* ignore */ }
      throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} was stopped during startup`);
    }
    if (entry.exited) {
      recordFailure(userId);
      await stopEntry(entry, 'start-failed');
      throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} exited during startup`);
    }
    if (entry.revoked) {
      // markRevoked landed while this entry was `starting`: the lease would
      // otherwise be handed out to a user whose token was just revoked.
      await stopEntry(entry, 'revoked');
      throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} was revoked during startup`);
    }
    // A successful start does NOT clear the failure count: the breaker counts
    // failures inside BREAKER_WINDOW_MS and only the window's expiry forgets
    // them. Clearing here would make the breaker unreachable for a gateway that
    // becomes ready and then crashes on every request.
    entry.state = 'idle';
    entry.idleSince = now();
    entry.readySince = now(); // kept across busy/idle transitions; see release()
    log(`[gateway-pool] gateway ready for user ${userId} on ${url}`);
    return entry;
  }

  async function acquire(userIdRaw) {
    const userId = String(userIdRaw);
    if (breakerOpen(userId)) throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} failed repeatedly; retry later`);

    let entry;
    let evicted = false;
    for (;;) {
      if (shuttingDown) throw poolError('GATEWAY_UNAVAILABLE', 'Server is shutting down');
      entry = entries.get(userId);
      if (!entry) {
        if (liveCount() < config.maxInstances) {
          startEntry(userId);
          entry = entries.get(userId);
          await entry.starting;
        } else {
          const victim = pickIdleVictim();
          if (victim) {
            await stopEntry(victim, 'lru-evict');
            evicted = true;
            continue; // capacity and entries may have changed while stopping
          }
          // A caller that already evicted for its slot lost it to a racing acquire:
          // it goes to the head of the queue and is not rejected for queue length.
          if (evicted) return new Promise((resolve, reject) => waiting.unshift({ userId, resolve, reject }));
          if (waiting.length >= config.maxWaiting) throw poolError('GATEWAY_POOL_EXHAUSTED', 'Too many active users; please try again shortly');
          return new Promise((resolve, reject) => waiting.push({ userId, resolve, reject }));
        }
      } else if (entry.state === 'starting') {
        await entry.starting;
      }
      if (entry.state === 'idle' || entry.state === 'busy') break;
      // Stopped while we were waiting on it; look again.
      if (entries.get(userId) === entry) throw poolError('GATEWAY_UNAVAILABLE', `Gateway for user ${userId} is not available`);
    }

    entry.leases += 1;
    entry.state = 'busy';
    if (entry.idleTimer) { clearTimer(entry.idleTimer); entry.idleTimer = null; }
    let released = false;
    return {
      gateway: entry.gateway,
      runtimeId: `${userId}:${entry.port}`,
      release: () => {
        if (released) return;
        released = true;
        entry.leases -= 1;
        if (entry.leases > 0 || entry.state === 'stopping') return;
        // An instance that stayed healthy for healthyAfterMs forgives past
        // start failures; a gateway that crashes soon after becoming ready never does.
        if (entry.readySince != null && now() - entry.readySince >= config.healthyAfterMs) failures.delete(userId);
        if (entry.revoked) { void stopEntry(entry, 'revoked'); return; }
        entry.state = 'idle';
        entry.idleSince = now();
        scheduleIdleCheck(entry);
        drainWaiting();
      },
    };
  }

  function markRevoked(userIdRaw) {
    const entry = entries.get(String(userIdRaw));
    if (!entry) return;
    entry.revoked = true;
    if (entry.leases === 0 && entry.state !== 'starting') void stopEntry(entry, 'revoked');
  }

  async function stopUser(userIdRaw) {
    const entry = entries.get(String(userIdRaw));
    if (entry) await stopEntry(entry, 'stop-user');
  }

  async function shutdown() {
    shuttingDown = true;
    for (const w of waiting.splice(0)) w.reject(poolError('GATEWAY_UNAVAILABLE', 'Server is shutting down'));
    const all = [...entries.values()].map((e) => stopEntry(e, 'shutdown'));
    for (const e of stoppingEntries) if (e.stopped) all.push(e.stopped);
    let timer;
    const cap = new Promise((r) => { timer = setTimer(r, SHUTDOWN_MAX_MS); });
    try {
      await Promise.race([Promise.all(all), cap]);
    } finally {
      clearTimer(timer);
    }
    writePidFile();
  }

  function snapshot() {
    return [...entries.values()].map((e) => ({ userId: e.userId, state: e.state, port: e.port, leases: e.leases, idleSince: e.idleSince }));
  }

  reapOrphans();
  return { acquire, markRevoked, stopUser, shutdown, snapshot };
}
