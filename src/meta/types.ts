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

// ---- 步骤 0：PICO 抽取 ----------------------------------------------------

/** extracted=原文明说；inferred=上下文推断，需医生确认；missing=没说也推不出，需追问。 */
export type PicoElementStatus = "extracted" | "inferred" | "missing";

export type PicoElement = {
  key: PicoKey;
  status: PicoElementStatus;
  /** 规范化描述；missing 时为空。 */
  text: string;
  /** 输入中的连续原文；仅 extracted 有。 */
  sourceSpan: string;
  /** 给医生的一句追问；extracted 时为空。 */
  followUpQuestion: string;
};

export type PicoExtraction = {
  elements: PicoElement[];
  draftCriteria: { inclusion: string[]; exclusion: string[] };
  notes: string;
};

export type PicoExtractionPrediction = PicoExtraction & {
  /** 所有 extracted 元素的 sourceSpan 都在输入里找到时为 true。 */
  spanVerified: boolean;
  /** 片段核不实、被程序从 extracted 降为 inferred 的元素。 */
  demoted: PicoKey[];
  failed?: boolean;
  error?: string;
};

/** 单个元素的冒烟对比：与金标准的内容词召回。正式指标由评测方算。 */
export type PicoElementSmoke = {
  key: PicoKey;
  status: PicoElementStatus;
  /** 金标准该元素为空时为 null。 */
  goldPresent: boolean;
  /** 金标准内容词里有多少出现在抽取结果中；金标准为空或抽取为空时为 null。 */
  contentRecall: number | null;
};

export type PicoStagePrediction = {
  reviewId: string;
  stage: "pico";
  model: { provider: string; model: string };
  startedAt: string;
  finishedAt: string;
  /** 喂给工位的输入：来自哪篇 PubMed 记录的哪些段落。 */
  input: { pmid: string | null; sections: string[]; text: string };
  goldSource: CriteriaSource;
  prediction: PicoExtractionPrediction | null;
  smoke: PicoElementSmoke[];
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

// ---- 步骤 3b：全文筛选 ----------------------------------------------------

export type FullTextVerdict = "met" | "not_met" | "not_reported" | "conflict";

/** 证据定位：文档里的 [methods#3] 这类标记 + 该段落中的连续原文。 */
export type EvidenceLocator = {
  locator: string;
  span: string;
};

export type FullTextCriterionJudgement = {
  key: PicoKey;
  verdict: FullTextVerdict;
  evidence: EvidenceLocator[];
  reason: string;
};

export type FullTextDecision = {
  criteriaJudgements: FullTextCriterionJudgement[];
  decision: "include" | "exclude" | "unresolved";
  confidence: "high" | "medium" | "low";
  decisionReason: string;
};

/** bad_locator=自造定位器；missing=片段不在段内；spliced=省略号拼接真实片段。 */
export type EvidenceFailure = "bad_locator" | "missing" | "spliced";

export type FullTextPrediction = FullTextDecision & {
  pmid: string;
  pmcid: string;
  /** 文档过长被截断时为 true；此时 not_reported 可能是没看到而不是没写。 */
  truncated: boolean;
  /** 本次是否启用了证据门（RQ2 的实验开关）。 */
  evidenceGate: boolean;
  evidenceVerified: boolean;
  evidenceFailure?: EvidenceFailure;
  failed?: boolean;
  error?: string;
};

export type FullTextItemRecord = {
  pmid: string;
  goldLabel: "in" | "ex";
  availability: "available" | "no_pmc" | "no_body" | "error";
  pmcid?: string;
  error?: string;
  prediction?: FullTextPrediction;
};

export type FullTextStagePrediction = {
  reviewId: string;
  stage: "fulltext";
  criteriaSource: CriteriaSource;
  criteriaKeys: PicoKey[];
  model: { provider: string; model: string };
  evidenceGate: boolean;
  startedAt: string;
  finishedAt: string;
  items: FullTextItemRecord[];
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
