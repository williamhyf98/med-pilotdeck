/**
 * One agent runtime per user.
 *
 * The PilotDeck engine resolves `PILOT_HOME` once at startup and caches
 * everything downstream of it — the project runtime registry, open
 * memory `control.sqlite` handles, the skill manager, session objects —
 * with no notion of a user anywhere in those keys. Rather than thread a
 * user through the agent loop (and risk one user's cached runtime
 * serving another's turn), each user gets their own gateway process
 * pointed at their own home. The engine stays single-tenant; isolation
 * is a property of the process boundary, which is the one boundary that
 * cannot leak by forgetting a cache key.
 *
 * This is still a pool, just a pool of per-tenant workers rather than
 * interchangeable ones: runtimes start on first use, stay warm for
 * reuse, are capped at `PILOTDECK_MAX_USER_GATEWAYS`, evict
 * least-recently-used when full, and are reaped after an idle period.
 * An install with twenty accounts does not pay for twenty runtimes
 * unless twenty people are working at once — and past the cap,
 * requests queue for a slot instead of forking more processes.
 *
 * With login disabled there is no scope, and callers get the shared
 * gateway started by `concurrently` exactly as before.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fsPromises } from 'node:fs';

import { createRemoteGateway } from '../../../src/gateway/index.js';
import { resolveGlobalPilotHome } from '../utils/pilotPaths.js';
import { getUserScope } from '../utils/userScope.js';
import { resolveUserHome } from './userHomes.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const GLOBAL_GATEWAY_URL = process.env.PILOTDECK_GATEWAY_URL || 'ws://127.0.0.1:18789/ws';
const CONNECT_TIMEOUT_MS =
  Number.parseInt(process.env.PILOTDECK_BRIDGE_TIMEOUT ?? '', 10) || 60_000;
/** A cold user gateway has to boot tsx + MCP servers; be patient. */
const USER_GATEWAY_BOOT_TIMEOUT_MS =
  Number.parseInt(process.env.PILOTDECK_USER_GATEWAY_BOOT_TIMEOUT ?? '', 10) || 180_000;
const IDLE_SHUTDOWN_MS =
  Number.parseInt(process.env.PILOTDECK_USER_GATEWAY_IDLE_MS ?? '', 10) || 30 * 60_000;
/**
 * Ceiling on live per-user runtimes. Without it a burst of sign-ins
 * would fork one agent runtime per person with nothing to stop it.
 * At capacity we evict the least-recently-used *idle* runtime; if every
 * slot is mid-turn the request waits for one to free up rather than
 * piling on more processes.
 */
const MAX_USER_GATEWAYS =
  Number.parseInt(process.env.PILOTDECK_MAX_USER_GATEWAYS ?? '', 10) || 8;
const SLOT_WAIT_TIMEOUT_MS =
  Number.parseInt(process.env.PILOTDECK_USER_GATEWAY_SLOT_TIMEOUT ?? '', 10) || 120_000;
const RETRY_INTERVAL_MS = 500;
const SLOT_POLL_INTERVAL_MS = 250;
const IDLE_SWEEP_INTERVAL_MS = 60_000;

/** @type {Map<string, GatewayEntry>} keyed by pilotHome */
const pool = new Map();
/** @type {Promise<any>|null} */
let globalGatewayPromise = null;
let idleTimer = null;

/**
 * @typedef {object} GatewayEntry
 * @property {Promise<any>} promise
 * @property {import('node:child_process').ChildProcess|null} proc
 * @property {number} port
 * @property {number} lastUsed
 * @property {number} inFlight
 * @property {string} userHome
 * @property {number} userId
 */

async function readTokenFile(tokenPath) {
  try {
    const raw = await fsPromises.readFile(tokenPath, 'utf8');
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/** Ask the OS for an unused port by binding and immediately releasing it. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
  return false;
}

/**
 * Connect to the installation-wide gateway (the one `concurrently`
 * starts). This is the pre-isolation behaviour, kept verbatim for
 * bypass mode and for background work that has no user scope.
 */
async function connectGlobalGateway() {
  const tokenPath =
    process.env.PILOTDECK_GATEWAY_TOKEN_PATH
    || path.join(resolveGlobalPilotHome(), 'server-token');
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    const token = await readTokenFile(tokenPath);
    if (token) {
      try {
        const gateway = await createRemoteGateway({
          url: GLOBAL_GATEWAY_URL,
          token,
          clientName: 'web',
        });
        console.log(`[gateway-pool] connected → ${GLOBAL_GATEWAY_URL}`);
        return gateway;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`[gateway-pool] gateway connect failed after ${CONNECT_TIMEOUT_MS}ms${detail}`);
}

/**
 * Boot a dedicated gateway for one user and connect to it.
 *
 * `PILOTDECK_GATEWAY_ROLE=user` tells the engine this is a per-user
 * runtime: it must not start channel adapters or the always-on manager,
 * because those talk to the outside world (a WeChat bot, a Feishu app)
 * and there is exactly one of each per deployment, not one per account.
 */
async function startUserGateway(userId, userHome) {
  const port = await findFreePort();
  const globalHome = resolveGlobalPilotHome();

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli/pilotdeck.ts', 'server', '--port', String(port)],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PILOT_HOME: userHome,
        PILOTDECK_CONFIG_DIR: userHome,
        PILOTDECK_GATEWAY_PORT: String(port),
        // Models / MCP / router settings stay admin-owned and shared:
        // point the per-user engine back at the installation config
        // instead of forking it N ways.
        PILOTDECK_CONFIG_PATH: path.join(globalHome, 'pilotdeck.yaml'),
        PILOTDECK_GATEWAY_ROLE: 'user',
        PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${port}/ws`,
        PILOTDECK_GATEWAY_TOKEN_PATH: path.join(userHome, 'server-token'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const tag = `[gateway:u${userId}]`;
  child.stdout?.on('data', (chunk) => process.stdout.write(`${tag} ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`${tag} ${chunk}`));
  child.on('exit', (code, signal) => {
    console.warn(`${tag} exited code=${code} signal=${signal}`);
    // Drop the entry so the next request boots a fresh runtime rather
    // than handing out a client whose socket is already dead.
    const entry = pool.get(userHome);
    if (entry?.proc === child) pool.delete(userHome);
  });

  const deadline = Date.now() + USER_GATEWAY_BOOT_TIMEOUT_MS;
  const healthy = await waitForHealth(port, deadline);
  if (!healthy) {
    child.kill('SIGTERM');
    throw new Error(`${tag} did not become healthy within ${USER_GATEWAY_BOOT_TIMEOUT_MS}ms`);
  }

  const tokenPath = path.join(userHome, 'server-token');
  let token = null;
  while (Date.now() < deadline && !token) {
    token = await readTokenFile(tokenPath);
    if (!token) await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
  if (!token) {
    child.kill('SIGTERM');
    throw new Error(`${tag} never wrote ${tokenPath}`);
  }

  const gateway = await createRemoteGateway({
    url: `ws://127.0.0.1:${port}/ws`,
    token,
    clientName: `web-u${userId}`,
  });
  console.log(`${tag} ready on port ${port} (home=${userHome})`);
  return { gateway, proc: child, port };
}

/**
 * Make room for the freshly reserved entry `self`.
 *
 * Eviction targets the least-recently-used runtime that is not mid-turn.
 * A runtime with work in flight is never killed — the user would lose
 * their answer — so when every slot is busy we wait instead. That wait
 * is the queue: past the cap, requests line up rather than forking more
 * processes.
 */
async function ensureCapacity(self) {
  const deadline = Date.now() + SLOT_WAIT_TIMEOUT_MS;
  while (pool.size > MAX_USER_GATEWAYS) {
    let victim = null;
    for (const entry of pool.values()) {
      if (entry === self || entry.inFlight > 0) continue;
      if (!victim || entry.lastUsed < victim.lastUsed) victim = entry;
    }
    if (victim) {
      console.log(
        `[gateway-pool] at capacity (${MAX_USER_GATEWAYS}); evicting idle runtime for user ${victim.userId}`,
      );
      pool.delete(victim.userHome);
      victim.proc?.kill('SIGTERM');
      continue;
    }
    if (Date.now() >= deadline) {
      pool.delete(self.userHome);
      throw new Error(
        `[gateway-pool] all ${MAX_USER_GATEWAYS} agent runtime slots are busy; retry in a moment `
        + '(raise PILOTDECK_MAX_USER_GATEWAYS if this is routine)',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SLOT_POLL_INTERVAL_MS));
  }
}

/**
 * How a runtime gets booted. Swappable so the pool's bookkeeping
 * (capacity, eviction, reuse) can be tested without paying ~15s per
 * real gateway start. Production never reassigns this.
 */
let runtimeFactory = startUserGateway;

/** @param {typeof startUserGateway | null} factory */
export function __setRuntimeFactoryForTests(factory) {
  runtimeFactory = factory ?? startUserGateway;
}

function ensureIdleSweeper() {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [home, entry] of pool) {
      if (entry.inFlight > 0) continue;
      if (now - entry.lastUsed < IDLE_SHUTDOWN_MS) continue;
      console.log(`[gateway-pool] reaping idle gateway for user ${entry.userId}`);
      pool.delete(home);
      entry.proc?.kill('SIGTERM');
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  idleTimer.unref?.();
}

/**
 * The gateway for whoever this request belongs to.
 *
 * @returns {Promise<any>} a connected gateway client
 */
export async function acquireGateway() {
  const scope = getUserScope();
  if (!scope) {
    if (!globalGatewayPromise) {
      globalGatewayPromise = connectGlobalGateway().catch((error) => {
        globalGatewayPromise = null;
        throw error;
      });
    }
    return globalGatewayPromise;
  }

  const userHome = scope.pilotHome || resolveUserHome(scope.userId);
  let entry = pool.get(userHome);
  if (!entry) {
    entry = {
      promise: null,
      proc: null,
      port: 0,
      lastUsed: Date.now(),
      inFlight: 0,
      userHome,
      userId: scope.userId,
    };
    // Reserve the slot synchronously so two concurrent requests from
    // the same user cannot each boot a runtime; capacity is settled
    // inside the promise, once the entry is already accounted for.
    pool.set(userHome, entry);
    entry.promise = ensureCapacity(entry)
      .then(() => runtimeFactory(scope.userId, userHome))
      .then(({ gateway, proc, port }) => {
        entry.proc = proc;
        entry.port = port;
        return gateway;
      })
      .catch((error) => {
        pool.delete(userHome);
        throw error;
      });
    ensureIdleSweeper();
  }
  entry.lastUsed = Date.now();
  return entry.promise;
}

/**
 * Mark a long-running operation (a chat turn) so the idle sweeper does
 * not kill the runtime mid-answer.
 *
 * @returns {() => void} release callback
 */
export function holdGateway() {
  const scope = getUserScope();
  if (!scope) return () => {};
  const entry = pool.get(scope.pilotHome);
  if (!entry) return () => {};
  entry.inFlight += 1;
  entry.lastUsed = Date.now();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    entry.lastUsed = Date.now();
  };
}

/** Drop the cached connection so the next caller reconnects. */
export function resetGatewayConnection() {
  const scope = getUserScope();
  if (!scope) {
    globalGatewayPromise = null;
    return;
  }
  pool.delete(scope.pilotHome);
}

/** Stop every per-user runtime (process shutdown). */
export function shutdownGatewayPool() {
  for (const [home, entry] of pool) {
    pool.delete(home);
    entry.proc?.kill('SIGTERM');
  }
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

/** Human-readable target for error messages. */
export function describeGatewayTarget() {
  const scope = getUserScope();
  if (!scope) return GLOBAL_GATEWAY_URL;
  const entry = pool.get(scope.pilotHome);
  return entry?.port
    ? `ws://127.0.0.1:${entry.port}/ws (user ${scope.userId})`
    : `per-user gateway for ${scope.username}`;
}

/** Diagnostics for the admin surface. */
export function describeGatewayPool() {
  return Array.from(pool.values()).map((entry) => ({
    userId: entry.userId,
    port: entry.port,
    pid: entry.proc?.pid ?? null,
    inFlight: entry.inFlight,
    idleSeconds: Math.round((Date.now() - entry.lastUsed) / 1000),
  }));
}
