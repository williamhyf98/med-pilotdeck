/**
 * reviews_a 基准数据集的记录结构（schema_version 1.0）。
 * 每个文件对应一篇 Cochrane 评价：检索式、PICO 原文、金标准与候选文献池。
 */

export type PicoKey = "P" | "I" | "C" | "O" | "S";

export const PICO_KEYS: readonly PicoKey[] = ["P", "I", "C", "O", "S"];

export type PicoText = Record<PicoKey, string | null>;

export type GoldLabel = "in" | "ex";

export type GoldRecord = {
  pmid: string;
  label: GoldLabel;
  study_id: string;
};

export type CandidateRecord = {
  pmid: string;
  title: string;
  abstract: string;
  url?: string;
};

export type ScreeningConfig = {
  initial: {
    input: string[];
    /** 例如 "article_picos.PICOS"：来源字段 + 参与判断的元素。 */
    criteria_options: string[];
    retain_gold_labels: string[];
  };
  final: {
    input: string[];
    criteria: string;
    include_gold_label: string;
  };
};

export type BenchmarkReview = {
  schema_version: string;
  id: string;
  review: { title: string; pdf?: string };
  search: { database: string; cutoff: string; query: string };
  criteria: { article_picos: PicoText; refined_picos: PicoText };
  screening: ScreeningConfig;
  gold: GoldRecord[];
  candidates: CandidateRecord[];
  _recall_check?: Record<string, unknown>;
  _source?: Record<string, unknown>;
  _v?: number;
};

export type CriteriaSource = "article_picos" | "refined_picos";

/** 解析后的纳排标准：来源字段 + 本次参与判断的元素及其原文。 */
export type CriteriaSet = {
  source: CriteriaSource;
  keys: PicoKey[];
  elements: Partial<Record<PicoKey, string>>;
};
