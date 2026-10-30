import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePilotRoot, resolveUserHome, resolveScopedHome, ensureUserHomeSkeleton } from './pilotPaths.js';
import { runWithUserScope } from '../middleware/userScope.js';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-paths-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('user home resolution', () => {
  it('derives users/<id> under the root', () => {
    const env = { PILOT_HOME: root };
    expect(resolvePilotRoot(env)).toBe(root);
    expect(resolveUserHome(5, env)).toBe(path.join(root, 'users', '5'));
  });
  it.each(['', '../x', 'a/b', 'a\\b', null, undefined])('rejects unsafe id %j', (id) => {
    expect(() => resolveUserHome(id, { PILOT_HOME: root })).toThrow();
  });
  it('resolveScopedHome reads the current scope and fails without one', () => {
    const env = { PILOT_HOME: root };
    expect(() => resolveScopedHome(env)).toThrowError(expect.objectContaining({ code: 'USER_SCOPE_MISSING' }));
    runWithUserScope({ userId: 9, role: 'user' }, () => {
      expect(resolveScopedHome(env)).toBe(path.join(root, 'users', '9'));
    });
  });
  it('ensureUserHomeSkeleton builds the layout, marker and plugins link', () => {
    fs.mkdirSync(path.join(root, 'plugins'));
    const env = { PILOT_HOME: root };
    const home = ensureUserHomeSkeleton(4, env);
    for (const d of ['projects', 'workspaces', 'memory', 'skills', 'archives', 'logs', '.pilotdeck/tool-results', '.tmp/chat-attachments']) {
      expect(fs.statSync(path.join(home, d)).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(path.join(home, '.legacy-bundled-skills-migrated-v1'))).toBe(true);
    expect(fs.readlinkSync(path.join(home, 'plugins'))).toBe(path.join('..', '..', 'plugins'));
    expect(ensureUserHomeSkeleton(4, env)).toBe(home); // idempotent
  });
});
