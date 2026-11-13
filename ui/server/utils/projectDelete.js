/**
 * 删除项目 = **真删**（2026-11-12 改版）。
 *
 * 以前是"把工作区 rename 进 `archives/projects/`，chats/meta/memory 直接删"，
 * 于是同一个项目会同时存在于两处：项目列表里没了，归档里还在，30 天后才真的消失。
 * 用户明确要求简化：删项目就把它相关的东西全部删干净，不留归档、不进回收站。
 *
 * 这里只做**文件系统**这一层（且刻意不 import gateway/DB，方便单测直接加载）：
 *
 *   1. `workspaces/<类型>/<项目>/`  —— 全部会话产出（exports / inbox / scratch / .trash / .pilotdeck）
 *   2. `projects/<类型>/<项目>/`    —— meta、`.cwd`、chats（含 file-history / subagents / rewind 备份）
 *   3. `projects/<项目ID>/`         —— 旧扁平布局（存在才删）
 *   4. `memory/<类型>/<项目>/`      —— L0 sqlite + L1/L2 + cases
 *   5. `always-on/projects/<项目>/` —— 常驻任务的 runs / run-history / 锁
 *
 * 调用方（`projects.js`）负责磁盘之前的两件事：掐掉运行中的 turn、删网关里的 cron 任务。
 * 顺序很重要：**先能失败的、后不可逆的**。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
    resolveTypedProjectDir,
    resolveProjectMemoryDataDir,
    resolveWorkspaceDataRoot,
} from './pilotPaths.js';

async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function removeDirectoryIfExists(targetPath, label) {
    if (!(await pathExists(targetPath))) {
        return false;
    }
    try {
        await fs.rm(targetPath, { recursive: true, force: true });
        return true;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // 真删没有回滚垫子，所以错误必须带上"删到哪一步了"，让管理员知道还剩什么。
        throw Object.assign(new Error(`删除项目失败（${label}: ${targetPath}）：${detail}`), {
            code: 'PROJECT_PURGE_FAILED',
            stage: label,
            target: targetPath,
        });
    }
}

/**
 * @param {{ pilotHome: string, projectId: string, force?: boolean }} input
 * @returns {Promise<{
 *   success: boolean,
 *   projectId: string,
 *   deleted: {
 *     workspace: boolean, projectDir: boolean, legacyProjectDir: boolean,
 *     memory: boolean, alwaysOn: boolean,
 *   },
 * }>}
 */
export async function purgeProjectStorage(input) {
    const { pilotHome, projectId } = input;
    const force = Boolean(input.force);

    if (typeof projectId !== 'string' || !projectId || projectId.includes('/') || projectId.includes('\\') || projectId === '.' || projectId === '..') {
        throw Object.assign(new Error('Invalid projectId for purge'), { code: 'INVALID_PROJECT_ID' });
    }

    const workspaceDir = resolveWorkspaceDataRoot(projectId, pilotHome);
    const projectDir = resolveTypedProjectDir(projectId, pilotHome);
    const legacyFlatProjectDir = path.join(pilotHome, 'projects', projectId);
    const memoryDir = resolveProjectMemoryDataDir(projectId, pilotHome);
    const alwaysOnDir = path.join(pilotHome, 'always-on', 'projects', projectId);

    const deleted = {
        workspace: await removeDirectoryIfExists(workspaceDir, 'workspace'),
        projectDir: await removeDirectoryIfExists(projectDir, 'project'),
        legacyProjectDir: false,
        memory: await removeDirectoryIfExists(memoryDir, 'memory'),
        alwaysOn: await removeDirectoryIfExists(alwaysOnDir, 'always-on'),
    };
    if (path.resolve(legacyFlatProjectDir) !== path.resolve(projectDir)) {
        deleted.legacyProjectDir = await removeDirectoryIfExists(legacyFlatProjectDir, 'legacy-project');
    }

    const success = Boolean(
        force
        || deleted.workspace
        || deleted.projectDir
        || deleted.legacyProjectDir
        || deleted.memory
        || deleted.alwaysOn,
    );
    return { success, projectId, deleted };
}
