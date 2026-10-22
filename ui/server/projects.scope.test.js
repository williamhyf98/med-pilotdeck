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
  it('persists project renames in the scoped metadata and leaves other users unchanged', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { createSystemProject, getProjects, renameProject } = await import('./projects.js');
    const alice = await runWithUserScope({ userId: 1, role: 'user' }, () =>
      createSystemProject({ displayName: '原名称', type: 'war_trauma' }));
    await runWithUserScope({ userId: 2, role: 'user' }, () =>
      createSystemProject({ displayName: '其他项目', type: 'general_medicine' }));

    await runWithUserScope({ userId: 1, role: 'user' }, () => renameProject(alice.name, ' 新名称 '));
    const metadataPath = path.join(root, 'users', '1', 'projects', 'trauma_med', alice.name, 'meta.json');
    expect(JSON.parse(fs.readFileSync(metadataPath, 'utf8'))).toMatchObject({
      displayName: '新名称', type: 'war_trauma',
    });
    expect((await runWithUserScope({ userId: 1, role: 'user' }, () => getProjects()))[0].displayName).toBe('新名称');
    expect((await runWithUserScope({ userId: 2, role: 'user' }, () => getProjects()))[0].displayName).toBe('其他项目');
    await expect(runWithUserScope({ userId: 2, role: 'user' }, () => renameProject(alice.name, '越权')))
      .rejects.toMatchObject({ code: 'project_not_found' });
    await expect(runWithUserScope({ userId: 1, role: 'user' }, () => renameProject('../1', '越权')))
      .rejects.toThrow();
    await expect(runWithUserScope({ userId: 1, role: 'user' }, () => renameProject(alice.name, '  ')))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(JSON.parse(fs.readFileSync(metadataPath, 'utf8')).displayName).toBe('新名称');
  });
  it('renames a migrated typed project whose metadata has no id', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { getProjects, renameProject } = await import('./projects.js');
    const projectId = 'general_med-older';
    const metaFile = path.join(root, 'users', '3', 'projects', 'general_med', projectId, 'meta.json');
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
    fs.writeFileSync(metaFile, JSON.stringify({ type: 'general_medicine' }));
    await runWithUserScope({ userId: 3, role: 'user' }, () => renameProject(projectId, '更新名称'));
    expect(JSON.parse(fs.readFileSync(metaFile, 'utf8'))).toEqual({
      type: 'general_medicine', displayName: '更新名称',
    });
    expect((await runWithUserScope({ userId: 3, role: 'user' }, () => getProjects()))[0].displayName)
      .toBe('更新名称');
  });
  it('creates metadata for an existing typed project that predates meta.json', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { getProjects, renameProject } = await import('./projects.js');
    const projectId = 'trauma_med-legacy';
    const projectDir = path.join(root, 'users', '3', 'projects', 'trauma_med', projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.cwd'), '../../../workspaces/trauma_med/trauma_med-legacy');
    await runWithUserScope({ userId: 3, role: 'user' }, () => renameProject(projectId, '新战创伤项目'));
    expect(JSON.parse(fs.readFileSync(path.join(projectDir, 'meta.json'), 'utf8'))).toMatchObject({
      id: projectId, type: 'war_trauma', displayName: '新战创伤项目',
    });
    expect((await runWithUserScope({ userId: 3, role: 'user' }, () => getProjects()))[0].displayName)
      .toBe('新战创伤项目');
    await expect(runWithUserScope({ userId: 3, role: 'user' }, () =>
      renameProject('general_med-does-not-exist', '不存在')))
      .rejects.toMatchObject({ code: 'project_not_found' });
  });
  it('refuses to rename through a symlink outside the current user home', async () => {
    const { runWithUserScope } = await import('./middleware/userScope.js');
    const { createSystemProject, renameProject } = await import('./projects.js');
    const other = await runWithUserScope({ userId: 2, role: 'user' }, () =>
      createSystemProject({ displayName: '其他用户项目', type: 'general_medicine' }));
    const ownProjectDir = path.join(root, 'users', '1', 'projects', 'general_med', other.name);
    fs.mkdirSync(path.dirname(ownProjectDir), { recursive: true });
    fs.symlinkSync(path.join(root, 'users', '2', 'projects', 'general_med', other.name), ownProjectDir, 'dir');
    await expect(runWithUserScope({ userId: 1, role: 'user' }, () => renameProject(other.name, '越权')))
      .rejects.toMatchObject({ code: 'PATH_OUT_OF_BOUNDS' });
    const otherMeta = path.join(root, 'users', '2', 'projects', 'general_med', other.name, 'meta.json');
    expect(JSON.parse(fs.readFileSync(otherMeta, 'utf8')).displayName).toBe('其他用户项目');
  });
  it('throws without a scope instead of using the root', async () => {
    const { getProjects } = await import('./projects.js');
    await expect(getProjects()).rejects.toMatchObject({ code: 'USER_SCOPE_MISSING' });
  });
});
