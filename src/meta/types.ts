import type { CriteriaSource, PicoKey } from "./benchmark/types.js";

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
  /** 模型调用失败时的兜底标记：按敏感度优先保留，并记录原因。 */
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
