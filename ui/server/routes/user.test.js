import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-'));
  vi.stubEnv('PILOT_HOME', root);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('user onboarding status route', () => {
  it('always reports onboarding complete (LLM setup UI removed)', async () => {
    const { request } = await createUserApp();

    const data = await request('/api/user/onboarding-status');

    expect(data).toMatchObject({
      success: true,
      hasCompletedOnboarding: true,
    });
  });
});

describe('per-user git identity', () => {
  it('writes the users row and <userHome>/.gitconfig without shelling out to git', async () => {
    const saved = [];
    const { request, spawnSpy, execSpy } = await createUserApp({
      onUpdateGitConfig: (...args) => saved.push(args),
    });

    const data = await request('/api/user/git-config', {
      method: 'POST',
      body: JSON.stringify({ gitName: 'Ada', gitEmail: 'ada@example.com' }),
    });

    expect(data).toMatchObject({ success: true, gitName: 'Ada', gitEmail: 'ada@example.com' });
    expect(saved).toEqual([[1, 'Ada', 'ada@example.com']]);
    // The server's own global git identity must never be rewritten by a user.
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();

    const gitconfig = fs.readFileSync(path.join(root, 'users', '1', '.gitconfig'), 'utf8');
    expect(gitconfig).toBe('[user]\n\tname = "Ada"\n\temail = "ada@example.com"\n');
  });

  it('refuses a name that could forge a .gitconfig section, and writes nothing', async () => {
    const saved = [];
    const { request } = await createUserApp({ onUpdateGitConfig: (...a) => saved.push(a) });

    for (const gitName of [
      'Ada\n[core]\n\tsshCommand = touch /tmp/pwned',
      'Ada\r[core]',
      'Ada [core]',
      '[core]',
      'Ada # comment',
      'Ada; sneaky',
      'A'.repeat(129),
    ]) {
      const data = await request('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail: 'ada@example.com' }),
      });
      expect(data.code).toBe('INVALID_GIT_NAME');
      expect(fs.existsSync(path.join(root, 'users', '1', '.gitconfig'))).toBe(false);
    }
    expect(saved).toEqual([]);
  });

  it('escapes quotes and backslashes in an otherwise valid name', async () => {
    const { request } = await createUserApp();
    await request('/api/user/git-config', {
      method: 'POST',
      body: JSON.stringify({ gitName: 'A "B" C\\D', gitEmail: 'ada@example.com' }),
    });
    const gitconfig = fs.readFileSync(path.join(root, 'users', '1', '.gitconfig'), 'utf8');
    expect(gitconfig).toBe('[user]\n\tname = "A \\"B\\" C\\\\D"\n\temail = "ada@example.com"\n');
  });

  it('rejects an invalid email before writing anything', async () => {
    const { request } = await createUserApp();
    const data = await request('/api/user/git-config', {
      method: 'POST',
      body: JSON.stringify({ gitName: 'Ada', gitEmail: 'nope' }),
    });
    expect(data.error).toMatch(/email/i);
    expect(fs.existsSync(path.join(root, 'users', '1', '.gitconfig'))).toBe(false);
  });

  it('backfills <userHome>/.gitconfig from the users row on GET (pre-upgrade identities)', async () => {
    const { request } = await createUserApp({ gitConfigRow: { git_name: 'A "B"', git_email: 'ada@example.com' } });

    const data = await request('/api/user/git-config');

    expect(data).toMatchObject({ success: true, gitName: 'A "B"', gitEmail: 'ada@example.com' });
    const file = path.join(root, 'users', '1', '.gitconfig');
    expect(fs.readFileSync(file, 'utf8')).toBe('[user]\n\tname = "A \\"B\\""\n\temail = "ada@example.com"\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('GET writes nothing when the users row has no identity yet', async () => {
    const { request } = await createUserApp({ gitConfigRow: { git_name: 'Ada', git_email: '' } });
    await request('/api/user/git-config');
    expect(fs.existsSync(path.join(root, 'users', '1', '.gitconfig'))).toBe(false);
  });

  it('GET returns empty strings instead of falling back to the host git identity', async () => {
    const { request, spawnSpy, execSpy } = await createUserApp();

    const data = await request('/api/user/git-config');

    expect(data).toMatchObject({ success: true, gitName: '', gitEmail: '' });
    // The only way to read the host identity is to shell out to git; never do.
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
  });
});

async function createUserApp({ onUpdateGitConfig = () => {}, gitConfigRow = null } = {}) {
  const spawnSpy = vi.fn(() => { throw new Error('git must not be spawned'); });
  const execSpy = vi.fn(() => { throw new Error('git must not be exec-ed'); });
  const childProcessMock = { spawn: spawnSpy, exec: execSpy };
  vi.doMock('child_process', () => ({ ...childProcessMock, default: childProcessMock }));
  vi.doMock('node:child_process', () => ({ ...childProcessMock, default: childProcessMock }));
  vi.doMock('../middleware/auth.js', () => ({
    authenticateToken: (req, _res, next) => { req.user = { id: 1, role: 'user' }; next(); },
  }));
  vi.doMock('../database/db.js', () => ({
    userDb: {
      getGitConfig: () => gitConfigRow,
      updateGitConfig: (...args) => onUpdateGitConfig(...args),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
  }));
  const { userScopeMiddleware } = await import('../middleware/userScope.js');
  const { default: userRouter } = await import('./user.js');
  const app = express();
  app.use(express.json());
  app.use('/api/user', (req, _res, next) => { req.user = { id: 1, role: 'user' }; next(); }, userScopeMiddleware, userRouter);

  return {
    spawnSpy,
    execSpy,
    async request(reqPath, init = {}) {
      const server = app.listen(0);
      const { port } = server.address();
      try {
        const response = await fetch(`http://127.0.0.1:${port}${reqPath}`, {
          ...init,
          headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        });
        return response.json();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
