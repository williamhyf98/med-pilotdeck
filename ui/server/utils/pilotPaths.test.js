import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    createCollisionResistantProjectId as createCoreCollisionId,
    createProjectId as createCoreProjectId,
    resolveProjectStorageId as resolveCoreProjectStorageId,
} from '../../../src/pilot/paths.js';
import {
    createCollisionResistantProjectId,
    createProjectId,
    resolveProjectStorageId,
    resolveWorkspaceId,
    resolveAssociatedProjectPath,
} from './pilotPaths.js';
import { getAlwaysOnRoot } from '../services/always-on-paths.js';

describe('UI project storage ID resolution', () => {
    it('resolves portable markers relative to pilot home, not process cwd', () => {
        const root = mkdtempSync(join(tmpdir(), 'portable-ui-'));
        try {
            const id = 'trauma_med-portable';
            const workspace = join(root, 'workspaces', 'trauma_med', id);
            const project = join(root, 'projects', 'trauma_med', id);
            mkdirSync(workspace, { recursive: true });
            mkdirSync(project, { recursive: true });
            writeFileSync(join(project, '.cwd'), `workspaces/trauma_med/${id}`);
            expect(resolveAssociatedProjectPath(id, root)).toBe(workspace);
            expect(resolveProjectStorageId(workspace, root)).toBe(id);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it('retains a migrated trauma workspace identity despite a stale cwd marker', () => {
        const root = mkdtempSync(join(tmpdir(), 'pilotdeck-migrated-ui-'));
        try {
            const id = 'trauma_med-demo';
            const workspace = join(root, 'workspaces', 'trauma_med', id);
            const project = join(root, 'projects', 'trauma_med', id);
            mkdirSync(workspace, { recursive: true });
            mkdirSync(project, { recursive: true });
            writeFileSync(join(project, '.cwd'), '/old-machine/workspaces/trauma_med/trauma_med-demo');
            expect(resolveWorkspaceId(workspace, root)).toBe(id);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('matches the core resolver for colliding non-ASCII workspaces', () => {
        const root = mkdtempSync(join(tmpdir(), 'pilotdeck-ui-project-id-'));
        try {
            const pilotHome = join(root, 'pilot-home');
            const projectA = join(root, 'home', '内部测试');
            const projectB = join(root, 'home', '会议纪要');
            mkdirSync(projectA, { recursive: true });
            mkdirSync(projectB, { recursive: true });

            const legacyId = createProjectId(projectA);
            const collisionId = createCollisionResistantProjectId(projectB);
            expect(createProjectId(projectB)).toBe(legacyId);

            mkdirSync(join(pilotHome, 'projects', legacyId), { recursive: true });
            writeFileSync(join(pilotHome, 'projects', legacyId, '.cwd'), projectA, 'utf8');
            mkdirSync(join(pilotHome, 'projects', collisionId), { recursive: true });
            writeFileSync(join(pilotHome, 'projects', collisionId, '.cwd'), projectB, 'utf8');

            expect(createProjectId(projectA)).toBe(createCoreProjectId(projectA));
            expect(collisionId).toBe(createCoreCollisionId(projectB));
            expect(resolveProjectStorageId(projectA, pilotHome)).toBe(legacyId);
            expect(resolveProjectStorageId(projectB, pilotHome)).toBe(collisionId);
            expect(resolveProjectStorageId(projectA, pilotHome)).toBe(
                resolveCoreProjectStorageId(projectA, pilotHome),
            );
            expect(resolveProjectStorageId(projectB, pilotHome)).toBe(
                resolveCoreProjectStorageId(projectB, pilotHome),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('matches core fallback behavior for missing and invalid markers', () => {
        const root = mkdtempSync(join(tmpdir(), 'pilotdeck-ui-project-id-fallback-'));
        try {
            const pilotHome = join(root, 'pilot-home');
            const projectRoot = join(root, 'workspace', 'ascii-project');
            mkdirSync(projectRoot, { recursive: true });

            const invalidId = createCollisionResistantProjectId(projectRoot);
            mkdirSync(join(pilotHome, 'projects', invalidId), { recursive: true });
            writeFileSync(join(pilotHome, 'projects', invalidId, '.cwd'), join(root, 'missing'), 'utf8');

            expect(resolveProjectStorageId(projectRoot, pilotHome)).toBe(createProjectId(projectRoot));
            expect(resolveProjectStorageId(projectRoot, pilotHome)).toBe(
                resolveCoreProjectStorageId(projectRoot, pilotHome),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('uses the resolved storage ID for the UI Always-On root', () => {
        const root = mkdtempSync(join(tmpdir(), 'pilotdeck-ui-always-on-root-'));
        const previousPilotHome = process.env.PILOT_HOME;
        try {
            const pilotHome = join(root, 'pilot-home');
            const projectRoot = join(root, 'home', '会议纪要');
            const projectId = createCollisionResistantProjectId(projectRoot);
            mkdirSync(projectRoot, { recursive: true });
            mkdirSync(join(pilotHome, 'projects', projectId), { recursive: true });
            writeFileSync(join(pilotHome, 'projects', projectId, '.cwd'), projectRoot, 'utf8');
            process.env.PILOT_HOME = pilotHome;

            expect(getAlwaysOnRoot(projectRoot)).toBe(
                join(pilotHome, 'always-on', 'projects', projectId),
            );
        } finally {
            if (previousPilotHome === undefined) {
                delete process.env.PILOT_HOME;
            } else {
                process.env.PILOT_HOME = previousPilotHome;
            }
            rmSync(root, { recursive: true, force: true });
        }
    });
});
