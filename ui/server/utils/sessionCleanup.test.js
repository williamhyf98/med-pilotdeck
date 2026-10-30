import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { deleteSessionArtifacts } from './sessionCleanup.js';
import {
    sanitizeSessionIdForTranscript,
    sanitizeSessionIdForCaseDir,
} from './pilotPaths.js';

// deleteSessionArtifacts accepts { pilotHome } so all tests pass it explicitly —
// no module re-import tricks needed.

async function makePilotHome() {
    return mkdtemp(join(tmpdir(), 'sessioncleanup-test-'));
}

async function pathExists(p) {
    try {
        await access(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * Create the minimal on-disk layout for one session and return the created paths.
 *
 * Uses the real sanitizers so the created paths always match what
 * deleteSessionArtifacts will probe.
 */
async function scaffold({
    pilotHome,
    projectId,
    sessionId,
    createTranscript = true,
    createInbox = false,
    createCaseDir = false,
}) {
    const typeKey = projectId.startsWith('trauma_med') ? 'trauma_med' : 'general_med';
    const transcriptSlug = sanitizeSessionIdForTranscript(sessionId);
    const caseDirSlug = sanitizeSessionIdForCaseDir(sessionId);

    const chatDir = join(pilotHome, 'projects', typeKey, projectId, 'chats');
    await mkdir(chatDir, { recursive: true });

    const workspaceDir = join(pilotHome, 'workspaces', typeKey, projectId);
    const inboxDir = join(workspaceDir, 'inbox');

    let transcriptPath = null;
    if (createTranscript) {
        transcriptPath = join(chatDir, `${transcriptSlug}.jsonl`);
        await writeFile(transcriptPath, '{"role":"user","content":"test"}\n', 'utf8');
    }

    let inboxPath = null;
    if (createInbox) {
        inboxPath = join(inboxDir, transcriptSlug);
        await mkdir(inboxPath, { recursive: true });
        await writeFile(join(inboxPath, 'upload.dcm'), 'mock-dicom', 'utf8');
    }

    let casePath = null;
    if (createCaseDir && typeKey === 'trauma_med') {
        casePath = join(pilotHome, 'memory', typeKey, projectId, 'cases', caseDirSlug);
        await mkdir(casePath, { recursive: true });
        await writeFile(join(casePath, 'case.md'), '# Case notes', 'utf8');
    }

    return { pilotHome, chatDir, workspaceDir, inboxDir, transcriptPath, inboxPath, casePath };
}

// ── war_trauma project ──────────────────────────────────────────────────────

describe('deleteSessionArtifacts — war_trauma project (all three types)', () => {
    let pilotHome;

    beforeEach(async () => {
        pilotHome = await makePilotHome();
    });

    afterEach(async () => {
        await rm(pilotHome, { recursive: true, force: true });
    });

    it('deletes transcript, inbox, and case dir; returns deleted=true for all three', async () => {
        const projectId = 'trauma_med-demo';
        const sessionId = 'web:s_abc';

        await scaffold({ pilotHome, projectId, sessionId, createTranscript: true, createInbox: true, createCaseDir: true });

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.transcript).toBe(true);
        expect(result.deleted.inbox).toBe(true);
        expect(result.deleted.traumaCase).toBe(true);
        expect(result.projectId).toBe(projectId);
        expect(result.sessionId).toBe(sessionId);
    });

    it('succeeds when only the transcript exists (no inbox, no case dir)', async () => {
        const projectId = 'trauma_med-demo';
        const sessionId = 'session-only';

        await scaffold({ pilotHome, projectId, sessionId, createTranscript: true, createInbox: false, createCaseDir: false });

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.transcript).toBe(true);
        expect(result.deleted.inbox).toBe(false);
        expect(result.deleted.traumaCase).toBe(false);
    });

    it('succeeds when only the case dir exists (transcript already gone)', async () => {
        const projectId = 'trauma_med-demo';
        const sessionId = 'orphan-case';

        await scaffold({ pilotHome, projectId, sessionId, createTranscript: false, createInbox: false, createCaseDir: true });

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.transcript).toBe(false);
        expect(result.deleted.traumaCase).toBe(true);
    });

    it('is idempotent — second call returns all deleted=false', async () => {
        const projectId = 'trauma_med-demo';
        const sessionId = 'double-delete';

        await scaffold({ pilotHome, projectId, sessionId, createTranscript: true, createInbox: true, createCaseDir: true });

        await deleteSessionArtifacts(projectId, sessionId, { pilotHome });
        const second = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(second.deleted.transcript).toBe(false);
        expect(second.deleted.inbox).toBe(false);
        expect(second.deleted.traumaCase).toBe(false);
    });

    it('handles sessionId with spaces — transcriptSlug and caseDirSlug diverge correctly', async () => {
        const projectId = 'trauma_med-demo';
        const sessionId = '2026-09-16 case A';

        // transcriptSlug = "2026-09-16 case A" (spaces kept by transcript sanitizer)
        // caseDirSlug    = "2026-09-16_case_A" (spaces replaced by case-dir sanitizer)
        const { chatDir } = await scaffold({ pilotHome, projectId, sessionId, createTranscript: true, createCaseDir: true });

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.transcript).toBe(true);
        expect(result.deleted.traumaCase).toBe(true);

        const transcriptSlug = sanitizeSessionIdForTranscript(sessionId);
        const caseDirSlug = sanitizeSessionIdForCaseDir(sessionId);
        expect(await pathExists(join(chatDir, `${transcriptSlug}.jsonl`))).toBe(false);
        expect(
            await pathExists(join(pilotHome, 'memory', 'trauma_med', projectId, 'cases', caseDirSlug)),
        ).toBe(false);
    });
});

// ── general_med project ─────────────────────────────────────────────────────

describe('deleteSessionArtifacts — general_med project', () => {
    let pilotHome;

    beforeEach(async () => {
        pilotHome = await makePilotHome();
    });

    afterEach(async () => {
        await rm(pilotHome, { recursive: true, force: true });
    });

    it('deletes transcript, does not touch any case directory, does not throw', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'consult-001';

        await scaffold({ pilotHome, projectId, sessionId, createTranscript: true });

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.transcript).toBe(true);
        expect(result.deleted.traumaCase).toBe(false);
    });

    it('succeeds when transcript is already absent (fully empty project)', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'ghost-session';

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.transcript).toBe(false);
        expect(result.deleted.inbox).toBe(false);
        expect(result.deleted.traumaCase).toBe(false);
    });
});

// ── error handling ──────────────────────────────────────────────────────────

describe('deleteSessionArtifacts — error handling', () => {
    let pilotHome;

    beforeEach(async () => {
        pilotHome = await makePilotHome();
    });

    afterEach(async () => {
        await rm(pilotHome, { recursive: true, force: true });
    });

    it('throws when sessionId is empty string', async () => {
        await expect(
            deleteSessionArtifacts('trauma_med-demo', '', { pilotHome }),
        ).rejects.toThrow('sessionId is required');
    });
});
