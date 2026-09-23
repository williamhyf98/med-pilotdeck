import type { CriteriaSource, PicoKey } from "./benchmark/types.js";

export type { CriteriaSource, PicoKey };

export type ScreeningVerdict = "met" | "not_met" | "not_reported";

export type ScreeningCriterionJudgement = {
  key: PicoKey;
  verdict: ScreeningVerdict;
  evidenceSpan: string;
  reason: string;
};

export type ScreeningDecision = {
  criteriaJudgements: ScreeningCriterionJudgement[];
  decision: "include" | "exclude";
  confidence: "high" | "medium" | "low";
  decisionReason: string;
};

/** 单条候选文献的筛选结果，写入 predictions 目录供评测方读取。 */
export type ScreeningPrediction = ScreeningDecision & {
  pmid: string;
  /** evidenceSpan 未在标题摘要中找到时置 false，供错误分析使用。 */
  evidenceVerified: boolean;
  /** 未通过时的失败类型：spliced=省略号拼接真实片段；missing=找不到原文。 */
  evidenceFailure?: "spliced" | "missing";
  /** 模型调用失败时的兜底标记：按敏感度优先保留，并记录原因。 */
  failed?: boolean;
  error?: string;
};

// ---- 步骤 1：检索概念表 ----------------------------------------------------

export type ConceptBlock = {
  element: PicoKey;
  label: string;
  meshTerms: string[];
  freeTerms: string[];
  rationale: string;
};

export type ConceptTable = {
  blocks: ConceptBlock[];
  omittedElements: { element: PicoKey; reason: string }[];
};

/** MeSH 词校验结果：编造的词要在拼检索式之前剔除。 */
export type MeshValidation = {
  term: string;
  exists: boolean;
  blockLabel: string;
};

export type SearchStagePrediction = {
  reviewId: string;
  stage: "search";
  criteriaSource: CriteriaSource;
  model: { provider: string; model: string };
  startedAt: string;
  finishedAt: string;
  conceptTable: ConceptTable;
  /** 被 PubMed 判定不存在、已从检索式剔除的 MeSH 词。 */
  droppedMeshTerms: MeshValidation[];
  query: string;
  /** 与数据集 cutoff 对齐后的实际执行式。 */
  executedQuery: string;
  hitCount: number;
  blockHitCounts: { label: string; count: number }[];
  /** 交集法核对：目标 PMID 里命中了哪些。 */
  recall: {
    label: "in" | "all";
    total: number;
    hit: number;
    missed: string[];
    absent: string[];
  }[];
  /** Cochrane 原检索式在同样条件下的表现，作为对照。 */
  baseline: { hitCount: number; recallIn: number; totalIn: number } | null;
  failed?: boolean;
  error?: string;
};

export type ScreeningStagePrediction = {
  reviewId: string;
  stage: "initial" | "final";
  criteriaSource: CriteriaSource;
  criteriaKeys: PicoKey[];
  model: { provider: string; model: string };
  startedAt: string;
  finishedAt: string;
  predictions: ScreeningPrediction[];
};
