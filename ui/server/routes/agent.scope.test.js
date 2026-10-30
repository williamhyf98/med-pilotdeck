// @vitest-environment node
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;
let tmpProject = '';

/** External API key requests must run in the key owner's user scope (spec D12). */
async function createAgentApp({ validateApiKey }) {
  const seen = { projectScope: null, chatScope: null, scopedHome: null };
  const { getUserScope } = await import('../middleware/userScope.js');
  const { resolveScopedHome } = await import('../utils/pilotPaths.js');
  vi.doMock('../database/db.js', () => ({
    userDb: { getAdminUser: vi.fn(() => ({ id: 1, role: 'admin' })) },
    apiKeysDb: { validateApiKey },
    githubTokensDb: {},
  }));
  vi.doMock('../projects.js', () => ({
    addProjectManually: vi.fn(async () => {
      seen.projectScope = getUserScope() ?? null;
      return { path: tmpProject };
    }),
  }));
  vi.doMock('../pilotdeck-bridge.js', () => ({
    runChatViaGateway: vi.fn(async () => {
      seen.chatScope = getUserScope() ?? null;
      seen.scopedHome = resolveScopedHome();
    }),
  }));
  vi.doMock('@octokit/rest', () => ({ Octokit: class {} }));
  const { default: agentRoutes } = await import('./agent.js');
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);
  return { app, seen };
}

async function post(app, headers) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ projectPath: tmpProject, message: 'hi', stream: false, cleanup: false }),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

afterEach(() => {
  if (tmpProject) fs.rmSync(tmpProject, { recursive: true, force: true });
  tmpProject = '';
  delete process.env.PILOT_HOME;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('POST /api/agent user scope', () => {
  it('runs inside the API key owner scope', async () => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scope-'));
    process.env.PILOT_HOME = path.join(tmpProject, 'root');
    const { app, seen } = await createAgentApp({
      validateApiKey: vi.fn(() => ({ id: 42, username: 'bob', api_key_id: 9 })),
    });

    const result = await post(app, { 'x-api-key': 'k' });

    expect(result.status).toBe(200);
    expect(seen.projectScope).toEqual({ userId: '42', role: 'user' });
    expect(seen.chatScope).toEqual({ userId: '42', role: 'user' });
    expect(seen.scopedHome).toBe(path.join(tmpProject, 'root', 'users', '42'));
  });

  it('rejects a missing key before any scope is established', async () => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scope-'));
    const { app, seen } = await createAgentApp({ validateApiKey: vi.fn(() => undefined) });

    const result = await post(app, {});

    expect(result.status).toBe(401);
    expect(seen.chatScope).toBeNull();
  });
});
