import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { purgeExpiredArchivedUsers } from './archivedUsersRetention.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 11, 1);

function stamp(ms) {
    return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

async function exists(p) {
    try {
        await access(p);
        return true;
    } catch {
        return false;
    }
}

let root;
let homes;
let purged;

function makeOptions(overrides = {}) {
    return {
        root,
        maxAgeDays: 30,
        now: NOW,
        log: { log: () => {}, warn: () => {} },
        lookupUser: (id) => ({ id, is_active: 0 }),
        purgeUser: (id) => { purged.push(id); return 1; },
        homeFor: (id) => join(homes, String(id)),
        ...overrides,
    };
}

async function makeArchive(userId, archivedAtMs, payload = 'x') {
    const dir = join(root, `${userId}-${stamp(archivedAtMs)}`);
    await mkdir(join(dir, 'projects'), { recursive: true });
    await writeFile(join(dir, 'projects', 'note.txt'), payload);
    return dir;
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archived-retention-'));
    homes = await mkdtemp(join(tmpdir(), 'archived-homes-'));
    purged = [];
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(homes, { recursive: true, force: true });
});

describe('purgeExpiredArchivedUsers', () => {
    it('removes an archive past its TTL together with the account row', async () => {
        const dir = await makeArchive(2, NOW - 31 * DAY, 'bye');
        const result = await purgeExpiredArchivedUsers(makeOptions());

        expect(result).toMatchObject({ removedDirs: 1, removedUsers: 1 });
        expect(result.freedBytes).toBeGreaterThan(0);
        expect(await exists(dir)).toBe(false);
        expect(purged).toEqual([2]);
    });

    it('keeps an archive that has not expired yet', async () => {
        const dir = await makeArchive(3, NOW - 29 * DAY);
        const result = await purgeExpiredArchivedUsers(makeOptions());

        expect(result.removedDirs).toBe(0);
        expect(await exists(dir)).toBe(true);
        expect(purged).toEqual([]);
    });

    it('skips an account that was restored (is_active = 1)', async () => {
        const dir = await makeArchive(4, NOW - 90 * DAY);
        const result = await purgeExpiredArchivedUsers(makeOptions({
            lookupUser: () => ({ id: 4, is_active: 1 }),
        }));

        expect(result).toMatchObject({ removedDirs: 0, skipped: 1 });
        expect(await exists(dir)).toBe(true);
        expect(purged).toEqual([]);
    });

    it('skips when a live home already exists (restore in progress / conflict)', async () => {
        const dir = await makeArchive(5, NOW - 90 * DAY);
        await mkdir(join(homes, '5'), { recursive: true });
        const result = await purgeExpiredArchivedUsers(makeOptions());

        expect(result).toMatchObject({ removedDirs: 0, skipped: 1 });
        expect(await exists(dir)).toBe(true);
    });

    it('removes an orphan archive whose account row is already gone', async () => {
        const dir = await makeArchive(6, NOW - 90 * DAY);
        const result = await purgeExpiredArchivedUsers(makeOptions({ lookupUser: () => undefined }));

        expect(result).toMatchObject({ removedDirs: 1, removedUsers: 0 });
        expect(await exists(dir)).toBe(false);
        expect(purged).toEqual([]);
    });

    it('ignores directories whose name carries no valid timestamp', async () => {
        const stray = join(root, 'logs');
        await mkdir(stray, { recursive: true });
        const result = await purgeExpiredArchivedUsers(makeOptions());

        expect(result.removedDirs).toBe(0);
        expect(await exists(stray)).toBe(true);
    });

    it('is a no-op when the archive root does not exist', async () => {
        const result = await purgeExpiredArchivedUsers(makeOptions({ root: join(root, 'missing') }));
        expect(result).toMatchObject({ removedDirs: 0, removedUsers: 0, skipped: 0 });
    });
});
