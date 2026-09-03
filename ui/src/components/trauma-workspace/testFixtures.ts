import type { CaseState } from './domain/types';

export function initialUiCaseState(): CaseState {
  return {
    version: 1,
    round: 1,
    updatedAt: '2026-09-03T15:09:00+08:00',
    currentStage: 'battlefield_first_aid',
    currentSubStage: 'primary_first_aid',
    currentFacility: {
      name: '连抢救组',
      type: 'company_aid_team',
      capabilities: ['止血'],
    },
    currentCapabilities: ['止血'],
    requiredCapabilities: [],
    vitalSignsHistory: [],
    injuries: [],
    completedActions: [],
    currentActions: [],
    classificationHistory: [],
    transport: {
      gateStatus: 'ASSESSING',
      readiness: 'unknown',
    },
    timeline: {
      elapsedMinutes: 0,
      timingStatus: 'within_window',
    },
    missingInformation: [],
    memos: [],
    evidence: [],
  };
}
