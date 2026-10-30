/**
 * P7 project teardown: archive `$WS`, then remove chats/meta + project memory.
 * Kept free of gateway/UI imports so unit tests can load it directly.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
    resolveTypedProjectDir,
    resolveProjectMemoryDataDir,
    resolveWorkspaceDataRoot,
    resolveProjectArchiveDir,
    formatProjectArchiveTimestamp,
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

async function moveDirectory(sourcePath, destinationPath) {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    try {
        await fs.rename(sourcePath, destinationPath);
        return;
    } catch (error) {
        if (error?.code !== 'EXDEV') {
            throw error;
        }
    }
    await fs.cp(sourcePath, destinationPath, { recursive: true, errorOnExist: true, force: false });
    await fs.rm(sourcePath, { recursive: true, force: true });
}

async function removeDirectoryIfExists(targetPath) {
    if (!(await pathExists(targetPath))) {
        return false;
    }
    await fs.rm(targetPath, { recursive: true, force: true });
    return true;
}

/**
 * @param {{ pilotHome: string, projectId: string, force?: boolean }} input
 * @returns {Promise<{ success: boolean, projectId: string, archivePath: string | null }>}
 */
export async function archiveAndDeleteProjectStorage(input) {
    const pilotHome = input.pilotHome;
    const projectId = input.projectId;
    const force = Boolean(input.force);

    const projectDir = resolveTypedProjectDir(projectId, pilotHome);
    const legacyFlatProjectDir = path.join(pilotHome, 'projects', projectId);
    const memoryDir = resolveProjectMemoryDataDir(projectId, pilotHome);
    const workspaceDir = resolveWorkspaceDataRoot(projectId, pilotHome);

    let archivePath = null;
    if (await pathExists(workspaceDir)) {
        let candidate = resolveProjectArchiveDir(
            projectId,
            formatProjectArchiveTimestamp(),
            pilotHome,
        );
        if (await pathExists(candidate)) {
            candidate = resolveProjectArchiveDir(
                projectId,
                `${formatProjectArchiveTimestamp()}-${Date.now().toString(36)}`,
                pilotHome,
            );
        }
        try {
            await moveDirectory(workspaceDir, candidate);
            archivePath = candidate;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Failed to archive project workspace before delete (${workspaceDir} → ${candidate}): ${detail}`,
            );
        }
    }

    const removedProject = await removeDirectoryIfExists(projectDir).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            [
                `Workspace archived but project chats/meta delete failed (${projectDir}): ${detail}`,
                archivePath ? `Workspace archived at: ${archivePath}` : null,
            ].filter(Boolean).join(' '),
        );
    });

    let removedLegacyFlat = false;
    if (path.resolve(legacyFlatProjectDir) !== path.resolve(projectDir)) {
        removedLegacyFlat = await removeDirectoryIfExists(legacyFlatProjectDir).catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
                [
                    `Legacy project dir delete failed (${legacyFlatProjectDir}): ${detail}`,
                    archivePath ? `Workspace archived at: ${archivePath}` : null,
                ].filter(Boolean).join(' '),
            );
        });
    }

    let removedMemory = false;
    try {
        removedMemory = await removeDirectoryIfExists(memoryDir);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            [
                `Project chats were removed but project memory delete failed (${memoryDir}): ${detail}`,
                archivePath ? `Workspace already archived at: ${archivePath}` : null,
            ].filter(Boolean).join(' '),
        );
    }

    const success = Boolean(
        archivePath || removedProject || removedLegacyFlat || removedMemory || force,
    );
    return {
        success,
        projectId,
        archivePath,
    };
}
