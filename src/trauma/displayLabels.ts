import type { GateStatus, MainStage, SubStage } from "./types.js";

export const MAIN_STAGE_LABELS: Record<MainStage, string> = {
  battlefield_first_aid: "Ⅰ级·战现场急救",
  early_treatment: "Ⅱ级·早期救治",
};

export const SUBSTAGE_LABELS: Record<SubStage, string> = {
  primary_first_aid: "初级急救",
  advanced_first_aid: "高级急救",
  emergency_treatment: "紧急处置",
  surgical_resuscitation: "外科复苏",
};

export const GATE_STATUS_LABELS: Record<GateStatus, string> = {
  ASSESSING: "评估中",
  STAY: "留在本级",
  READY: "建议后送",
  BLOCKED: "暂缓后送",
  COMPLETED: "转换完成",
};

const DISPLAY_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bbattlefield_first_aid\b/g, MAIN_STAGE_LABELS.battlefield_first_aid],
  [/\bearly_treatment\b/g, MAIN_STAGE_LABELS.early_treatment],
  [/\bprimary_first_aid\b/g, SUBSTAGE_LABELS.primary_first_aid],
  [/\badvanced_first_aid\b/g, SUBSTAGE_LABELS.advanced_first_aid],
  [/\bemergency_treatment\b/g, SUBSTAGE_LABELS.emergency_treatment],
  [/\bsurgical_resuscitation\b/g, SUBSTAGE_LABELS.surgical_resuscitation],
  [/\bASSESSING\b/g, GATE_STATUS_LABELS.ASSESSING],
  [/\bREADY\b/g, GATE_STATUS_LABELS.READY],
  [/\bBLOCKED\b/g, GATE_STATUS_LABELS.BLOCKED],
  [/\bCOMPLETED\b/g, GATE_STATUS_LABELS.COMPLETED],
  [/\bSTAY\b/g, GATE_STATUS_LABELS.STAY],
];

export function mainStageLabel(value: MainStage | null | undefined): string {
  return value ? MAIN_STAGE_LABELS[value] : "未定级";
}

export function subStageLabel(value: SubStage | null | undefined): string {
  return value ? SUBSTAGE_LABELS[value] : "未定级";
}

export function gateStatusLabel(value: GateStatus | null | undefined): string {
  return value ? GATE_STATUS_LABELS[value] : "待判断";
}

export function normalizeChineseDisplayText(value: string): string {
  return DISPLAY_REPLACEMENTS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}
