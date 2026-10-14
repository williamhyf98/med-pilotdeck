import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-proj-'));
  vi.stubEnv('PILOT_HOME', root);
  vi.resetModules();
  vi.doMock('./pilotdeck-bridge.js', () => ({ getPilotDeckGateway: async () => ({ listProjects: async () => ({ projects: [] }), listSessions: async () => ({ sessions: [] }) }) }));
  vi.doMock('./database/db.js', () => ({
    sessionNamesDb: { getNames: () => new Map(), setName: () => {}, deleteName: () => true, getName: () => null },
    applyCustomSessionNames: () => {},
  }));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('projects.js under user scope', () => {
  it('creates system projects inside the scoped user home', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { createSystemProject } = await import('./projects.js');
    const created = await runWithUserScope({ userId: 11, role: 'user' }, () => createSystemProject({ displayName: '病例一', type: 'general_medicine' }));
    const dir = path.join(root, 'users', '11', 'projects', 'general_med', created.name);
    expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'projects'))).toBe(false);
  });
  it('lists only the scoped user\'s projects', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { createSystemProject, getProjects } = await import('./projects.js');
    await runWithUserScope({ userId: 1, role: 'user' }, () => createSystemProject({ displayName: 'A', type: 'general_medicine' }));
    await runWithUserScope({ userId: 2, role: 'user' }, () => createSystemProject({ displayName: 'B', type: 'general_medicine' }));
    const forA = await runWithUserScope({ userId: 1, role: 'user' }, () => getProjects());
    expect(forA.map((p) => p.displayName)).toEqual(['A']);
    const forB = await runWithUserScope({ userId: 2, role: 'user' }, () => getProjects());
    expect(forB.map((p) => p.displayName)).toEqual(['B']);
  });
  it('throws without a scope instead of using the root', async () => {
    const { getProjects } = await import('./projects.js');
    await expect(getProjects()).rejects.toMatchObject({ code: 'USER_SCOPE_MISSING' });
  });
});
