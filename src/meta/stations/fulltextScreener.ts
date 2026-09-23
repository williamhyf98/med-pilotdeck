import type { StructuredModelClient } from "../../trauma/modelClient.js";
import type { CriteriaSet, PicoKey } from "../benchmark/types.js";
import { renderDocument, type FullTextDocument, type RenderedDocument } from "../fulltext/jats.js";
import { FULLTEXT_SCREENING_SCHEMA, validateFullTextDecision } from "../schemas.js";
import type {
  EvidenceFailure,
  FullTextDecision,
  FullTextPrediction,
} from "../types.js";
import { FULLTEXT_SCREENER_SYSTEM_PROMPT } from "./fulltextScreenerPrompt.js";

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

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function fragments(span: string): string[] {
  return span
    .split(/\.{3,}|…|\s+\.\.\.\s+/g)
    .map(normalize)
    .filter((part) => part.length >= 12);
}

/**
 * 核对每条证据：定位器必须存在，片段必须在那一段里。
 * 失败类型按严重程度：bad_locator（自造定位器）> missing（片段不在段内）> spliced（省略号拼接）。
 */
export function checkEvidence(
  decision: FullTextDecision,
  rendered: RenderedDocument,
): { verified: boolean; failure: EvidenceFailure | "none" } {
  let worst: EvidenceFailure | "none" = "none";
  const rank: Record<EvidenceFailure | "none", number> = {
    none: 0,
    spliced: 1,
    missing: 2,
    bad_locator: 3,
  };
  const bump = (failure: EvidenceFailure) => {
    if (rank[failure] > rank[worst]) worst = failure;
  };

  for (const judgement of decision.criteriaJudgements) {
    if (judgement.verdict === "not_reported") continue;
    if (judgement.evidence.length === 0) {
      bump("missing");
      continue;
    }
    for (const item of judgement.evidence) {
      const paragraph = rendered.locators.get(item.locator.trim());
      if (paragraph === undefined) {
        bump("bad_locator");
        continue;
      }
      const haystack = normalize(paragraph);
      const span = normalize(item.span);
      if (!span) {
        bump("missing");
        continue;
      }
      if (haystack.includes(span)) continue;
      const parts = fragments(item.span);
      if (parts.length > 1 && parts.every((part) => haystack.includes(part))) {
        bump("spliced");
      } else {
        bump("missing");
      }
    }
  }
  return { verified: worst === "none", failure: worst };
}

/** 模型漏答或多答元素时按输入 keys 对齐；缺的补 not_reported，多的丢掉。 */
function alignJudgements(decision: FullTextDecision, criteria: CriteriaSet): FullTextDecision {
  const byKey = new Map(decision.criteriaJudgements.map((item) => [item.key, item]));
  const criteriaJudgements = criteria.keys.map((key) => {
    const found = byKey.get(key);
    if (found) {
      return {
        key,
        verdict: found.verdict,
        evidence: found.evidence.map((item) => ({
          locator: item.locator.trim(),
          span: item.span.trim(),
        })),
        reason: found.reason.trim(),
      };
    }
    return {
      key,
      verdict: "not_reported" as const,
      evidence: [],
      reason: "模型未对该元素作答，按未报告处理",
    };
  });
  return { ...decision, criteriaJudgements };
}

/**
 * 程序兜底。三条向保守方向改，一条向纳入方向改：
 *   - 判排除但没有任何 not_met → unresolved
 *   - 判纳入但有元素不是 met → unresolved
 *   - 开启证据门时：判排除，但支撑排除的引用不可用 → unresolved
 *   - 判 unresolved，但列出的元素全部 met 且引用可用 → include
 * 第四条对应实跑里的一个真实错法：标准没给 O，模型却因为"O 无法判断"把
 * 一篇全部符合的文献标成未决。对齐后只剩列出的元素，它们全 met 就该纳入。
 *
 * "引用可用"的定义：定位器存在且片段能在那一段找到。省略号拼接（spliced）
 * 的两段各自都在，引用说了它声称的内容，只是格式违规，所以不阻断决定，
 * 但会原样记录在 evidenceFailure 里供错误分析。自造定位器（bad_locator）和
 * 找不到的片段（missing）才是"引用不成立"，会阻断。
 * 证据门用 evidenceGate 开关，方便实验对照（RQ2）。
 */
function guardDecision(
  decision: FullTextDecision,
  evidenceFailure: EvidenceFailure | "none",
  evidenceGate: boolean,
): FullTextDecision {
  const evidenceUsable = evidenceFailure === "none" || evidenceFailure === "spliced";
  const verdicts = decision.criteriaJudgements.map((item) => item.verdict);
  const hasNotMet = verdicts.includes("not_met");
  const allMet = verdicts.length > 0 && verdicts.every((verdict) => verdict === "met");
  const demote = (why: string): FullTextDecision => ({
    ...decision,
    decision: "unresolved",
    confidence: "low",
    decisionReason: `${decision.decisionReason}（程序修正：${why}）`.trim(),
  });
  if (decision.decision === "exclude" && !hasNotMet) {
    return demote("无元素明确冲突，不能排除，转人工复核");
  }
  if (decision.decision === "include" && !allMet) {
    return demote("有元素未满足或未报告，不能纳入，转人工复核");
  }
  if (evidenceGate && decision.decision === "exclude" && !evidenceUsable) {
    return demote("排除依据的引用无法在原文核实，转人工复核");
  }
  if (decision.decision === "unresolved" && allMet && evidenceUsable) {
    return {
      ...decision,
      decision: "include",
      decisionReason:
        `${decision.decisionReason}（程序修正：标准列出的元素全部符合且证据核实，按纳入处理）`.trim(),
    };
  }
  return decision;
}

export type FullTextScreenerOptions = {
  /** 是否启用证据门：排除依据核不实时降级为未决。默认开。实验的 B0 基线可关。 */
  evidenceGate?: boolean;
  maxParagraphs?: number;
  maxChars?: number;
};

export type FullTextScreenerStation = {
  screen(input: {
    doc: FullTextDocument;
    criteria: CriteriaSet;
    signal?: AbortSignal;
  }): Promise<FullTextPrediction>;
};

export function createFullTextScreenerStation(
  model: StructuredModelClient,
  options: FullTextScreenerOptions = {},
): FullTextScreenerStation {
  const evidenceGate = options.evidenceGate !== false;
  return {
    async screen(input) {
      const { doc, criteria } = input;
      const rendered = renderDocument(doc, {
        maxParagraphs: options.maxParagraphs,
        maxChars: options.maxChars,
      });
      const base = {
        pmid: doc.pmid,
        pmcid: doc.pmcid,
        truncated: rendered.truncated,
        evidenceGate,
      };
      try {
        const raw = await model.completeJson({
          name: "meta_screen_fulltext",
          system: FULLTEXT_SCREENER_SYSTEM_PROMPT,
          user: `${buildCriteriaBlock(criteria)}\n\n${rendered.text}`,
          schema: FULLTEXT_SCREENING_SCHEMA,
          validate: validateFullTextDecision,
          signal: input.signal,
        });
        const aligned = alignJudgements(raw, criteria);
        const evidence = checkEvidence(aligned, rendered);
        const decision = guardDecision(aligned, evidence.failure, evidenceGate);
        return {
          ...base,
          ...decision,
          evidenceVerified: evidence.verified,
          ...(evidence.failure === "none" ? {} : { evidenceFailure: evidence.failure }),
        };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        return {
          ...base,
          criteriaJudgements: criteria.keys.map((key) => ({
            key,
            verdict: "not_reported" as const,
            evidence: [],
            reason: "模型调用失败",
          })),
          decision: "unresolved",
          confidence: "low",
          decisionReason: "模型调用失败，转人工复核",
          evidenceVerified: false,
          failed: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
