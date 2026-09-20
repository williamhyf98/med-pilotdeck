/**
 * Session deletion owns all three per-session data types:
 *
 *   1. Conversation History — `$PILOT_HOME/projects/<typeKey>/<projectId>/chats/<transcriptSlug>.jsonl`
 *   2. Staged uploads      — `<workspaceDir>/inbox/<transcriptSlug>/`
 *   3. Case State          — `$PILOT_HOME/memory/<typeKey>/<projectId>/cases/<caseDirSlug>/`
 *
 * Before this module, (3) was never touched, so deleting a war_trauma session
 * left an orphan case directory behind forever. The two slugs are produced by
 * deliberately incompatible sanitizers (see `pilotPaths.js`), so a caller that
 * wants to erase a session must consume both — that is why every path here is
 * derived from a single `MemoryScopeIdentity` rather than re-sanitized locally.
 *
 * Long-term Memory (EdgeClaw SQLite rows) is intentionally NOT deleted here:
 * it is project-scoped and survives individual session deletion.
 */
import fs from 'fs/promises';
import path from 'path';
import {
    resolvePilotHome,
    resolveProjectChatDir,
    resolveTypedProjectMemoryDir,
    resolveWorkspaceDirectoryForProjectName,
} from './pilotPaths.js';
import { resolveMemoryScopeIdentity, isWarTraumaScope } from './memoryIdentity.js';

/**
 * Remove a file, reporting whether it existed.
 * ENOENT is success-with-false; every other error propagates.
 */
async function unlinkIfPresent(filePath) {
    try {
        await fs.unlink(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

/**
 * Remove a directory tree, reporting whether it existed.
 *
 * `fs.rm({ force: true })` swallows ENOENT but also reports nothing, so the
 * existence probe happens first — callers need the three-way deleted map to be
 * truthful, not merely non-throwing.
 */
async function removeDirIfPresent(dirPath) {
    let existed = false;
    try {
        const stat = await fs.stat(dirPath);
        existed = stat.isDirectory();
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    if (!existed) {
        return false;
    }
    await fs.rm(dirPath, { recursive: true, force: true });
    return true;
}

/**
 * Candidate on-disk names for a session, most-current first.
 *
 * Files written before the sanitize fix used the raw sessionId verbatim, so
 * both forms are probed. Deduped because the two coincide for safe ids.
 */
function probeNames(slug, sessionId) {
    return slug === sessionId ? [slug] : [slug, sessionId];
}

/**
 * Delete every per-session artifact for one session.
 *
 * All three data types are independent: any of them may legitimately be
 * absent (a session that never uploaded anything has no inbox; a general
 * medicine project has no case directory at all). Absence is success. A real
 * failure — permissions, a file busy — throws rather than being swallowed,
 * so the caller never reports a clean delete over a partial one.
 *
 * @param {string} projectName Project name / key as supplied by the API layer.
 * @param {string} sessionId Raw session key.
 * @param {{ pilotHome?: string }} [options]
 * @returns {Promise<{
 *   deleted: { transcript: boolean, inbox: boolean, traumaCase: boolean },
 *   projectId: string,
 *   sessionId: string,
 * }>}
 */
export async function deleteSessionArtifacts(projectName, sessionId, options = {}) {
    const pilotHome = options.pilotHome ?? resolvePilotHome(process.env);
    const identity = resolveMemoryScopeIdentity({
        projectKey: projectName,
        pilotHome,
        sessionId,
    });

    // An absent/empty sessionId yields no slugs; there is nothing addressable
    // to delete and silently rm-ing a parent directory would be catastrophic.
    if (!identity.sessionId) {
        throw new Error('sessionId is required to delete session artifacts');
    }

    const { transcriptSlug, caseDirSlug, projectId } = identity;
    const deleted = { transcript: false, inbox: false, traumaCase: false };

    // ── 1. Conversation History ────────────────────────────────────────────
    const chatDir = resolveProjectChatDir(projectName, pilotHome);
    for (const name of probeNames(transcriptSlug, sessionId)) {
        if (await unlinkIfPresent(path.join(chatDir, `${name}.jsonl`))) {
            deleted.transcript = true;
        }
    }

    // ── 2. Staged uploads ──────────────────────────────────────────────────
    // Session deletion owns only the session-scoped inbox subdirectory;
    // project deletion handles the whole workspace separately.
    const workspaceDir = resolveWorkspaceDirectoryForProjectName(projectName, pilotHome);
    for (const name of probeNames(transcriptSlug, sessionId)) {
        if (await removeDirIfPresent(path.join(workspaceDir, 'inbox', name))) {
            deleted.inbox = true;
        }
    }

    // ── 3. Case State (war_trauma only) ────────────────────────────────────
    // General medicine projects have no cases/ directory; that is normal and
    // must not raise. resolveTypedProjectMemoryDir throws on untyped ids, so
    // the war-trauma guard has to come first.
    if (isWarTraumaScope(identity)) {
        const casesRoot = path.join(resolveTypedProjectMemoryDir(projectId, pilotHome), 'cases');
        for (const name of probeNames(caseDirSlug, sessionId)) {
            if (await removeDirIfPresent(path.join(casesRoot, name))) {
                deleted.traumaCase = true;
            }
        }
    }

    return { deleted, projectId, sessionId };
}
