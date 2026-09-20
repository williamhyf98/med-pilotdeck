/**
 * JS port of `src/context/memory/MemoryScopeIdentity.ts`.
 *
 * UI server cannot depend on the TypeScript dist output — this is a hard
 * existing constraint. Keep this file in sync with the TS original by hand.
 * The shared golden fixture at `tests/fixtures/memory-identity.golden.json`
 * is the only automated guard against the two implementations diverging; if
 * a sanitizer or resolver changes, update both files and regenerate the
 * fixture values with the probe script.
 *
 * See the TS file for the full design rationale.
 */
import {
    PROJECT_TYPE_KEYS,
    projectTypeKeyFromProjectId,
    resolveWorkspaceId,
    sanitizeSessionIdForTranscript,
    sanitizeSessionIdForCaseDir,
} from './pilotPaths.js';

/**
 * Resolve the memory scope identity for a project + optional session.
 *
 * @param {{ projectKey: string | null | undefined, pilotHome: string, sessionId?: string | null, displayName?: string | null }} input
 * @returns {{ projectId: string, projectType: string, projectTypeKey: string, projectPath?: string, sessionId?: string, transcriptSlug?: string, caseDirSlug?: string, displayName?: string }}
 */
export function resolveMemoryScopeIdentity(input) {
    const projectId = resolveWorkspaceId(input.projectKey ?? null, input.pilotHome);
    const projectTypeKey = projectTypeKeyFromProjectId(projectId)
        ?? PROJECT_TYPE_KEYS.general_medicine;
    const projectType = projectTypeKey === PROJECT_TYPE_KEYS.war_trauma
        ? 'war_trauma'
        : 'general_medicine';

    const identity = { projectId, projectType, projectTypeKey };

    // Record the raw path only when projectKey is a filesystem path (contains
    // a separator). Bare storage ids are not paths and must not be stored here.
    if (typeof input.projectKey === 'string' && input.projectKey.includes('/')) {
        identity.projectPath = input.projectKey;
    }
    if (typeof input.displayName === 'string' && input.displayName.trim()) {
        identity.displayName = input.displayName;
    }

    // Empty string sessionId is meaningless input; treat it as absent.
    // When a session is present both slugs must be produced together — a
    // caller that needs to locate all data for a session must consume both.
    if (typeof input.sessionId === 'string' && input.sessionId.length > 0) {
        identity.sessionId = input.sessionId;
        identity.transcriptSlug = sanitizeSessionIdForTranscript(input.sessionId);
        identity.caseDirSlug = sanitizeSessionIdForCaseDir(input.sessionId);
    }

    return identity;
}

/**
 * True when the identity's project is a war-trauma project (Case State only
 * exists under these projects).
 *
 * @param {{ projectTypeKey: string }} identity
 * @returns {boolean}
 */
export function isWarTraumaScope(identity) {
    return identity.projectTypeKey === PROJECT_TYPE_KEYS.war_trauma;
}
