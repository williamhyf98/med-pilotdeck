/**
 * Session deletion owns every per-session data type:
 *
 *   1. Conversation History — `$PILOT_HOME/projects/<typeKey>/<projectId>/chats/<transcriptSlug>.jsonl`
 *      连同回退留下的影子副本 `<transcriptSlug>.pre-rewind[.pre-rewind].jsonl`
 *   2. Staged uploads      — `<workspaceDir>/inbox/<transcriptSlug>/`
 *   3. Case State          — `$PILOT_HOME/memory/<typeKey>/<projectId>/cases/<caseDirSlug>/`
 *   4. Tool-result cache   — `<workspaceDir>/.pilotdeck/tool-results/<transcriptSlug>/`
 *      （大工具输出落盘的那份副本；删会话后没人能再读到，留着就是纯占空间）
 *   5. Session sidecar dir — `<chatDir>/<transcriptSlug>/`（`file-history` 编辑前备份 +
 *      `subagents` 子代理 transcript；只属于这一个会话）
 *   6. Rewind backups      — `<chatDir>/.rewind-backups/<transcriptSlug>.<时间戳>.jsonl`
 *      （每次回退前的**整份对话**副本，删会话不删就是隐私 + 空间双重问题）
 *   7. Scratch work dir    — `<workspaceDir>/scratch/work/<safeSegment(会话ID)>/`
 *      （本会话所有轮次的中间产物；回合结束本应已删，这里兜底清残留）
 *
 * Before this module, (3) was never touched, so deleting a war_trauma session
 * left an orphan case directory behind forever. The two slugs are produced by
 * deliberately incompatible sanitizers (see `pilotPaths.js`), so a caller that
 * wants to erase a session must consume both — that is why every path here is
 * derived from a single `MemoryScopeIdentity` rather than re-sanitized locally.
 *
 * (4) had the same problem: `ProjectSessionStorage` writes one directory per
 * session, but nothing removed it on delete. Retention (14 天) 只是兜底，
 * 会话一删这里必须立刻清干净。
 *
 * 记忆库分两层：L0（`control.sqlite` 的 `l0_sessions`，按 session_key 存**原文**）
 * 由 `services/sessionMemory.js` 在调用方删掉；L1/L2 是从 L0 提炼的项目级结论，
 * 按设计随项目存活，删单个会话不动它。
 */
import fs from 'fs/promises';
import path from 'path';
import {
    resolveScopedHome,
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
 * Remove `dirPath` only when it is empty. A non-empty directory is left alone
 * (it holds someone else's data), and a missing one is success.
 */
async function removeDirIfEmpty(dirPath) {
    try {
        await fs.rmdir(dirPath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') {
            return false;
        }
        throw error;
    }
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
 * 一个可以直接拼进路径的会话名：非空、不是 `.` / `..`、不含路径分隔符。
 *
 * 这不是洁癖：`path.join(chatDir, '..')` 会指向项目目录，后面接的是
 * `fs.rm(recursive)`，一个 `DELETE /sessions/%2e%2e` 就能把整个工作区删掉。
 */
function isSafeSessionSegment(name) {
    return typeof name === 'string'
        && name.length > 0
        && name !== '.'
        && name !== '..'
        && !name.includes('/')
        && !name.includes('\\')
        && !name.includes('\0');
}

/**
 * 与 `src/agent/loop/AgentLoop.ts` 的 `safeWorkPathSegment` 逐字符一致：
 * 每轮工作目录是 `<工作区>/scratch/work/<safe(会话ID)>/<safe(轮次ID)>`。
 * 两边一旦漂移，删会话时就找不到那个目录（有单测锁住映射）。
 */
function safeSessionWorkSegment(value) {
    const normalized = value.normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-');
    return normalized.replace(/^[-.]+|[-.]+$/g, '').slice(0, 96) || 'unknown';
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
 * @param {{
 *   pilotHome?: string,
 *   relativeTranscriptPath?: string,
 * }} [options] `relativeTranscriptPath` 只有子任务会话（background_task）用：
 *   它们的 transcript 落在 `<chatDir>/<父会话>/subagents/<id>.jsonl`，
 *   按 sessionId 推不出来，必须用调用方给的相对路径。
 * @returns {Promise<{
 *   deleted: {
 *     transcript: boolean, rewindShadows: boolean, inbox: boolean, traumaCase: boolean,
 *     toolResults: boolean, sessionDir: boolean, rewindBackups: boolean,
 *     scratchWork: boolean,
 *   },
 *   projectId: string,
 *   sessionId: string,
 * }>}
 */
export async function deleteSessionArtifacts(projectName, sessionId, options = {}) {
    const pilotHome = options.pilotHome ?? resolveScopedHome();
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
    if (!isSafeSessionSegment(identity.sessionId) || !isSafeSessionSegment(identity.transcriptSlug)) {
        throw Object.assign(new Error('sessionId must be a single path segment'), {
            code: 'INVALID_SESSION_ID',
        });
    }

    const { transcriptSlug, caseDirSlug, projectId } = identity;
    const deleted = {
        transcript: false,
        rewindShadows: false,
        inbox: false,
        traumaCase: false,
        toolResults: false,
        sessionDir: false,
        rewindBackups: false,
        scratchWork: false,
    };

    // ── 1. Conversation History ────────────────────────────────────────────
    const chatDir = resolveProjectChatDir(projectName, pilotHome);
    let chatEntries = [];
    try {
        chatEntries = await fs.readdir(chatDir);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    for (const name of probeNames(transcriptSlug, sessionId)) {
        if (await unlinkIfPresent(path.join(chatDir, `${name}.jsonl`))) {
            deleted.transcript = true;
        }
    }

    // 1a. 回退留下的“影子 transcript”。
    //     `rewindSession` 早期把回退前的整份对话另存成 `<会话>.pre-rewind.jsonl`，
    //     就放在 chats/ 里；对影子会话再回退还能叠出 `<会话>.pre-rewind.pre-rewind.jsonl`。
    //     会话列表靠 `isRecoveryArtifactSessionKey` 把它们藏起来，于是界面上看不见、
    //     删会话也不会碰 —— 等于每次回退都在磁盘上留一份完整对话副本。
    //     这里只认「同前缀 + 名字里带 pre-rewind」，避免误伤同前缀的其它会话；
    //     readdir 只读一层，`<父会话>/subagents/` 与 `.rewind-backups/` 都不在范围内。
    for (const name of probeNames(transcriptSlug, sessionId)) {
        const prefix = `${name}.`;
        for (const fileName of chatEntries) {
            if (!fileName.startsWith(prefix) || !fileName.endsWith('.jsonl')) continue;
            if (!fileName.slice(prefix.length).includes('pre-rewind')) continue;
            if (await unlinkIfPresent(path.join(chatDir, fileName))) {
                deleted.rewindShadows = true;
            }
        }
    }

    // 1b. 子任务会话：transcript 在 `<父会话>/subagents/` 下，只认调用方给的相对路径。
    //     路径必须落在 chatDir 内、必须是 .jsonl，否则宁可报错也不删。
    const relativeTranscriptPath = options.relativeTranscriptPath;
    if (typeof relativeTranscriptPath === 'string' && relativeTranscriptPath.trim()) {
        const chatRoot = path.resolve(chatDir);
        const target = path.resolve(chatRoot, relativeTranscriptPath);
        const insideChatDir = target === chatRoot || target.startsWith(`${chatRoot}${path.sep}`);
        if (!insideChatDir || !target.endsWith('.jsonl')) {
            throw Object.assign(new Error('relativeTranscriptPath must point at a .jsonl inside the project chat dir'), {
                code: 'INVALID_TRANSCRIPT_PATH',
            });
        }
        if (await unlinkIfPresent(target)) {
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

    // ── 4. Session tool-result cache ───────────────────────────────────────
    // `<workspace>/.pilotdeck/tool-results/<sessionSlug>` 存的是"超出内联预算"的
    // 大工具输出（图片 base64、长文本、大 JSON）。会话删掉之后没有任何入口
    // 能再读到它们，所以必须一起删；顺手把变空的 tool-results / .pilotdeck 收掉，
    // 但只在空的时候收 —— `.pilotdeck` 还可能是项目级 skills/commands 的载体。
    const toolResultsRoot = path.join(workspaceDir, '.pilotdeck', 'tool-results');
    for (const name of probeNames(transcriptSlug, sessionId)) {
        if (await removeDirIfPresent(path.join(toolResultsRoot, name))) {
            deleted.toolResults = true;
        }
    }
    await removeDirIfEmpty(toolResultsRoot);
    await removeDirIfEmpty(path.join(workspaceDir, '.pilotdeck'));

    // ── 5. Session sidecar dir（file-history + subagents） ─────────────────
    // 这两类目录只会被这一个会话写入；删会话后不可能再被读到。
    for (const name of probeNames(transcriptSlug, sessionId)) {
        if (await removeDirIfPresent(path.join(chatDir, name))) {
            deleted.sessionDir = true;
        }
    }

    // ── 6. Rewind backups ─────────────────────────────────────────────────
    // `<chatDir>/.rewind-backups/<slug>.<ISO 时间戳>-<rand>.jsonl`，
    // 每次回退写一份整份对话。按前缀匹配，避免碰别的会话的备份。
    const rewindDir = path.join(chatDir, '.rewind-backups');
    let rewindEntries = [];
    try {
        rewindEntries = await fs.readdir(rewindDir);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    for (const name of probeNames(transcriptSlug, sessionId)) {
        const prefix = `${name}.`;
        for (const fileName of rewindEntries) {
            if (!fileName.startsWith(prefix) || !fileName.endsWith('.jsonl')) continue;
            if (await unlinkIfPresent(path.join(rewindDir, fileName))) {
                deleted.rewindBackups = true;
            }
        }
    }
    await removeDirIfEmpty(rewindDir);

    // ── 7. 本会话的 scratch 工作目录 ───────────────────────────────────────
    // 正常回合结束会被 `scratchTurnCleanup` 删掉；这里清的是"当时没删成"的残留。
    const scratchWorkRoot = path.join(workspaceDir, 'scratch', 'work');
    const workSlugs = new Set([
        safeSessionWorkSegment(identity.sessionId),
        ...probeNames(transcriptSlug, sessionId).map(safeSessionWorkSegment),
    ]);
    for (const slug of workSlugs) {
        if (!isSafeSessionSegment(slug)) continue;
        if (await removeDirIfPresent(path.join(scratchWorkRoot, slug))) {
            deleted.scratchWork = true;
        }
    }
    await removeDirIfEmpty(scratchWorkRoot);

    return { deleted, projectId, sessionId };
}
