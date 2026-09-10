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

const DISPLAY_TOKEN_REPLACEMENTS: Array<[string, string]> = [
  ["battlefield_first_aid", MAIN_STAGE_LABELS.battlefield_first_aid],
  ["early_treatment", MAIN_STAGE_LABELS.early_treatment],
  ["primary_first_aid", SUBSTAGE_LABELS.primary_first_aid],
  ["advanced_first_aid", SUBSTAGE_LABELS.advanced_first_aid],
  ["emergency_treatment", SUBSTAGE_LABELS.emergency_treatment],
  ["surgical_resuscitation", SUBSTAGE_LABELS.surgical_resuscitation],
  ["ASSESSING", GATE_STATUS_LABELS.ASSESSING],
  ["READY", GATE_STATUS_LABELS.READY],
  ["BLOCKED", GATE_STATUS_LABELS.BLOCKED],
  ["COMPLETED", GATE_STATUS_LABELS.COMPLETED],
  ["STAY", GATE_STATUS_LABELS.STAY],
];

const DISPLAY_REPLACEMENTS: Array<[RegExp, string]> = DISPLAY_TOKEN_REPLACEMENTS.map(([token, label]) => [
  new RegExp(`\\b${escapeRegExp(token)}\\b`, "g"),
  label,
]);

const MAX_DISPLAY_TOKEN_LENGTH = Math.max(...DISPLAY_TOKEN_REPLACEMENTS.map(([token]) => token.length));

const WORD_CHAR_PATTERN = /[A-Za-z0-9_]/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function trailingDisplayTokenPrefixLength(value: string): number {
  const start = Math.max(0, value.length - MAX_DISPLAY_TOKEN_LENGTH + 1);
  let best = 0;
  for (let index = start; index < value.length; index += 1) {
    const suffix = value.slice(index);
    if (!suffix) continue;
    const previous = index > 0 ? value[index - 1] : "";
    if (previous && WORD_CHAR_PATTERN.test(previous)) continue;
    if (DISPLAY_TOKEN_REPLACEMENTS.some(([token]) =>
      suffix.length <= token.length && token.startsWith(suffix)
    )) {
      best = Math.max(best, suffix.length);
    }
  }
  return best;
}

export type ChineseDisplayStreamNormalizer = {
  push(delta: string): string;
  flush(): string;
};

export function createChineseDisplayStreamNormalizer(): ChineseDisplayStreamNormalizer {
  let raw = "";
  let safeRawLength = 0;
  let emittedNormalized = "";
  const next = (final: boolean): string => {
    const hold = final ? 0 : trailingDisplayTokenPrefixLength(raw);
    const nextSafeRawLength = raw.length - hold;
    if (nextSafeRawLength <= safeRawLength && !final) return "";
    safeRawLength = Math.max(safeRawLength, nextSafeRawLength);
    const normalized = normalizeChineseDisplayText(raw.slice(0, safeRawLength));
    const delta = normalized.slice(emittedNormalized.length);
    emittedNormalized = normalized;
    return delta;
  };
  return {
    push(delta: string) {
      raw += delta;
      return next(false);
    },
    flush() {
      safeRawLength = raw.length;
      return next(true);
    },
  };
}

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
