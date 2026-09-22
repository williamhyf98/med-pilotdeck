import type { StructuredModelClient } from "../../trauma/modelClient.js";
import type { CandidateRecord, CriteriaSet, PicoKey } from "../benchmark/types.js";
import { SCREENING_OUTPUT_SCHEMA, validateScreeningDecision } from "../schemas.js";
import type { ScreeningDecision, ScreeningPrediction } from "../types.js";
import { SCREENER_SYSTEM_PROMPT } from "./screenerPrompt.js";

const ELEMENT_LABEL: Record<PicoKey, string> = {
  P: "P 研究对象",
  I: "I 干预措施",
  C: "C 对照",
  O: "O 结局指标",
  S: "S 研究设计",
};

export function buildCriteriaBlock(criteria: CriteriaSet): string {
  const lines = criteria.keys.map((key) => `${ELEMENT_LABEL[key]}：${criteria.elements[key] ?? ""}`);
  return `<criteria>\n${lines.join("\n\n")}\n</criteria>`;
}

export function buildRecordBlock(record: CandidateRecord): string {
  const abstract = record.abstract.trim() || "（本条无摘要，仅有标题）";
  return `<record>\n标题：${record.title.trim()}\n\n摘要：${abstract}\n</record>`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** evidenceSpan 必须能在标题摘要里找到，否则标记未通过校验，交给错误分析。 */
export function verifyEvidence(decision: ScreeningDecision, record: CandidateRecord): boolean {
  const haystack = normalizeWhitespace(`${record.title} ${record.abstract}`);
  return decision.criteriaJudgements.every((item) => {
    if (item.verdict === "not_reported") return true;
    const span = normalizeWhitespace(item.evidenceSpan);
    if (!span) return false;
    return haystack.includes(span);
  });
}

/**
 * 模型漏答或多答元素时按输入的 keys 对齐：
 * 缺的补成 not_reported，多的丢掉，顺序按输入重排。
 */
function alignJudgements(decision: ScreeningDecision, criteria: CriteriaSet): ScreeningDecision {
  const byKey = new Map(decision.criteriaJudgements.map((item) => [item.key, item]));
  const criteriaJudgements = criteria.keys.map((key) => {
    const found = byKey.get(key);
    if (found) {
      return {
        key,
        verdict: found.verdict,
        evidenceSpan: found.evidenceSpan.trim(),
        reason: found.reason.trim(),
      };
    }
    return {
      key,
      verdict: "not_reported" as const,
      evidenceSpan: "",
      reason: "模型未对该元素作答，按未报告处理",
    };
  });
  return { ...decision, criteriaJudgements };
}

/**
 * 程序兜底敏感度规则：没有任何元素明确冲突却判排除时，改回纳入。
 * 这一条与 prompt 里的"敏感度优先"重复，用于防止模型不遵守。
 */
function enforceSensitivity(decision: ScreeningDecision): ScreeningDecision {
  const hasConflict = decision.criteriaJudgements.some((item) => item.verdict === "not_met");
  if (decision.decision === "exclude" && !hasConflict) {
    return {
      ...decision,
      decision: "include",
      confidence: "low",
      decisionReason:
        `${decision.decisionReason}（程序修正：无元素明确冲突，题摘阶段按敏感度优先保留）`.trim(),
    };
  }
  return decision;
}

export type ScreenerStation = {
  screen(input: {
    record: CandidateRecord;
    criteria: CriteriaSet;
    signal?: AbortSignal;
  }): Promise<ScreeningPrediction>;
};

export function createScreenerStation(model: StructuredModelClient): ScreenerStation {
  return {
    async screen(input) {
      const { record, criteria } = input;
      try {
        const raw = await model.completeJson({
          name: "meta_screen_initial",
          system: SCREENER_SYSTEM_PROMPT,
          user: `${buildCriteriaBlock(criteria)}\n\n${buildRecordBlock(record)}`,
          schema: SCREENING_OUTPUT_SCHEMA,
          validate: validateScreeningDecision,
          signal: input.signal,
        });
        const decision = enforceSensitivity(alignJudgements(raw, criteria));
        return {
          pmid: record.pmid,
          ...decision,
          evidenceVerified: verifyEvidence(decision, record),
        };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        // 调用失败不能变成排除，否则会压低敏感度并掩盖故障。
        return {
          pmid: record.pmid,
          criteriaJudgements: criteria.keys.map((key) => ({
            key,
            verdict: "not_reported" as const,
            evidenceSpan: "",
            reason: "模型调用失败",
          })),
          decision: "include",
          confidence: "low",
          decisionReason: "模型调用失败，按敏感度优先保留待人工复核",
          evidenceVerified: false,
          failed: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
