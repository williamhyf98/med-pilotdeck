import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidUiPreferences,
  readUserUiPreferences,
  updateUserUiPreferences,
} from './userUiPreferences.js';

let root;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-ui-preferences-'));
  vi.stubEnv('PILOT_HOME', root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('per-user UI preferences', () => {
  it('creates a private file, merges concurrent patches, and keeps accounts separate', async () => {
    expect(await readUserUiPreferences(1)).toBeNull();
    await Promise.all([
      updateUserUiPreferences(1, { themeMode: 'dark' }),
      updateUserUiPreferences(1, { projectSortOrder: 'date' }),
    ]);
    await updateUserUiPreferences(2, { themeMode: 'light' });

    expect(await readUserUiPreferences(1)).toEqual({ themeMode: 'dark', projectSortOrder: 'date' });
    expect(await readUserUiPreferences(2)).toEqual({ themeMode: 'light' });
    const file = path.join(root, 'users', '1', 'ui-preferences.json');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      version: 1, preferences: { themeMode: 'dark', projectSortOrder: 'date' },
    });
  });

  it('rejects unknown and invalid values without changing the saved file', async () => {
    await updateUserUiPreferences(1, { themeMode: 'warm' });
    await expect(updateUserUiPreferences(1, { themeMode: 'invalid' })).rejects.toBeInstanceOf(InvalidUiPreferences);
    await expect(updateUserUiPreferences(1, { 'other-user': 2 })).rejects.toBeInstanceOf(InvalidUiPreferences);
    expect(await readUserUiPreferences(1)).toEqual({ themeMode: 'warm' });
  });

  it('rejects a symlink at the user home or preferences file', async () => {
    const home = path.join(root, 'users', '1');
    await fs.mkdir(home, { recursive: true });
    await fs.symlink(path.join(root, 'users', '2'), path.join(home, 'ui-preferences.json'));
    await expect(readUserUiPreferences(1)).rejects.toThrow('Invalid preferences file');
    await fs.rm(home, { recursive: true });
    await fs.symlink(root, home);
    await expect(updateUserUiPreferences(1, { themeMode: 'warm' })).rejects.toThrow('Invalid user home');
  });
});
