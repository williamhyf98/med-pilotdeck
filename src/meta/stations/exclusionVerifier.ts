import type { StructuredModelClient } from "../../trauma/modelClient.js";
import { PICO_KEYS, type CandidateRecord, type CriteriaSet, type PicoKey } from "../benchmark/types.js";
import type { ScreeningDecision } from "../types.js";
import { EXCLUSION_VERIFIER_SYSTEM_PROMPT } from "./exclusionVerifierPrompt.js";
import { buildRecordBlock } from "./screener.js";

/*
 * 工位 G：排除核验。设计与边界见 exclusionVerifierPrompt.ts 顶部注释。
 *
 * 分层（设计文档 §7 的要求）：这里只做"引用是否存在、是否被模型判为冲突"的机械核验与改写，
 * 不做任何领域判断。把 not_met 降为 not_reported 之后，总体决定由 screener.ts 的
 * enforceSensitivity 重新推导，本文件不直接改 decision。
 */

export type ExclusionVerification = {
  key: PicoKey;
  verdict: "conflict" | "absent";
  quote: string;
  note: string;
};

export type ExclusionVerificationResult = { verifications: ExclusionVerification[] };

const KEY_SCHEMA = { type: "string", enum: [...PICO_KEYS] };

export const EXCLUSION_VERIFICATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verifications"],
  properties: {
    verifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "verdict", "quote", "note"],
        properties: {
          key: KEY_SCHEMA,
          verdict: { type: "string", enum: ["conflict", "absent"] },
          quote: { type: "string" },
          note: { type: "string" },
        },
      },
    },
  },
  description: "对每条 not_met 判断的核验：摘要里是否存在一句明确冲突的原文。",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateExclusionVerification(value: unknown): value is ExclusionVerificationResult {
  if (!isRecord(value) || !Array.isArray(value.verifications)) return false;
  return value.verifications.every((item) => {
    if (!isRecord(item)) return false;
    if (!PICO_KEYS.includes(item.key as never)) return false;
    if (item.verdict !== "conflict" && item.verdict !== "absent") return false;
    return typeof item.quote === "string" && typeof item.note === "string";
  });
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 核验工位的输入块：只给被判 not_met 的标准，以及上一工位的 claim。 */
export function buildVerifierUserMessage(
  record: CandidateRecord,
  criteria: CriteriaSet,
  decision: ScreeningDecision,
): string {
  const notMet = decision.criteriaJudgements.filter((item) => item.verdict === "not_met");
  const criteriaLines = notMet.map((item) => `${item.key}：${criteria.elements[item.key] ?? ""}`);
  const claimLines = notMet.map(
    (item) => `${item.key}：引用="${item.evidenceSpan}" 理由="${item.reason}"`,
  );
  return [
    `<criteria>\n${criteriaLines.join("\n\n")}\n</criteria>`,
    buildRecordBlock(record),
    `<claims>\n${claimLines.join("\n")}\n</claims>`,
  ].join("\n\n");
}

export type VerificationOutcome = {
  decision: ScreeningDecision;
  /** 形如 "I:not_met->not_reported(absent)" / "(quote_missing)"；留给错误分析与 RQ2 统计。 */
  corrections: string[];
  /** 核验维持的 not_met 条数。 */
  upheld: number;
};

/**
 * 把核验结果套回筛选判断：
 *   - verdict=absent → 该元素降为 not_reported；
 *   - verdict=conflict 但 quote 在原文里找不到 → 同样降级（模型编造的引用不能当证据）；
 *   - verdict=conflict 且 quote 属实 → 维持 not_met，并把 quote 作为 evidenceSpan（若原引用缺失）；
 *   - 核验结果没覆盖到的 not_met 元素 → 维持原判，不凭空改动。
 * 这里不改 decision 字段，交给 enforceSensitivity 统一推导。
 */
export function applyExclusionVerification(
  decision: ScreeningDecision,
  result: ExclusionVerificationResult,
  record: CandidateRecord,
): VerificationOutcome {
  const haystack = normalizeWhitespace(`${record.title} ${record.abstract}`);
  const byKey = new Map(result.verifications.map((item) => [item.key, item]));
  const corrections: string[] = [];
  let upheld = 0;
  const criteriaJudgements = decision.criteriaJudgements.map((item) => {
    if (item.verdict !== "not_met") return item;
    const verification = byKey.get(item.key);
    if (!verification) {
      upheld += 1;
      return item;
    }
    const quote = normalizeWhitespace(verification.quote);
    const quoteFound = quote.length > 0 && haystack.includes(quote);
    if (verification.verdict === "conflict" && quoteFound) {
      upheld += 1;
      return item.evidenceSpan.trim() ? item : { ...item, evidenceSpan: verification.quote.trim() };
    }
    const cause = verification.verdict === "absent" ? "absent" : "quote_missing";
    corrections.push(`${item.key}:not_met->not_reported(${cause})`);
    return {
      ...item,
      verdict: "not_reported" as const,
      evidenceSpan: "",
      reason: `（校验推翻，${cause === "absent" ? "原文中无冲突语句" : "引用无法在原文核实"}）${item.reason}`,
    };
  });
  return { decision: { ...decision, criteriaJudgements }, corrections, upheld };
}

export type ExclusionVerifier = {
  verify(input: {
    record: CandidateRecord;
    criteria: CriteriaSet;
    decision: ScreeningDecision;
    signal?: AbortSignal;
  }): Promise<ExclusionVerificationResult>;
};

export function createExclusionVerifier(model: StructuredModelClient): ExclusionVerifier {
  return {
    verify(input) {
      return model.completeJson({
        name: "meta_verify_exclusion",
        system: EXCLUSION_VERIFIER_SYSTEM_PROMPT,
        user: buildVerifierUserMessage(input.record, input.criteria, input.decision),
        schema: EXCLUSION_VERIFICATION_SCHEMA,
        validate: validateExclusionVerification,
        signal: input.signal,
      });
    },
  };
}
