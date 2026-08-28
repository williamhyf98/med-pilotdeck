import fs from 'fs';
import path from 'path';
import {
  resolveGatewayProjectKey,
  resolvePilotHome,
  resolveTypedProjectDir,
} from './pilotPaths.js';

/** User-facing name from `projects/<typeKey>/<id>/meta.json`; '' when unknown. */
export function getProjectDisplayName(projectId, pilotHome = resolvePilotHome(process.env)) {
  if (typeof projectId !== 'string' || !projectId.trim()) return '';
  try {
    const metaPath = path.join(resolveTypedProjectDir(projectId.trim(), pilotHome), 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return typeof meta?.displayName === 'string' ? meta.displayName.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Same lookup starting from an agent cwd / `$WS` path, which is what the
 * memory dashboard passes as `projectPath`.
 */
export function getProjectDisplayNameForPath(projectKey, pilotHome = resolvePilotHome(process.env)) {
  if (typeof projectKey !== 'string' || !projectKey.trim()) return '';
  try {
    return getProjectDisplayName(resolveGatewayProjectKey(projectKey.trim(), pilotHome), pilotHome);
  } catch {
    return '';
  }
}
