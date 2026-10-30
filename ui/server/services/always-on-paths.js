import path from 'path';
import { resolveScopedHome, resolveProjectStorageId, resolveGatewayProjectKey } from '../utils/pilotPaths.js';

export function getAlwaysOnRoot(projectRoot) {
  const pilotHome = resolveScopedHome();
  const gatewayKey = resolveGatewayProjectKey(projectRoot, pilotHome);
  const projectId = resolveProjectStorageId(gatewayKey, pilotHome);
  return path.join(pilotHome, 'always-on', 'projects', projectId);
}

export function getAlwaysOnDiscoveryLockPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'locks', 'discovery.lock');
}

export function getAlwaysOnDiscoveryStatePath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'state.json');
}

export function getAlwaysOnRunHistoryPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'run-history.jsonl');
}

export function getAlwaysOnRunsDir(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'runs');
}
