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

/**
 * 模型常用省略号把两处不连续的原文缝成一条 span
 * （例："A randomised trial... mean follow up of 4.4 years"）。
 * 这违反"连续片段"要求，但每一段本身是真的，与凭空编造不是一类错误，
 * 因此拆成片段分别核对，并在结果里区分这两种失败。
 */
function splitSpanFragments(span: string): string[] {
  return span
    .split(/\.{3,}|…|\s+\.\.\.\s+/g)
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length >= 12);
}

export type EvidenceCheck = {
  verified: boolean;
  /** none=全部核对通过；spliced=片段真实但被省略号拼接；missing=找不到对应原文 */
  failure: "none" | "spliced" | "missing";
};

/** evidenceSpan 必须能在标题摘要里找到，否则标记未通过校验，交给错误分析。 */
export function checkEvidence(
  decision: ScreeningDecision,
  record: CandidateRecord,
): EvidenceCheck {
  const haystack = normalizeWhitespace(`${record.title} ${record.abstract}`);
  let spliced = false;
  for (const item of decision.criteriaJudgements) {
    if (item.verdict === "not_reported") continue;
    const span = normalizeWhitespace(item.evidenceSpan);
    if (!span) return { verified: false, failure: "missing" };
    if (haystack.includes(span)) continue;
    const fragments = splitSpanFragments(item.evidenceSpan);
    if (fragments.length > 1 && fragments.every((part) => haystack.includes(part))) {
      spliced = true;
      continue;
    }
    return { verified: false, failure: "missing" };
  }
  return spliced ? { verified: false, failure: "spliced" } : { verified: true, failure: "none" };
}

/** 兼容旧调用点：只关心是否完全通过。 */
export function verifyEvidence(decision: ScreeningDecision, record: CandidateRecord): boolean {
  return checkEvidence(decision, record).verified;
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

/**
 * 阶段规则：题摘阶段结局（O）不得作为排除依据。
 *
 * dev 集 CD000259 漏掉的 65 篇纳入研究里，46 次 not_met 落在 O 上——模型把"摘要的主要结局是
 * 患者结局"读成"研究没有测量专业人员表现"。摘要只列主要结局，报告了什么不等于没测什么，
 * 这条在提示词里写了，模型仍会违反，所以程序兜底：O 的 not_met 一律改成 not_reported，
 * 并记录在 guardCorrections 里供错误分析与实验对照（B0 基线可关）。
 */
export function applyAbstractStageRules(
  decision: ScreeningDecision,
  options: { outcomeNeverExcludes: boolean },
): { decision: ScreeningDecision; corrections: string[] } {
  if (!options.outcomeNeverExcludes) return { decision, corrections: [] };
  const corrections: string[] = [];
  const criteriaJudgements = decision.criteriaJudgements.map((item) => {
    if (item.key !== "O" || item.verdict !== "not_met") return item;
    corrections.push("O:not_met->not_reported");
    return {
      ...item,
      verdict: "not_reported" as const,
      evidenceSpan: "",
      reason: `（程序修正：题摘阶段结局不作排除依据）${item.reason}`,
    };
  });
  return { decision: { ...decision, criteriaJudgements }, corrections };
}

export type ScreenerStationOptions = {
  /** 题摘阶段 O 的 not_met 是否降为 not_reported。默认开；实验矩阵 B0 关。 */
  outcomeNeverExcludes?: boolean;
};

export type ScreenerStation = {
  screen(input: {
    record: CandidateRecord;
    criteria: CriteriaSet;
    signal?: AbortSignal;
  }): Promise<ScreeningPrediction>;
};

export function createScreenerStation(
  model: StructuredModelClient,
  options: ScreenerStationOptions = {},
): ScreenerStation {
  const outcomeNeverExcludes = options.outcomeNeverExcludes !== false;
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
        const staged = applyAbstractStageRules(alignJudgements(raw, criteria), { outcomeNeverExcludes });
        const decision = enforceSensitivity(staged.decision);
        const evidence = checkEvidence(decision, record);
        return {
          pmid: record.pmid,
          ...decision,
          evidenceVerified: evidence.verified,
          ...(evidence.failure === "none" ? {} : { evidenceFailure: evidence.failure }),
          ...(staged.corrections.length > 0 ? { guardCorrections: staged.corrections } : {}),
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
