import { expect, it } from 'vitest';
import { snapshotsToRounds } from './snapshotAdapter';
import type { CaseSnapshot } from './types';
import { initialUiCaseState } from '../testFixtures';

it('uses answer appearance order for legacy and newly saved snapshot evidence', () => {
  const state = initialUiCaseState();
  state.version = 1;
  state.memos = [{ id: 'memo', round: 1, createdAt: state.updatedAt, mainStage: null, subStage: null,
    title: '记录', inputPoints: [], actionPoints: [], conclusion: '结论', snapshotVersion: 1 }];
  state.evidence = [1, 2, 3].map(i => ({ id: `c${i}`, documentTitle: `文献${i}`, section: '', text: `原文${i}`,
    retrievalScore: 0.9, retrievalBackend: 'remote' as const, usedInAnswer: i !== 2, citationIndex: i }));
  const snapshot = { eventType: 'agent_turn', round: 1, createdAt: state.updatedAt, triggerMessageId: 'm', state,
    retrieval: { promptChunkIds: ['c1', 'c2', 'c3'] },
    response: { naturalLanguageAnswer: '先[3]后[1]再[3]', treatmentPlan: [], transition: { status: 'STAY', reason: '' } },
  } as CaseSnapshot;
  const evidence = snapshotsToRounds([snapshot])[0].evidence;
  expect(evidence.find(e => e.id === 'c3')?.citationIndex).toBe(1);
  expect(evidence.find(e => e.id === 'c1')?.citationIndex).toBe(2);
  expect(evidence.find(e => e.id === 'c2')?.citationIndex).toBeUndefined();
});
