import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
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
    assertPathInUserHome,
} from './pilotPaths.js';
import { getAlwaysOnRoot } from '../services/always-on-paths.js';
import { runWithUserScope } from '../middleware/userScope.js';

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
            const systemRoot = join(root, 'pilot-home');
            const pilotHome = join(systemRoot, 'users', 'u1');
            const projectRoot = join(root, 'home', '会议纪要');
            const projectId = createCollisionResistantProjectId(projectRoot);
            mkdirSync(projectRoot, { recursive: true });
            mkdirSync(join(pilotHome, 'projects', projectId), { recursive: true });
            writeFileSync(join(pilotHome, 'projects', projectId, '.cwd'), projectRoot, 'utf8');
            process.env.PILOT_HOME = systemRoot;

            expect(runWithUserScope({ userId: 'u1', role: 'user' }, () => getAlwaysOnRoot(projectRoot))).toBe(
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

describe('assertPathInUserHome', () => {
    it('allows paths inside userHome and the home itself', () => {
        const root = mkdtempSync(join(tmpdir(), 'pd-path-ok-'));
        try {
            const userHome = join(root, 'users', '1');
            mkdirSync(join(userHome, 'projects', 'p1'), { recursive: true });
            expect(() => assertPathInUserHome(join(userHome, 'projects', 'p1'), userHome)).not.toThrow();
            expect(() => assertPathInUserHome(userHome, userHome)).not.toThrow();
            // Not-yet-existing file inside home is allowed.
            expect(() => assertPathInUserHome(join(userHome, 'projects', 'new.txt'), userHome)).not.toThrow();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects paths outside userHome, including ../ escapes and sibling homes', () => {
        const root = mkdtempSync(join(tmpdir(), 'pd-path-out-'));
        try {
            const userHome = join(root, 'users', '1');
            mkdirSync(userHome, { recursive: true });
            expect(() => assertPathInUserHome(join(root, 'users', '2', 'projects'), userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
            expect(() => assertPathInUserHome(join(root, 'system'), userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
            expect(() => assertPathInUserHome(join(userHome, '..', '2', 'projects'), userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
            expect(() => assertPathInUserHome('../2/projects', userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
            // Sibling whose name shares the home prefix must not pass.
            expect(() => assertPathInUserHome(`${userHome}2/x`, userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not echo the real root in the error message', () => {
        const root = mkdtempSync(join(tmpdir(), 'pd-path-msg-'));
        try {
            const userHome = join(root, 'users', '1');
            mkdirSync(userHome, { recursive: true });
            let caught;
            try {
                assertPathInUserHome(join(root, 'system'), userHome);
            } catch (error) {
                caught = error;
            }
            expect(caught.code).toBe('PATH_OUT_OF_BOUNDS');
            expect(caught.message).not.toContain(root);
            expect(caught.message).not.toContain(userHome);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('resolves symlinks and rejects escapes', () => {
        const tmpRoot = mkdtempSync(join(tmpdir(), 'pd-path-'));
        try {
            const userHome = join(tmpRoot, 'users', '1');
            mkdirSync(userHome, { recursive: true });
            mkdirSync(join(tmpRoot, 'system'));
            symlinkSync(join(tmpRoot, 'system'), join(userHome, 'escape'));
            expect(() => assertPathInUserHome(join(userHome, 'escape'), userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
            // A file reached through the escaping link is also outside.
            expect(() => assertPathInUserHome(join(userHome, 'escape', 'x.txt'), userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
        } finally {
            rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('rejects a dangling symlink that points outward (write would create the target)', () => {
        const tmpRoot = mkdtempSync(join(tmpdir(), 'pd-path-dangle-'));
        try {
            const userHome = join(tmpRoot, 'users', '1');
            mkdirSync(userHome, { recursive: true });
            symlinkSync(join(tmpRoot, 'system', 'new.conf'), join(userHome, 'dangling'));
            expect(() => assertPathInUserHome(join(userHome, 'dangling'), userHome)).toThrow(/PATH_OUT_OF_BOUNDS/);
        } finally {
            rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('accepts a home reached through a symlinked tmp prefix (macOS /var -> /private/var)', () => {
        const root = mkdtempSync(join(tmpdir(), 'pd-path-prefix-'));
        try {
            const userHome = join(root, 'users', '1');
            mkdirSync(join(userHome, 'projects'), { recursive: true });
            const viaRealRoot = join(realpathSync(root), 'users', '1', 'projects');
            expect(() => assertPathInUserHome(viaRealRoot, userHome)).not.toThrow();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
