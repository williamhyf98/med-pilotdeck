import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteStorageTargets, scanStorage } from './storage.js';

const temporaryHomes = [];

async function makePilotHome() {
    const pilotHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-storage-'));
    temporaryHomes.push(pilotHome);
    return pilotHome;
}

afterEach(async () => {
    await Promise.all(temporaryHomes.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
    ));
});

describe('storage management', () => {
    it('scans typed workspaces and archive packs without following symlinks', async () => {
        const pilotHome = await makePilotHome();
        const projectId = 'general_med-example';
        const workspace = path.join(pilotHome, 'workspaces', 'general_med', projectId);
        const archive = path.join(pilotHome, 'archives', 'projects', `${projectId}-20260831T010203Z`);
        await fs.mkdir(path.join(workspace, 'exports'), { recursive: true });
        await fs.mkdir(path.join(archive, 'inbox'), { recursive: true });
        await fs.mkdir(path.join(pilotHome, 'projects', 'general_med', projectId), { recursive: true });
        await fs.writeFile(path.join(workspace, 'exports', 'report.pdf'), Buffer.alloc(13));
        await fs.writeFile(path.join(archive, 'inbox', 'note.txt'), '12345');
        await fs.writeFile(
            path.join(pilotHome, 'projects', 'general_med', projectId, 'meta.json'),
            JSON.stringify({ displayName: '病例讨论', type: 'general_medicine' }),
        );
        await fs.symlink('/etc/passwd', path.join(workspace, 'exports', 'outside.txt'));

        const result = await scanStorage(pilotHome);

        expect(result.totals).toEqual({
            totalBytes: 18,
            workspaceBytes: 13,
            archiveBytes: 5,
        });
        expect(result.workspaces[0]).toMatchObject({
            projectId,
            displayName: '病例讨论',
            projectType: 'general_medicine',
            sizeBytes: 13,
        });
        expect(result.workspaces[0].files).toEqual([
            expect.objectContaining({ path: 'exports/report.pdf', previewKind: 'pdf' }),
        ]);
        expect(result.archives[0]).toMatchObject({
            projectId,
            archivedAt: '20260831T010203Z',
            sizeBytes: 5,
        });
    });

    it('deletes files and recreates the live workspace skeleton after group clearing', async () => {
        const pilotHome = await makePilotHome();
        const projectId = 'trauma_med-example';
        const workspace = path.join(pilotHome, 'workspaces', 'trauma_med', projectId);
        await fs.mkdir(path.join(workspace, 'exports'), { recursive: true });
        await fs.writeFile(path.join(workspace, 'exports', 'report.md'), 'report');

        const fileResult = await deleteStorageTargets([{
            kind: 'file',
            scope: 'workspace',
            groupId: projectId,
            typeKey: 'trauma_med',
            path: 'exports/report.md',
        }], pilotHome);
        expect(fileResult.failed).toEqual([]);
        await expect(fs.access(path.join(workspace, 'exports', 'report.md'))).rejects.toThrow();

        await fs.writeFile(path.join(workspace, 'exports', 'again.txt'), 'again');
        const groupResult = await deleteStorageTargets([{
            kind: 'workspace',
            scope: 'workspace',
            groupId: projectId,
            typeKey: 'trauma_med',
        }], pilotHome);
        expect(groupResult.failed).toEqual([]);
        for (const directory of ['inbox', 'exports', 'scratch']) {
            const stat = await fs.stat(path.join(workspace, directory));
            expect(stat.isDirectory()).toBe(true);
        }
        await expect(fs.access(path.join(workspace, 'exports', 'again.txt'))).rejects.toThrow();
    });

    it('rejects traversal before deleting any target', async () => {
        const pilotHome = await makePilotHome();
        const projectId = 'general_med-example';
        const workspace = path.join(pilotHome, 'workspaces', 'general_med', projectId);
        const outside = path.join(pilotHome, 'keep.txt');
        await fs.mkdir(path.join(workspace, 'exports'), { recursive: true });
        await fs.writeFile(path.join(workspace, 'exports', 'inside.txt'), 'inside');
        await fs.writeFile(outside, 'keep');

        await expect(deleteStorageTargets([
            {
                kind: 'file',
                scope: 'workspace',
                groupId: projectId,
                typeKey: 'general_med',
                path: 'exports/inside.txt',
            },
            {
                kind: 'file',
                scope: 'workspace',
                groupId: projectId,
                typeKey: 'general_med',
                path: '../../../keep.txt',
            },
        ], pilotHome)).rejects.toThrow('outside the managed storage root');

        await expect(fs.readFile(outside, 'utf8')).resolves.toBe('keep');
        await expect(fs.readFile(path.join(workspace, 'exports', 'inside.txt'), 'utf8')).resolves.toBe('inside');
    });

    it('deletes an empty archive directory as a whole', async () => {
        const pilotHome = await makePilotHome();
        const archiveId = 'general_med-empty-20260831T010203Z';
        const archive = path.join(pilotHome, 'archives', 'projects', archiveId);
        await fs.mkdir(archive, { recursive: true });

        const result = await deleteStorageTargets([{
            kind: 'archive',
            scope: 'archive',
            groupId: archiveId,
        }], pilotHome);

        expect(result.failed).toEqual([]);
        await expect(fs.access(archive)).rejects.toThrow();
    });
});
