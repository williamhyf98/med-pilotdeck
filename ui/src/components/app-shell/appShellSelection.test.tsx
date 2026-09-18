// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Project } from '../../types/app';
import {
  chooseDefaultProject,
  findMostRecentProject,
  findMostRecentSessionTarget,
  filterProjectsByType,
  resolveProjectType,
  shouldPreserveTabOnSessionSelection,
} from './appShellSelection';

const virtualGeneral: Project = {
  name: 'general',
  displayName: 'general',
  fullPath: '/workspace/general',
};

const generalMed: Project = {
  name: 'general_med-demo',
  displayName: '门诊随访',
  fullPath: '/ws/general_med-demo',
  projectType: 'general_medicine',
};

const traumaMed: Project = {
  name: 'trauma_med-demo',
  displayName: '战创伤演练',
  fullPath: '/ws/trauma_med-demo',
  type: 'war_trauma',
};

const legacyGeneral: Project = {
  name: 'general_med-legacy-general',
  displayName: '历史通用对话',
  fullPath: '/ws/general_med-legacy-general',
};

describe('resolveProjectType', () => {
  it('reads projectType / type fields', () => {
    expect(resolveProjectType(generalMed)).toBe('general_medicine');
    expect(resolveProjectType(traumaMed)).toBe('war_trauma');
  });

  it('falls back to id prefix', () => {
    expect(resolveProjectType(legacyGeneral)).toBe('general_medicine');
    expect(resolveProjectType({
      name: 'trauma_med-x',
      displayName: 'x',
      fullPath: '/x',
    })).toBe('war_trauma');
  });

  it('returns null for unknown projects', () => {
    expect(resolveProjectType({
      name: 'linked-repo',
      displayName: 'Repo',
      fullPath: '/repo',
    })).toBeNull();
  });
});

describe('filterProjectsByType', () => {
  it('filters by type and drops virtual general', () => {
    const list = [virtualGeneral, generalMed, traumaMed, legacyGeneral];
    expect(filterProjectsByType(list, 'general_medicine').map((p) => p.name)).toEqual([
      'general_med-demo',
      'general_med-legacy-general',
    ]);
    expect(filterProjectsByType(list, 'war_trauma').map((p) => p.name)).toEqual([
      'trauma_med-demo',
    ]);
  });
});

describe('chooseDefaultProject', () => {
  it('prefers a regular project over virtual General', () => {
    expect(chooseDefaultProject([virtualGeneral, generalMed])).toBe(generalMed);
  });

  it('does not fall back to virtual General when it is the only entry', () => {
    expect(chooseDefaultProject([virtualGeneral])).toBeNull();
  });

  it('selects migrated legacy general as a normal project', () => {
    expect(chooseDefaultProject([legacyGeneral])).toBe(legacyGeneral);
  });

  it('returns null when there are no projects', () => {
    expect(chooseDefaultProject([])).toBeNull();
  });
});

describe('shouldPreserveTabOnSessionSelection', () => {
  it('keeps memory open while selecting another conversation', () => {
    expect(shouldPreserveTabOnSessionSelection('memory')).toBe(true);
    expect(shouldPreserveTabOnSessionSelection('chat')).toBe(false);
    expect(shouldPreserveTabOnSessionSelection('files', true)).toBe(true);
  });
});

describe('typed workspace selection', () => {
  it('chooses the most recently active regular conversation in the requested type', () => {
    const olderTrauma: Project = {
      ...traumaMed,
      name: 'trauma_med-older',
      sessions: [{ id: 'trauma-old', lastActivity: '2026-09-17T10:00:00Z' }],
    };
    const newerTrauma: Project = {
      ...traumaMed,
      name: 'trauma_med-newer',
      sessions: [
        {
          id: 'background-task',
          sessionKind: 'background_task',
          parentSessionId: 'trauma-new',
          relativeTranscriptPath: 'background.jsonl',
          lastActivity: '2026-09-18T12:00:00Z',
        },
        { id: 'trauma-new', updated_at: '2026-09-18T11:00:00Z' },
      ],
    };

    expect(findMostRecentSessionTarget(
      [generalMed, olderTrauma, newerTrauma],
      'war_trauma',
    )).toEqual({
      project: newerTrauma,
      session: newerTrauma.sessions?.[1],
    });
  });

  it('returns the most recent project as the empty-type fallback', () => {
    const older = { ...traumaMed, name: 'trauma_med-a', updated_at: '2026-09-17T10:00:00Z' };
    const newer = { ...traumaMed, name: 'trauma_med-b', updated_at: '2026-09-18T10:00:00Z' };

    expect(findMostRecentProject([older, generalMed, newer], 'war_trauma')).toBe(newer);
  });
});
