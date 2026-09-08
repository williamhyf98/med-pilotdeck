import type { RoundMemo } from '../types';
import {
  gateStatusLabel,
  priorityLabel,
  severityLabel,
  subStageLabel,
  toChineseDisplayText,
} from './displayLabels';
import { derivePatientStateView } from './patientStateView';
import { SUBSTAGE_ORDER, SUBSTAGE_TO_MAIN } from './stageConfig';
import type { CaseSnapshot, CaseState, MainStage, SubStage } from './types';

const MAIN_ORDER: MainStage[] = [
  'battlefield_first_aid',
  'early_treatment',
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
        stageId: memo.mainStage ?? 'battlefield_first_aid',
        substepIndex: memo.subStage ? substepIndex(memo.subStage) : 0,
        unplaced: !memo.mainStage || !memo.subStage,
        facility: displayState.currentFacility?.name ?? '未定级',
        capability: displayState.currentCapabilities.join('、') || '未记录',
        transitionLabel: gateStatusLabel(gateStatus),
        transitionTone: gateStatus === 'READY'
          ? 'warning' as const
          : gateStatus === 'BLOCKED'
            ? 'danger' as const
            : gateStatus === 'COMPLETED'
              ? 'success' as const
              : undefined,
        nextTarget: snapshot.response?.transition.targetSubStage
          ? subStageLabel(snapshot.response.transition.targetSubStage)
          : '继续当前阶段',
        inputPoints: memo.inputPoints,
        actionPoints: memo.actionPoints,
        conclusion: memo.conclusion,
        patient: derivePatientStateView(displayState),
        classification: {
          label: `V${classification?.version ?? snapshot.state.version}`,
          severity: severityLabel(classification?.severity),
          treatmentPriority: priorityLabel(classification?.treatmentPriority),
          transportPriority: priorityLabel(classification?.transportPriority),
        },
        gate: {
          status: gateStatus,
          title: toChineseDisplayText(snapshot.response?.transition.reason ?? gateStatusLabel(gateStatus)),
          description: toChineseDisplayText(displayState.transport.blockingReason ?? memo.conclusion),
          confirmation: gateStatus === 'READY' ? '医学建议，未自动执行' : '无需确认',
        },
        actions: snapshot.response?.treatmentPlan.map((action) => toChineseDisplayText(action.description)) ?? memo.actionPoints,
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
