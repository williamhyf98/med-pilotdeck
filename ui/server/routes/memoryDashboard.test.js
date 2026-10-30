import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMemoryDashboardRouter } from './memoryDashboard.js';

let dir; let server; let base;
// Stand-in for [authenticateToken, userScopeMiddleware]: a request is a session iff ?token=ok.
const requireUser = [
  (req, res, next) => (req.query.token === 'ok' ? next() : res.status(401).json({ error: 'Access denied. No token provided.', code: 'NO_TOKEN' })),
  (_req, _res, next) => next(),
];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-dash-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><script src="./app.js" type="module"></script>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'import "./dashboard-scope.js";');
  fs.writeFileSync(path.join(dir, 'dashboard-scope.js'), 'export const x = 1;');
  fs.writeFileSync(path.join(dir, 'app.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'other.html'), '<p>doc</p>');
  const app = express();
  app.use('/memory-dashboard', buildMemoryDashboardRouter({ dir, requireUser }));
  app.get('*', (_req, res) => res.type('html').send('<html>SPA SHELL</html>'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

const get = (p) => fetch(`${base}${p}`, { redirect: 'manual' });

describe('memory dashboard router', () => {
  it('serves the document only with a session', async () => {
    expect((await get('/memory-dashboard/index.html')).status).toBe(401);
    expect((await get('/memory-dashboard')).status).toBe(401);
    expect((await get('/memory-dashboard/')).status).toBe(401);
    const ok = await get('/memory-dashboard/index.html?token=ok');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('no-store');
    expect((await get('/memory-dashboard?token=ok')).status).toBe(200);
    expect((await get('/memory-dashboard/other.html')).status).toBe(401);
    expect((await get('/memory-dashboard/other.html?token=ok')).status).toBe(200);
  });

  it('serves module imports and stylesheets without a token (no Referer, no query)', async () => {
    for (const asset of ['/memory-dashboard/app.js', '/memory-dashboard/dashboard-scope.js', '/memory-dashboard/app.css']) {
      const res = await get(asset);
      expect(`${asset} -> ${res.status}`).toBe(`${asset} -> 200`);
    }
    expect((await get('/memory-dashboard/dashboard-scope.js')).headers.get('content-type')).toContain('javascript');
  });

  it('never falls through to the SPA shell for a missing asset', async () => {
    const res = await get('/memory-dashboard/missing.js');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('SPA SHELL');
  });
});
