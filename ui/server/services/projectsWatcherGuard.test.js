import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canRefreshProjectsFor } from './projectsWatcherGuard.js';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-watch-guard-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const dbWith = (rows) => ({ getUserById: (id) => rows[id] ?? null });

describe('canRefreshProjectsFor', () => {
  it('refreshes an active user whose home exists', () => {
    fs.mkdirSync(path.join(root, 'users', '7'), { recursive: true });
    expect(canRefreshProjectsFor('7', { userDb: dbWith({ 7: { id: 7, is_active: 1 } }), env: { PILOT_HOME: root } })).toBe(true);
  });

  it('skips a user whose home was archived away (the delete tail)', () => {
    // No users/7 on disk: the rename into archives/users already happened.
    expect(canRefreshProjectsFor('7', { userDb: dbWith({ 7: { id: 7, is_active: 0 } }), env: { PILOT_HOME: root } })).toBe(false);
  });

  it('skips a disabled user even when the home still exists', () => {
    fs.mkdirSync(path.join(root, 'users', '7'), { recursive: true });
    expect(canRefreshProjectsFor('7', { userDb: dbWith({ 7: { id: 7, is_active: 0 } }), env: { PILOT_HOME: root } })).toBe(false);
  });

  it('skips unknown accounts and non-numeric path segments', () => {
    fs.mkdirSync(path.join(root, 'users', '7'), { recursive: true });
    expect(canRefreshProjectsFor('7', { userDb: dbWith({}), env: { PILOT_HOME: root } })).toBe(false);
    expect(canRefreshProjectsFor('.DS_Store', { userDb: dbWith({}), env: { PILOT_HOME: root } })).toBe(false);
    expect(canRefreshProjectsFor('-1', { userDb: dbWith({}), env: { PILOT_HOME: root } })).toBe(false);
  });
});
