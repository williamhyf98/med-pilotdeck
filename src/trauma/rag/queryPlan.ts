import type { CaseState, RagQueryKind, SubStage } from "../types.js";

export type PlannedRagQuery = {
  wave: 1 | 2;
  kind: RagQueryKind;
  query: string;
  reason: string;
  critical: boolean;
};

const SUBSTAGE_LABEL: Record<SubStage, string> = {
  primary_first_aid: "初级急救",
  advanced_first_aid: "高级急救",
  emergency_treatment: "紧急救治",
  surgical_resuscitation: "紧急手术复苏",
  field_specialist_treatment: "野战专科治疗",
  definitive_specialist_treatment: "确定性专科治疗",
  functional_recovery: "功能恢复",
  psychophysical_rehabilitation: "身心康复",
};

function latestVitals(state: CaseState): string {
  const vitals = state.vitalSignsHistory.at(-1);
  if (!vitals) return "生命体征未知";
  return [
    vitals.respiratoryRate !== undefined ? `RR ${vitals.respiratoryRate}` : "",
    vitals.systolicBloodPressure !== undefined ? `SBP ${vitals.systolicBloodPressure}` : "",
    vitals.heartRate !== undefined ? `HR ${vitals.heartRate}` : "",
    vitals.spo2 !== undefined ? `SpO2 ${vitals.spo2}` : "",
  ].filter(Boolean).join("，") || "生命体征未知";
}

function injurySummary(state: CaseState): string {
  if (state.injuries.length === 0) return "伤情未明";
  return state.injuries
    .map((injury) => `${injury.bodyPart}${injury.finding}`)
    .join("；");
}

function caseContext(state: CaseState): string {
  return [
    `救治级别：${SUBSTAGE_LABEL[state.currentSubStage]}`,
    `机构：${state.currentFacility.name}`,
    `伤情：${injurySummary(state)}`,
    `生命体征：${latestVitals(state)}`,
  ].join("；");
}

export function buildBaselineQueries(state: CaseState): PlannedRagQuery[] {
  const context = caseContext(state);
  return [
    {
      wave: 1,
      kind: "stage",
      query: `${context}；问题：当前级别允许的救治技术和范围`,
      reason: "覆盖当前救治级别规则",
      critical: true,
    },
    {
      wave: 1,
      kind: "classification_transport",
      query: `${context}；问题：分类、时效与后送通用规则`,
      reason: "覆盖分类与后送规则",
      critical: true,
    },
    {
      wave: 1,
      kind: "primary_injury",
      query: `${context}；问题：主要伤情专项处置规则`,
      reason: "覆盖主要伤情专项规则",
      critical: true,
    },
  ];
}
