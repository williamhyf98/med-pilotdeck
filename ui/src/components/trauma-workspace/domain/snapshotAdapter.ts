import type { RoundMemo } from '../types';
import { derivePatientStateView } from './patientStateView';
import { SUBSTAGE_ORDER, SUBSTAGE_TO_MAIN } from './stageConfig';
import type { CaseSnapshot, CaseState, MainStage, SubStage } from './types';

const MAIN_ORDER: MainStage[] = [
  'battlefield_first_aid',
  'early_treatment',
  'specialist_treatment',
  'rehabilitation',
];

function substepIndex(substage: SubStage): number {
  const withinMain = SUBSTAGE_ORDER.filter((item) =>
    SUBSTAGE_TO_MAIN[item] === SUBSTAGE_TO_MAIN[substage]);
  return withinMain.indexOf(substage);
}

export function snapshotsToRounds(
  snapshots: CaseSnapshot[],
  current?: CaseState | null,
): RoundMemo[] {
  return snapshots
    .filter((snapshot) => snapshot.eventType === 'agent_turn')
    .flatMap((snapshot) => {
      const memo = snapshot.state.memos.find((item) =>
        item.snapshotVersion === snapshot.state.version);
      if (!memo) return [];
      const displayState = current?.memos.at(-1)?.id === memo.id ? current : snapshot.state;
      const classification = displayState.classificationHistory.at(-1);
      const gateStatus = displayState.transport.gateStatus;
      return [{
        id: memo.id,
        snapshotVersion: memo.snapshotVersion,
        round: memo.round,
        title: memo.title,
        time: new Date(memo.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
        elapsed: `${snapshot.state.timeline.elapsedMinutes} 分钟`,
        stageId: memo.mainStage,
        substepIndex: substepIndex(memo.subStage),
        facility: displayState.currentFacility.name,
        capability: displayState.currentCapabilities.join('、') || '未记录',
        transitionLabel: gateStatus,
        transitionTone: gateStatus === 'READY'
          ? 'warning' as const
          : gateStatus === 'BLOCKED'
            ? 'danger' as const
            : gateStatus === 'COMPLETED'
              ? 'success' as const
              : undefined,
        nextTarget: snapshot.response?.transition.targetSubStage ?? '继续当前阶段',
        inputPoints: memo.inputPoints,
        actionPoints: memo.actionPoints,
        conclusion: memo.conclusion,
        patient: derivePatientStateView(displayState),
        classification: {
          label: `V${classification?.version ?? snapshot.state.version}`,
          severity: classification?.severity ?? 'unknown',
          treatmentPriority: classification?.treatmentPriority ?? 'pending',
          transportPriority: classification?.transportPriority ?? 'pending',
        },
        timing: {
          window: displayState.timeline.recommendedWindowMinutes
            ? `建议窗口 ${displayState.timeline.recommendedWindowMinutes} 分钟`
            : '未配置建议窗口',
          status: displayState.timeline.timingStatus,
          warning: displayState.timeline.timingStatus !== 'within_window',
        },
        gate: {
          status: gateStatus,
          title: snapshot.response?.transition.reason ?? gateStatus,
          description: displayState.transport.blockingReason ?? memo.conclusion,
          confirmation: gateStatus === 'READY' ? '等待用户确认' : '无需确认',
        },
        actions: snapshot.response?.treatmentPlan.map((action) => action.description) ?? memo.actionPoints,
        nextStageCapability: displayState.requiredCapabilities.join('、') || '暂未识别',
        messages: [],
        evidence: displayState.evidence.map((item) => ({
          id: item.id,
          title: item.documentTitle,
          score: item.retrievalScore.toFixed(3),
          source: item.retrievalBackend === 'remote' ? '远程知识库' as const : '本地语料' as const,
          used: item.usedInAnswer,
          text: item.text,
        })),
      }];
    })
    .sort((left, right) => left.round - right.round);
}

export function mainStageIndex(stage: MainStage): string {
  return `${MAIN_ORDER.indexOf(stage) + 1}`;
}
