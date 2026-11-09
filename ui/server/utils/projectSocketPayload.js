import { sanitizeValue } from './pathSanitization.js';

/**
 * Project listings returned by the REST API are used internally as absolute
 * paths. WebSocket project updates are a different trust boundary: send the
 * stable project id there so a browser never needs the server's filesystem
 * layout to reconcile an update.
 */
export function toSocketProjects(projects, { userId, pilotRoot }) {
    const sanitized = sanitizeValue(projects, { userId, pilotRoot });
    return sanitized.map((project, index) => {
        const source = projects[index] || {};
        const projectKey = typeof source.name === 'string' && source.name
            ? source.name
            : typeof source.projectKey === 'string' && source.projectKey
                ? source.projectKey
                : '';
        return {
            ...project,
            fullPath: projectKey,
            path: projectKey,
        };
    });
}
