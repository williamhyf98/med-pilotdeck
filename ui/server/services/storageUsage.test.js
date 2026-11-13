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

describe('getUserStorageBreakdown', () => {
  it('splits inbox bytes out of the total for flat and typed workspace layouts', async () => {
    const { getUserStorageBreakdown } = await import('./storageUsage.js');
    const flatInbox = path.join(home(6), 'workspaces', 'proj-a', 'inbox', 'batch1');
    const typedInbox = path.join(home(6), 'workspaces', 'general_med', 'proj-b', 'inbox');
    fs.mkdirSync(flatInbox, { recursive: true });
    fs.mkdirSync(typedInbox, { recursive: true });
    fs.mkdirSync(path.join(home(6), 'workspaces', 'proj-a', 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(flatInbox, 'scan.csv'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(typedInbox, 'notes.txt'), Buffer.alloc(300));
    fs.writeFileSync(path.join(home(6), 'workspaces', 'proj-a', 'scratch', 'tmp.bin'), Buffer.alloc(50));
    // `inbox` as a plain file name elsewhere must not be counted.
    fs.mkdirSync(path.join(home(6), 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(home(6), 'projects', 'p', 'inbox'), Buffer.alloc(7));

    await expect(getUserStorageBreakdown(6)).resolves.toEqual({ bytes: 1357, inboxBytes: 1300 });
  });

  it('never reports more inbox bytes than total bytes', async () => {
    const { getUserStorageBreakdown } = await import('./storageUsage.js');
    const inbox = path.join(home(7), 'workspaces', 'p', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'a.bin'), Buffer.alloc(10));
    fs.writeFileSync(path.join(home(7), 'other.bin'), Buffer.alloc(10));
    const { bytes, inboxBytes } = await getUserStorageBreakdown(7);
    expect(inboxBytes).toBeLessThanOrEqual(bytes);
    expect(inboxBytes).toBe(10);
  });
});

describe('listArchivedUserBytes', () => {
  it('sums archives/users/<id>-<stamp> per user without prefix collisions', async () => {
    const { listArchivedUserBytes } = await import('./storageUsage.js');
    const archives = path.join(root, 'archives', 'users');
    fs.mkdirSync(path.join(archives, '1-2026-11-11T10-00-00-000Z'), { recursive: true });
    fs.mkdirSync(path.join(archives, '12-2026-11-11T10-00-00-000Z', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(archives, '1-2026-11-11T10-00-00-000Z', 'a.bin'), Buffer.alloc(100));
    fs.writeFileSync(path.join(archives, '12-2026-11-11T10-00-00-000Z', 'sub', 'b.bin'), Buffer.alloc(250));
    // Anything that does not look like <id>-<stamp> is ignored.
    fs.mkdirSync(path.join(archives, 'manual-copy'), { recursive: true });
    fs.writeFileSync(path.join(archives, 'manual-copy', 'c.bin'), Buffer.alloc(9));

    const byUser = await listArchivedUserBytes();
    expect(byUser.get('1')).toBe(100);
    expect(byUser.get('12')).toBe(250);
    expect(byUser.has('manual-copy')).toBe(false);
    expect([...byUser.values()].reduce((a, b) => a + b, 0)).toBe(350);
  });

  it('returns an empty map when nothing was archived yet', async () => {
    const { listArchivedUserBytes } = await import('./storageUsage.js');
    await expect(listArchivedUserBytes()).resolves.toBeInstanceOf(Map);
    expect((await listArchivedUserBytes()).size).toBe(0);
  });
});

describe('getUserTotalWarningBytes', () => {
  it('falls back to the 20 GiB design default when no config exists', async () => {
    const { getUserTotalWarningBytes, DEFAULT_USER_TOTAL_WARNING_BYTES } = await import('./storageUsage.js');
    await expect(getUserTotalWarningBytes()).resolves.toBe(DEFAULT_USER_TOTAL_WARNING_BYTES);
  });

  it('reads workspace.quota.userTotalMaxBytes from pilotdeck.yaml', async () => {
    const { getUserTotalWarningBytes } = await import('./storageUsage.js');
    fs.writeFileSync(path.join(root, 'pilotdeck.yaml'), 'workspace:\n  quota:\n    userTotalMaxBytes: 5368709120\n');
    await expect(getUserTotalWarningBytes()).resolves.toBe(5368709120);
  });

  it('ignores an unusable value', async () => {
    const { getUserTotalWarningBytes, DEFAULT_USER_TOTAL_WARNING_BYTES } = await import('./storageUsage.js');
    fs.writeFileSync(path.join(root, 'pilotdeck.yaml'), 'workspace:\n  quota:\n    userTotalMaxBytes: -1\n');
    await expect(getUserTotalWarningBytes()).resolves.toBe(DEFAULT_USER_TOTAL_WARNING_BYTES);
  });
});
