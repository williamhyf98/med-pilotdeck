import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    archivedStamp,
    findArchivedHome,
    getArchivedUserMaxAgeDays,
    invalidateArchivedUsersConfigCache,
    listArchivedHomes,
    parseArchivedHome,
} from './archivedUsers.js';

let root;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archived-users-'));
});
afterEach(async () => {
    vi.unstubAllEnvs();
    invalidateArchivedUsersConfigCache();
    await rm(root, { recursive: true, force: true });
});

describe('archived home names', () => {
    it('round-trips a timestamp through the directory name', () => {
        const at = new Date(Date.UTC(2026, 10, 12, 10, 11, 12, 345));
        const name = `7-${archivedStamp(at)}`;
        expect(name).toBe('7-2026-11-12T10-11-12-345Z');
        const parsed = parseArchivedHome(name);
        expect(parsed).toEqual({ userId: 7, archivedAt: at });
    });

    it('rejects names without the id dash, without milliseconds, or with impossible dates', () => {
        expect(parseArchivedHome('2026-11-12T10-11-12-345Z')).toBeNull();
        expect(parseArchivedHome('7-2026-11-12T10-11-12Z')).toBeNull();
        expect(parseArchivedHome('7-2026-13-12T10-11-12-345Z')).toBeNull();
        expect(parseArchivedHome('7-2026-11-32T10-11-12-345Z')).toBeNull();
        expect(parseArchivedHome('user-7-2026-11-12T10-11-12-345Z')).toBeNull();
    });

    it('does not let user 1 swallow the archive of user 12', () => {
        expect(parseArchivedHome('12-2026-11-12T10-11-12-345Z').userId).toBe(12);
        expect(parseArchivedHome('1-2026-11-12T10-11-12-345Z').userId).toBe(1);
    });
});

describe('listArchivedHomes', () => {
    it('lists directories newest-first and ignores stray files', async () => {
        await mkdir(join(root, '2-2026-11-01T00-00-00-000Z'), { recursive: true });
        await mkdir(join(root, '3-2026-11-05T00-00-00-000Z'), { recursive: true });
        await mkdir(join(root, 'notes'), { recursive: true });
        await writeFile(join(root, '.DS_Store'), '');
        await writeFile(join(root, '4-2026-11-06T00-00-00-000Z'), 'not a dir');

        const homes = await listArchivedHomes(root);
        expect(homes.map((h) => h.userId)).toEqual([3, 2]);
    });

    it('returns [] for a missing archive root', async () => {
        expect(await listArchivedHomes(join(root, 'nope'))).toEqual([]);
    });

    it('findArchivedHome picks the newest archive of that user only', async () => {
        await mkdir(join(root, '5-2026-11-01T00-00-00-000Z'), { recursive: true });
        await mkdir(join(root, '5-2026-11-09T00-00-00-000Z'), { recursive: true });
        await mkdir(join(root, '6-2026-11-09T00-00-00-000Z'), { recursive: true });

        const found = await findArchivedHome(5, root);
        expect(found.name).toBe('5-2026-11-09T00-00-00-000Z');
        expect(await findArchivedHome(9, root)).toBeNull();
    });
});

describe('getArchivedUserMaxAgeDays', () => {
    it('defaults to 30 when there is no config', async () => {
        vi.stubEnv('PILOTDECK_CONFIG_PATH', join(root, 'missing.yaml'));
        invalidateArchivedUsersConfigCache();
        expect(await getArchivedUserMaxAgeDays()).toBe(30);
    });

    it('reads multiUser.retention.archivedUserMaxAgeDays', async () => {
        const config = join(root, 'pilotdeck.yaml');
        await writeFile(config, 'multiUser:\n  retention:\n    archivedUserMaxAgeDays: 7\n');
        vi.stubEnv('PILOTDECK_CONFIG_PATH', config);
        invalidateArchivedUsersConfigCache();
        expect(await getArchivedUserMaxAgeDays()).toBe(7);
    });

    it('falls back to the default for a nonsense value', async () => {
        const config = join(root, 'pilotdeck.yaml');
        await writeFile(config, 'multiUser:\n  retention:\n    archivedUserMaxAgeDays: -3\n');
        vi.stubEnv('PILOTDECK_CONFIG_PATH', config);
        invalidateArchivedUsersConfigCache();
        expect(await getArchivedUserMaxAgeDays()).toBe(30);
    });
});
