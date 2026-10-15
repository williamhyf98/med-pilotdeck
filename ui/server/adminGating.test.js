// @vitest-environment node
// ui/server/adminGating.test.js
//
// The gating matrix for the API mount table. `buildApiRouter` exists so this
// table can be asserted without booting index.js (which listens, spawns
// watchers and opens a PTY server at import time).
//
// Every row of ADMIN_ONLY is a system-configuration surface: a non-admin must
// get 403 ADMIN_REQUIRED, and an admin must get anything but 403. Every row of
// USER_OK is per-user data: a plain user must still reach it.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A real provider map (the shape `/api/config/provider` reads) carrying a key
// that must never leave the server.
const CONFIG_YAML = [
  'schemaVersion: 1',
  'agent:',
  '  model: p1/m1',
  'model:',
  '  providers:',
  '    p1:',
  '      protocol: openai',
  '      url: https://example.invalid/v1',
  '      apiKey: sk-secret',
  '      headers:',
  '        Authorization: Bearer sk-hdr',
  '        X-Api-Key: sk-xhdr',
  '      models:',
  '        m1: {}',
  '',
].join('\n');

const INLINE_KEYS = [
  'agentsRuntimeConfig',
  'ccrDashboard', 'ccrHealth', 'ccrConfig', 'ccrStatsSummary', 'ccrSessionStats',
  'ccrStatsReset', 'ccrConfigPut', 'browseFilesystem', 'createFolder', 'createProjectManual',
];

let root; let server; let base; let tokens;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-'));
  fs.writeFileSync(path.join(root, 'pilotdeck.yaml'), CONFIG_YAML);
  vi.stubEnv('PILOT_HOME', root);
  vi.stubEnv('DATABASE_PATH', '');
  vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', '0');
  vi.stubEnv('PILOTDECK_ADMIN_PASSWORD', 'adminpass');
  vi.resetModules();
  vi.doMock('./services/gatewayPool.js', () => ({
    createGatewayPool: () => ({
      acquire: async () => ({
        gateway: { listProjects: async () => ({ projects: [] }), reloadConfig: async () => {} },
        release: () => {},
      }),
      markRevoked: () => {},
      shutdown: async () => {},
      snapshot: () => [],
    }),
  }));
  const db = await import('./database/db.js');
  await db.initializeDatabase();
  const { ensureAdminUser } = await import('./services/adminBootstrap.js');
  await ensureAdminUser({ userDb: db.userDb, log: () => {}, ensureHome: () => root });
  const { authenticateToken, generateToken } = await import('./middleware/auth.js');
  const { userScopeMiddleware } = await import('./middleware/userScope.js');
  const { requireAdmin } = await import('./middleware/requireAdmin.js');
  const { buildApiRouter } = await import('./apiRouter.js');

  const inline = Object.fromEntries(INLINE_KEYS.map((key) => [key, (_req, res) => res.json({})]));
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter({ authenticateToken, userScopeMiddleware, requireAdmin, inline }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const alice = db.userDb.createUser('alice', 'x', 'user');
  tokens = {
    admin: generateToken(db.userDb.getAdminUser()),
    alice: generateToken(db.userDb.getUserById(alice.id)),
  };
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

const call = (who, method, p) => fetch(`${base}${p}`, {
  method,
  headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
  body: method === 'GET' ? undefined : '{}',
});

const ADMIN_ONLY = [
  ['GET', '/api/config'], ['PUT', '/api/config'], ['GET', '/api/config/provider'], ['POST', '/api/config/reload'],
  ['GET', '/api/mcp/config'], ['GET', '/api/mcp-utils/all-servers'], ['GET', '/api/update/status'], ['GET', '/api/gateway/status'],
  ['PUT', '/api/plugins/med-tools/enable'], ['POST', '/api/plugins/install'], ['POST', '/api/plugins/med-tools/update'],
  ['DELETE', '/api/plugins/med-tools'],
  ['GET', '/api/memory/settings'], ['POST', '/api/memory/settings'],
  ['GET', '/api/ccr/dashboard'], ['GET', '/api/ccr/health'], ['GET', '/api/ccr/config'],
  ['GET', '/api/ccr/stats/summary'], ['GET', '/api/ccr/stats/sessions/s1'], ['POST', '/api/ccr/stats/reset'],
  ['PUT', '/api/ccr/config'],
  ['GET', '/api/browse-filesystem'], ['POST', '/api/create-folder'], ['POST', '/api/projects/create'],
  ['GET', '/api/admin/users'],
];

const USER_OK = [
  ['GET', '/api/plugins'],
  ['GET', '/api/agents/runtime-config'],
  ['GET', '/api/settings/api-keys'],
  ['GET', '/api/user/git-config'],
  ['GET', '/api/memory/overview'],
  ['POST', '/api/skills/list'],
  ['GET', '/api/storage'],
  ['POST', '/api/commands/list'],
];

describe('admin gating matrix', () => {
  it.each(ADMIN_ONLY)('%s %s is 403 ADMIN_REQUIRED for a user and not 403 for admin', async (method, p) => {
    const u = await call('alice', method, p);
    expect(u.status).toBe(403);
    expect((await u.json()).code).toBe('ADMIN_REQUIRED');
    expect((await call('admin', method, p)).status).not.toBe(403);
  });

  it.each(USER_OK)('%s %s stays reachable for a user', async (method, p) => {
    const res = await call('alice', method, p);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it('every mounted /api surface except /auth and /agent demands a token', async () => {
    for (const [method, p] of [...ADMIN_ONLY, ...USER_OK]) {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      expect(`${method} ${p} -> ${res.status}`).toBe(`${method} ${p} -> 401`);
    }
  });

  it('/api/auth stays public', async () => {
    const res = await fetch(`${base}/api/auth/status`);
    expect(res.status).toBe(200);
  });

  it('provider endpoint never returns the raw key, even to admin', async () => {
    const body = await (await call('admin', 'GET', '/api/config/provider?id=p1')).json();
    expect(JSON.stringify(body)).not.toContain('sk-secret');
    expect(body.hasApiKey).toBe(true);
    expect(body.provider.apiKey).toBe('********');
  });

  it('never returns an Authorization-style header value, parsed or raw', async () => {
    const body = await (await call('admin', 'GET', '/api/config')).json();
    const text = JSON.stringify(body);
    // `Authorization` does not END in a secret-looking word, so the key-suffix
    // rule alone used to let `Bearer sk-…` straight through in both views.
    expect(text).not.toContain('sk-hdr');
    expect(text).not.toContain('sk-xhdr');
    expect(text).not.toContain('sk-secret');
    expect(body.config.model.providers.p1.headers.Authorization).toBe('********');
  });

  it('a broken YAML is returned masked', async () => {
    fs.writeFileSync(path.join(root, 'pilotdeck.yaml'), 'providers:\n  - apiKey: sk-leak\n  bad: [\n');
    const body = await (await call('admin', 'GET', '/api/config')).json();
    expect(body.parseError).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('sk-leak');
  });
});
