// @vitest-environment node
// ui/server/services/storageUsage.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root; let outside;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-usage-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-usage-out-'));
  vi.stubEnv('PILOT_HOME', root);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const home = (id) => path.join(root, 'users', String(id));

describe('getUserStorageBytes', () => {
  it('sums the files under the user home, including nested directories', async () => {
    const { getUserStorageBytes } = await import('./storageUsage.js');
    fs.mkdirSync(path.join(home(1), 'projects', 'a'), { recursive: true });
    fs.writeFileSync(path.join(home(1), 'projects', 'a', 'big.bin'), Buffer.alloc(4096));
    fs.writeFileSync(path.join(home(1), 'note.txt'), 'hello');
    expect(await getUserStorageBytes(1)).toBe(4096 + 5);
  });

  it('counts a symlink as the link itself, not the 1 MB tree it points at', async () => {
    const { getUserStorageBytes } = await import('./storageUsage.js');
    // ensureUserHomeSkeleton creates exactly this kind of link for the shared
    // plugins directory; following it would both inflate the figure and let the
    // walk escape the user's home.
    fs.mkdirSync(home(2), { recursive: true });
    fs.writeFileSync(path.join(outside, 'huge.bin'), Buffer.alloc(1024 * 1024));
    fs.symlinkSync(outside, path.join(home(2), 'elsewhere'), 'dir');
    fs.symlinkSync(path.join(outside, 'huge.bin'), path.join(home(2), 'huge-link'));

    const bytes = await getUserStorageBytes(2);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1024 * 1024);
  });

  it('returns 0 for a home that does not exist', async () => {
    const { getUserStorageBytes } = await import('./storageUsage.js');
    expect(await getUserStorageBytes(404)).toBe(0);
  });

  it('tolerates an entry that vanishes mid-walk', async () => {
    const { getUserStorageBytes, invalidateStorageCache } = await import('./storageUsage.js');
    fs.mkdirSync(home(3), { recursive: true });
    fs.writeFileSync(path.join(home(3), 'keep.txt'), 'abc');
    fs.symlinkSync(path.join(outside, 'gone.bin'), path.join(home(3), 'dangling'));
    invalidateStorageCache(3);
    await expect(getUserStorageBytes(3)).resolves.toBeGreaterThanOrEqual(3);
  });

  it('caches for 60 s per user and invalidates on demand', async () => {
    const { getUserStorageBytes, invalidateStorageCache } = await import('./storageUsage.js');
    fs.mkdirSync(home(4), { recursive: true });
    fs.writeFileSync(path.join(home(4), 'a.txt'), 'abc');
    let clock = 1_000_000;
    const now = () => clock;

    expect(await getUserStorageBytes(4, { now })).toBe(3);
    fs.writeFileSync(path.join(home(4), 'b.txt'), 'defgh');
    expect(await getUserStorageBytes(4, { now })).toBe(3); // still cached

    clock += 60_001;
    expect(await getUserStorageBytes(4, { now })).toBe(8);

    fs.writeFileSync(path.join(home(4), 'c.txt'), 'ij');
    expect(await getUserStorageBytes(4, { now })).toBe(8);
    invalidateStorageCache(4);
    expect(await getUserStorageBytes(4, { now })).toBe(10);

    // The cache is per user: another id is unaffected by the entry above.
    expect(await getUserStorageBytes(5, { now })).toBe(0);
  });
});
