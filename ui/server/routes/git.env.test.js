// @vitest-environment node
// ui/server/routes/git.env.test.js
// Every git invocation must read the *calling user's* .gitconfig, never the
// operator's global one: otherwise whoever runs the server signs every commit.
import { EventEmitter } from 'node:events';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root;
let spawnSpy;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gitenv-'));
  vi.stubEnv('PILOT_HOME', root);
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A `spawn()` stand-in that succeeds with empty output. */
function fakeChild(stdout = '') {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
}

async function createGitApp({ userId = 7, gitConfigRow = null } = {}) {
  const repo = path.join(root, 'users', String(userId), 'workspaces', 'general');
  fs.mkdirSync(repo, { recursive: true });
  spawnSpy = vi.fn((_cmd, args) => {
    const line = args.join(' ');
    if (line.includes('--is-inside-work-tree')) return fakeChild('true\n');
    if (line.includes('--show-toplevel')) return fakeChild(`${repo}\n`);
    return fakeChild('');
  });
  const childProcessMock = { spawn: spawnSpy, default: { spawn: spawnSpy } };
  vi.doMock('child_process', () => childProcessMock);
  vi.doMock('node:child_process', () => childProcessMock);
  vi.doMock('../database/db.js', () => ({
    userDb: { getGitConfig: () => gitConfigRow, updateGitConfig: () => {} },
  }));
  const { userScopeMiddleware } = await import('../middleware/userScope.js');
  const { default: gitRouter } = await import('./git.js');
  const app = express();
  app.use(express.json());
  app.use('/api/git', (req, _res, next) => { req.user = { id: userId, role: 'user' }; next(); }, userScopeMiddleware, gitRouter);
  const server = app.listen(0);
  const { port } = server.address();
  return {
    userId,
    async post(p, body) {
      const response = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    async close() { await new Promise((r) => server.close(r)); },
  };
}

describe('git routes run under the caller\'s git identity', () => {
  it('passes GIT_CONFIG_GLOBAL pointing at the user home on every git spawn', async () => {
    const app = await createGitApp({ userId: 7 });
    try {
      const res = await app.post('/api/git/commit', { project: 'general', message: 'hi', files: ['a.txt'] });
      expect(res.body).toMatchObject({ success: true });
    } finally {
      await app.close();
    }
    const expected = path.join(root, 'users', '7', '.gitconfig');
    expect(spawnSpy).toHaveBeenCalled();
    for (const call of spawnSpy.mock.calls) {
      expect(call[0]).toBe('git');
      expect(call[2].env.GIT_CONFIG_GLOBAL).toBe(expected);
    }
  });

  it('backfills the .gitconfig from the users row before committing', async () => {
    const app = await createGitApp({ userId: 7, gitConfigRow: { git_name: 'Ada', git_email: 'ada@example.com' } });
    try {
      await app.post('/api/git/commit', { project: 'general', message: 'hi', files: ['a.txt'] });
    } finally {
      await app.close();
    }
    const file = path.join(root, 'users', '7', '.gitconfig');
    expect(fs.readFileSync(file, 'utf8')).toBe('[user]\n\tname = "Ada"\n\temail = "ada@example.com"\n');
  });

  it('writes no .gitconfig when the user never set an identity (git fails honestly instead)', async () => {
    const app = await createGitApp({ userId: 7, gitConfigRow: { git_name: '', git_email: '' } });
    try {
      await app.post('/api/git/commit', { project: 'general', message: 'hi', files: ['a.txt'] });
    } finally {
      await app.close();
    }
    expect(fs.existsSync(path.join(root, 'users', '7', '.gitconfig'))).toBe(false);
  });
});
