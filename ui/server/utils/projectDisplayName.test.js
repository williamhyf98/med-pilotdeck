import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getProjectDisplayName,
  getProjectDisplayNameForPath,
} from './projectDisplayName.js';

async function createTypedProject(displayName) {
  const pilotHome = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-project-name-'));
  const projectId = 'trauma_med-test-project';
  const projectDir = path.join(pilotHome, 'projects', 'trauma_med', projectId);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, 'meta.json'),
    JSON.stringify({ id: projectId, displayName, type: 'war_trauma' }),
    'utf8',
  );
  return {
    pilotHome,
    projectId,
    workspacePath: path.join(pilotHome, 'workspaces', 'trauma_med', projectId),
  };
}

describe('project display names', () => {
  it('reads the user-facing name from typed project metadata', async () => {
    const { pilotHome, projectId } = await createTypedProject('战创伤');
    try {
      expect(getProjectDisplayName(projectId, pilotHome)).toBe('战创伤');
    } finally {
      await rm(pilotHome, { recursive: true, force: true });
    }
  });

  it('resolves the name from a workspace path, as the memory dashboard passes it', async () => {
    const { pilotHome, workspacePath } = await createTypedProject('战创伤');
    try {
      expect(getProjectDisplayNameForPath(workspacePath, pilotHome)).toBe('战创伤');
    } finally {
      await rm(pilotHome, { recursive: true, force: true });
    }
  });

  it('returns an empty name when metadata is unavailable', () => {
    expect(getProjectDisplayName('general_med-missing', '/missing/pilot-home')).toBe('');
    expect(getProjectDisplayNameForPath('', '/missing/pilot-home')).toBe('');
  });
});
