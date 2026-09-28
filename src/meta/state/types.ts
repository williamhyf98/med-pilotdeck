/**
 * 评价状态：一篇系统综述筛选全过程的持久化形态。
 *
 * 设计依据 AgentOS_研究问题与实验设计.md 第 2.3 节，四条硬要求：
 *   1. 逐条资格状态，取值支持"支持符合／支持不符合／未知／冲突"；
 *   2. 每个状态必须有来源（哪个阶段、哪篇文档、原文在哪），
 *      自由文本推测不能自动变成全局事实；
 *   3. 报告间不一致时保留冲突，不做"最近一次写入覆盖"；
 *   4. 记录预算消耗与人工处理历史。
 *
 * 之所以让证据按元素累积而不是每阶段各存一份：题摘阶段把 S 判成 not_reported，
 * 全文阶段把 S 判成 met，这是同一个元素的认识在推进，不是两个无关结论。
 * 累积视图让下游（以及 RQ1 的记忆实验）能直接看到"哪些元素还没定、
 * 上次是在哪看到的"，不必回放整段对话历史。
 */
import type { CriteriaSource, PicoKey } from "../benchmark/types.js";
import type {
  EvidenceLocator,
  FullTextPrediction,
  FullTextVerdict,
  ScreeningPrediction,
} from "../types.js";

/** 证据来自哪个阶段的哪份文档。 */
export type EvidenceOrigin = {
  stage: "abstract" | "fulltext" | "human";
  /** 题摘阶段就是 PMID 本身；全文阶段是 PMCID。 */
  documentId: string;
  /** 第几轮写入。用于区分先后，不用于覆盖。 */
  round: number;
  at: string;
};

/** 一个元素在某一次观察中的结论。 */
export type CriterionObservation = {
  verdict: FullTextVerdict;
  /** 题摘阶段只有原文片段没有定位器，locator 为空串。 */
  evidence: EvidenceLocator[];
  reason: string;
  origin: EvidenceOrigin;
  /** 该次观察的引用是否通过程序核对。 */
  evidenceVerified: boolean;
};

/**
 * 一个元素的累积状态。
 *
 * observations 保留全部历史，current 是当前采信的那一条。
 * conflicting 非空表示不同观察互相矛盾且未消解——按第 3 条要求保留，
 * 不允许后写的悄悄覆盖前面的。
 */
export type CriterionState = {
  key: PicoKey;
  current: CriterionObservation;
  observations: CriterionObservation[];
  /** 与 current 矛盾且未消解的其他观察。 */
  conflicting: CriterionObservation[];
};

export type ItemStage =
  | "candidate"
  | "abstract_screened"
  | "fulltext_pending"
  | "fulltext_screened"
  | "committed";

export type FinalDecision = "include" | "exclude" | "unresolved";

/** 全文可得性。no_pmc / no_body 不是失败，是真实世界的约束。 */
export type FullTextAccess =
  | { status: "not_sought" }
  | { status: "available"; pmcid: string }
  | { status: "no_pmc" }
  | { status: "no_body"; pmcid: string; scanned: boolean; pdfUri?: string }
  | { status: "error"; error: string };

export type ItemEvent = {
  at: string;
  round: number;
  kind:
    | "ingested"
    | "abstract_screened"
    | "fulltext_resolved"
    | "fulltext_screened"
    | "committed"
    | "escalated"
    | "skipped"
    | "criteria_relocked";
  detail: string;
};

/** 最终决定是谁提交的。PRISMA 账本要把人排除与机排除分开记。 */
export type DecisionActor = "model" | "human";

export type ItemState = {
  pmid: string;
  title: string;
  stage: ItemStage;
  criteria: Partial<Record<PicoKey, CriterionState>>;
  abstractDecision?: {
    decision: "include" | "exclude";
    confidence: "high" | "medium" | "low";
    reason: string;
    round: number;
  };
  fullText: FullTextAccess;
  fulltextDecision?: {
    decision: FinalDecision;
    confidence: "high" | "medium" | "low";
    reason: string;
    round: number;
  };
  /** 提交后的最终结论。未提交时缺省。 */
  finalDecision?: FinalDecision;
  /** 提交最终结论的一方；有 finalDecision 时必有。 */
  decidedBy?: DecisionActor;
  /** 需要人工复核的原因；非空表示进了人工队列。 */
  escalation?: { reason: string; round: number };
  events: ItemEvent[];
};

/** PRISMA 流程图上半部分需要的计数。人排除与自动排除必须分开记。 */
export type PrismaLedger = {
  candidates: number;
  abstractScreened: number;
  abstractExcludedByModel: number;
  abstractExcludedByHuman: number;
  abstractKept: number;
  fullTextSought: number;
  fullTextAvailable: number;
  fullTextUnavailable: { noPmc: number; noBody: number; error: number };
  fullTextIncluded: number;
  fullTextExcludedByModel: number;
  fullTextExcludedByHuman: number;
  fullTextUnresolved: number;
};

/** 预算消耗。RQ3 的质量—成本曲线需要，初始化与验证器的开销也要计进来。 */
export type BudgetUsage = {
  modelCalls: number;
  promptChars: number;
  pubmedRequests: number;
  fullTextFetches: number;
  humanQueries: number;
  wallClockMs: number;
};

/** 锁定的资格标准。锁定后下游只读，改动要显式重新锁定并记版本。 */
export type LockedCriteria = {
  source: CriteriaSource;
  keys: PicoKey[];
  elements: Partial<Record<PicoKey, string>>;
  lockedAt: string;
  /** 每次重新锁定 +1；证据的 criteriaVersion 与此不符时需重新评估（RQ5）。 */
  criteriaVersion: number;
};

export type SearchRecord = {
  query: string;
  executedQuery: string;
  hitCount: number;
  conceptBlocks: { element: PicoKey; label: string }[];
  droppedMeshTerms: string[];
  at: string;
};

export type ReviewState = {
  schemaVersion: number;
  reviewId: string;
  /** 每次落盘 +1。 */
  version: number;
  /** 每跑一轮 +1。同一轮内多次落盘不改 round。 */
  round: number;
  createdAt: string;
  updatedAt: string;
  criteria: LockedCriteria | null;
  search: SearchRecord | null;
  items: Record<string, ItemState>;
  ledger: PrismaLedger;
  budget: BudgetUsage;
};

export const REVIEW_STATE_SCHEMA_VERSION = 1;

export function emptyLedger(): PrismaLedger {
  return {
    candidates: 0,
    abstractScreened: 0,
    abstractExcludedByModel: 0,
    abstractExcludedByHuman: 0,
    abstractKept: 0,
    fullTextSought: 0,
    fullTextAvailable: 0,
    fullTextUnavailable: { noPmc: 0, noBody: 0, error: 0 },
    fullTextIncluded: 0,
    fullTextExcludedByModel: 0,
    fullTextExcludedByHuman: 0,
    fullTextUnresolved: 0,
  };
}

export function emptyBudget(): BudgetUsage {
  return {
    modelCalls: 0,
    promptChars: 0,
    pubmedRequests: 0,
    fullTextFetches: 0,
    humanQueries: 0,
    wallClockMs: 0,
  };
}

export function initialReviewState(reviewId: string, now: string): ReviewState {
  return {
    schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
    reviewId,
    version: 0,
    round: 0,
    createdAt: now,
    updatedAt: now,
    criteria: null,
    search: null,
    items: {},
    ledger: emptyLedger(),
    budget: emptyBudget(),
  };
}

// ---- 证据写入 --------------------------------------------------------------

/** 两条观察是否矛盾：一方 met 另一方 not_met 才算，未知不算矛盾。 */
function contradicts(a: FullTextVerdict, b: FullTextVerdict): boolean {
  const decisive = (v: FullTextVerdict) => v === "met" || v === "not_met";
  return decisive(a) && decisive(b) && a !== b;
}

/** 证据强度：全文 > 题摘；有核实的引用 > 没有。用于决定采信哪一条。 */
function strength(observation: CriterionObservation): number {
  const stageWeight = observation.origin.stage === "human"
    ? 3
    : observation.origin.stage === "fulltext"
      ? 2
      : 1;
  const decisive = observation.verdict === "met" || observation.verdict === "not_met" ? 1 : 0;
  return stageWeight * 2 + decisive + (observation.evidenceVerified ? 1 : 0);
}

/**
 * 把一次观察并入元素状态。
 *
 * 规则：
 *   - 首次观察直接成为 current；
 *   - 更强的观察接替 current，被替下的若与新结论矛盾则进 conflicting；
 *   - 较弱的观察只入 observations，若与 current 矛盾也进 conflicting。
 * 任何情况下都不丢弃历史观察。
 */
export function mergeObservation(
  key: PicoKey,
  existing: CriterionState | undefined,
  observation: CriterionObservation,
): CriterionState {
  if (!existing) {
    return { key, current: observation, observations: [observation], conflicting: [] };
  }
  const observations = [...existing.observations, observation];
  const conflicting = [...existing.conflicting];
  let current = existing.current;
  if (strength(observation) > strength(existing.current)) {
    if (contradicts(existing.current.verdict, observation.verdict)) {
      conflicting.push(existing.current);
    }
    current = observation;
  } else if (contradicts(existing.current.verdict, observation.verdict)) {
    conflicting.push(observation);
  }
  return { key, current, observations, conflicting };
}

/** 该元素当前是否还没有定论（未知或存在未消解冲突）。 */
export function isUnsettled(state: CriterionState): boolean {
  if (state.conflicting.length > 0) return true;
  return state.current.verdict === "not_reported" || state.current.verdict === "conflict";
}

// ---- 从工位输出构造观察 ----------------------------------------------------

export function observationsFromAbstract(
  prediction: ScreeningPrediction,
  round: number,
  at: string,
): { key: PicoKey; observation: CriterionObservation }[] {
  const origin: EvidenceOrigin = { stage: "abstract", documentId: prediction.pmid, round, at };
  return prediction.criteriaJudgements.map((judgement) => ({
    key: judgement.key,
    observation: {
      // 题摘阶段的 schema 没有 conflict 取值，直接透传。
      verdict: judgement.verdict,
      evidence: judgement.evidenceSpan
        ? [{ locator: "", span: judgement.evidenceSpan }]
        : [],
      reason: judgement.reason,
      origin,
      evidenceVerified: prediction.evidenceVerified,
    },
  }));
}

export function observationsFromFullText(
  prediction: FullTextPrediction,
  round: number,
  at: string,
): { key: PicoKey; observation: CriterionObservation }[] {
  const origin: EvidenceOrigin = { stage: "fulltext", documentId: prediction.pmcid, round, at };
  return prediction.criteriaJudgements.map((judgement) => ({
    key: judgement.key,
    observation: {
      verdict: judgement.verdict,
      evidence: judgement.evidence,
      reason: judgement.reason,
      origin,
      evidenceVerified: prediction.evidenceVerified,
    },
  }));
}
