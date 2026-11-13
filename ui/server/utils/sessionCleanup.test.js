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
        expect(result.deleted.toolResults).toBe(false);
    });
});

// ── session tool-result cache ──────────────────────────────────────────────

describe('deleteSessionArtifacts — .pilotdeck/tool-results', () => {
    let pilotHome;

    beforeEach(async () => {
        pilotHome = await makePilotHome();
    });

    afterEach(async () => {
        await rm(pilotHome, { recursive: true, force: true });
    });

    it('removes the session tool-result dir and prunes the empty containers', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'web:s_abc';
        const { workspaceDir } = await scaffold({ pilotHome, projectId, sessionId });
        const slug = sanitizeSessionIdForTranscript(sessionId);
        const cacheDir = join(workspaceDir, '.pilotdeck', 'tool-results', slug);
        await mkdir(cacheDir, { recursive: true });
        await writeFile(join(cacheDir, 'call-1.png.b64'), 'x', 'utf8');

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.toolResults).toBe(true);
        expect(await pathExists(cacheDir)).toBe(false);
        expect(await pathExists(join(workspaceDir, '.pilotdeck'))).toBe(false);
    });

    it('keeps .pilotdeck when it still holds project skills/commands', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'web:s_abc';
        const { workspaceDir } = await scaffold({ pilotHome, projectId, sessionId });
        const slug = sanitizeSessionIdForTranscript(sessionId);
        const cacheDir = join(workspaceDir, '.pilotdeck', 'tool-results', slug);
        await mkdir(cacheDir, { recursive: true });
        const skillFile = join(workspaceDir, '.pilotdeck', 'skills', 'demo.md');
        await mkdir(join(workspaceDir, '.pilotdeck', 'skills'), { recursive: true });
        await writeFile(skillFile, '# demo', 'utf8');

        await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(await pathExists(cacheDir)).toBe(false);
        expect(await pathExists(skillFile)).toBe(true);
    });

    it('reports toolResults=false when this session never wrote a cache', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'web:s_abc';
        await scaffold({ pilotHome, projectId, sessionId });

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.toolResults).toBe(false);
    });
});

// ── session sidecar dir + rewind backups ───────────────────────────────────

describe('deleteSessionArtifacts — session dir & rewind backups', () => {
    let pilotHome;

    beforeEach(async () => {
        pilotHome = await makePilotHome();
    });

    afterEach(async () => {
        await rm(pilotHome, { recursive: true, force: true });
    });

    it('removes <chatDir>/<slug>/ (file-history + subagents)', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'web:s_abc';
        const { chatDir } = await scaffold({ pilotHome, projectId, sessionId });
        const slug = sanitizeSessionIdForTranscript(sessionId);
        const sidecar = join(chatDir, slug);
        await mkdir(join(sidecar, 'file-history'), { recursive: true });
        await writeFile(join(sidecar, 'file-history', 'abc@v1'), 'old', 'utf8');
        await mkdir(join(sidecar, 'subagents'), { recursive: true });
        await writeFile(join(sidecar, 'subagents', 'agent-1.jsonl'), '{}\n', 'utf8');

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.sessionDir).toBe(true);
        expect(await pathExists(sidecar)).toBe(false);
        expect(await pathExists(chatDir)).toBe(true);
    });

    it('removes only this session\'s rewind backups, then prunes the empty dir', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'web:s_abc';
        const { chatDir } = await scaffold({ pilotHome, projectId, sessionId });
        const slug = sanitizeSessionIdForTranscript(sessionId);
        const rewindDir = join(chatDir, '.rewind-backups');
        await mkdir(rewindDir, { recursive: true });
        const mine = join(rewindDir, `${slug}.2026-11-12T06-31-00-000Z-abcd1234.jsonl`);
        const other = join(rewindDir, 'web:s_other.2026-11-12T06-31-00-000Z-abcd1234.jsonl');
        await writeFile(mine, '{}\n', 'utf8');
        await writeFile(other, '{}\n', 'utf8');

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.rewindBackups).toBe(true);
        expect(await pathExists(mine)).toBe(false);
        expect(await pathExists(other)).toBe(true);
        expect(await pathExists(rewindDir)).toBe(true);
    });

    it('deletes the subagent transcript when relativeTranscriptPath is given', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'web:s_child';
        const { chatDir } = await scaffold({ pilotHome, projectId, sessionId, createTranscript: false });
        const parentSlug = sanitizeSessionIdForTranscript('web:s_parent');
        const relative = join(parentSlug, 'subagents', 'web:s_child.jsonl');
        const target = join(chatDir, relative);
        await mkdir(join(chatDir, parentSlug, 'subagents'), { recursive: true });
        await writeFile(target, '{}\n', 'utf8');

        const result = await deleteSessionArtifacts(projectId, sessionId, {
            pilotHome,
            relativeTranscriptPath: relative,
        });

        expect(result.deleted.transcript).toBe(true);
        expect(await pathExists(target)).toBe(false);
    });

    // 回退会在 chats/ 里留下 `<会话>.pre-rewind.jsonl`（再回退还能叠一层），
    // 会话列表把它们当"恢复残留"藏起来，所以以前删会话根本不会碰它们。
    it('deletes the .pre-rewind shadow transcripts of this session', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'web:s_abc';
        const { chatDir } = await scaffold({ pilotHome, projectId, sessionId });
        const slug = sanitizeSessionIdForTranscript(sessionId);
        const shadow = join(chatDir, `${slug}.pre-rewind.jsonl`);
        const nested = join(chatDir, `${slug}.pre-rewind.pre-rewind.jsonl`);
        await writeFile(shadow, '{}\n', 'utf8');
        await writeFile(nested, '{}\n', 'utf8');

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.rewindShadows).toBe(true);
        expect(await pathExists(shadow)).toBe(false);
        expect(await pathExists(nested)).toBe(false);
        expect(await pathExists(join(chatDir, `${slug}.jsonl`))).toBe(false);
    });

    it('does not touch another session whose id shares the prefix', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'web:s_abc';
        const { chatDir } = await scaffold({ pilotHome, projectId, sessionId });
        const slug = sanitizeSessionIdForTranscript(sessionId);
        // 前缀相同但是另一个会话 + 它的影子副本，都不能被带走。
        const other = join(chatDir, `${slug}-2.jsonl`);
        const otherShadow = join(chatDir, `${slug}-2.pre-rewind.jsonl`);
        await writeFile(other, '{}\n', 'utf8');
        await writeFile(otherShadow, '{}\n', 'utf8');

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.transcript).toBe(true);
        expect(result.deleted.rewindShadows).toBe(false);
        expect(await pathExists(other)).toBe(true);
        expect(await pathExists(otherShadow)).toBe(true);
    });

    it('rejects a relativeTranscriptPath that escapes the chat dir', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'web:s_child';
        await scaffold({ pilotHome, projectId, sessionId, createTranscript: false });

        await expect(
            deleteSessionArtifacts(projectId, sessionId, {
                pilotHome,
                relativeTranscriptPath: '../../../../etc/passwd.jsonl',
            }),
        ).rejects.toThrow('relativeTranscriptPath must point at a .jsonl');
    });

    it('removes scratch/work/<safeSegment(sessionId)> (turns left behind)', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'web:s_abc';
        const { workspaceDir } = await scaffold({ pilotHome, projectId, sessionId });
        // 与 AgentLoop.buildTurnEnvironment 的映射一致：'web:s_abc' → 'web-s_abc'
        const sessionWork = join(workspaceDir, 'scratch', 'work', 'web-s_abc');
        await mkdir(join(sessionWork, 'turn-1'), { recursive: true });
        await writeFile(join(sessionWork, 'turn-1', 'analysis.py'), 'print(1)', 'utf8');

        const result = await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(result.deleted.scratchWork).toBe(true);
        expect(await pathExists(sessionWork)).toBe(false);
        // 空的 work/ 目录也会被收掉
        expect(await pathExists(join(workspaceDir, 'scratch', 'work'))).toBe(false);
    });

    it('does not touch another session\'s scratch work dir', async () => {
        const projectId = 'general_med-clinic1';
        const sessionId = 'web:s_abc';
        const { workspaceDir } = await scaffold({ pilotHome, projectId, sessionId });
        const otherWork = join(workspaceDir, 'scratch', 'work', 'web-s_other', 'turn-9');
        await mkdir(otherWork, { recursive: true });
        await writeFile(join(otherWork, 'a.txt'), 'x', 'utf8');

        await deleteSessionArtifacts(projectId, sessionId, { pilotHome });

        expect(await pathExists(otherWork)).toBe(true);
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

    it('rejects path-like sessionIds instead of walking out of the chat dir', async () => {
        for (const sessionId of ['..', '.', '../../etc', 'a/b']) {
            await expect(
                deleteSessionArtifacts('general_med-clinic1', sessionId, { pilotHome }),
            ).rejects.toThrow('sessionId must be a single path segment');
        }
    });
});
