/**
 * 步骤 0 的评测输入从哪里来。
 *
 * 数据集里没有"医生的一段话"，只有 Cochrane 评价的标题和它方法学部分的 PICO 金标准。
 * 最接近真实输入的是这篇评价在 PubMed 上的结构化摘要里的 Background 与 Objectives——
 * 那是作者用自然语言写的研究问题，还没被拆成 PICO。
 *
 * 必须排除 "Selection criteria" 这一段：它就是纳排标准的摘要版，等于把答案喂给模型。
 * 同理 Search methods / Main results / Conclusions 也不给，它们不是"问题"，是"答案"。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BenchmarkReview } from "../benchmark/types.js";
import type { PubMedAbstract, PubMedClient } from "../search/pubmed.js";

const QUESTION_LABELS = [/^background/i, /^objective/i, /^aim/i, /^purpose/i];
const ANSWER_LABELS = [/selection/i, /search/i, /data collection/i, /main results/i, /results/i, /conclusion/i, /method/i];

export type QuestionText = {
  /** 用了哪些段（原标签）。 */
  sections: string[];
  text: string;
};

/** 从结构化摘要里拼出"问题文本"：只要 Background 与 Objectives；没有标签时退化为整段去掉答案段。 */
export function buildQuestionText(abstract: Pick<PubMedAbstract, "sections" | "title">): QuestionText | null {
  const picked = abstract.sections.filter((section) =>
    QUESTION_LABELS.some((re) => re.test(section.label)));
  if (picked.length > 0) {
    return {
      sections: picked.map((section) => section.label),
      text: picked.map((section) => `${section.label}: ${section.text}`).join("\n\n"),
    };
  }
  // 没有标签的摘要：无法可靠剥掉答案段，放弃；宁可少评几篇也不能漏答案。
  const unlabeled = abstract.sections.filter((section) => !section.label);
  if (unlabeled.length === abstract.sections.length) return null;
  const safe = abstract.sections.filter((section) =>
    section.label && !ANSWER_LABELS.some((re) => re.test(section.label)));
  if (safe.length === 0) return null;
  return {
    sections: safe.map((section) => section.label),
    text: safe.map((section) => `${section.label}: ${section.text}`).join("\n\n"),
  };
}

type CachedLookup =
  | { v: 1; found: true; abstract: PubMedAbstract }
  | { v: 1; found: false; tried: string[] };

function cleanTitleForSearch(title: string): string {
  return title.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * 按标题在 PubMed 找这篇 Cochrane 评价自己的记录。同一评价有多个版本（pub2/pub3），
 * 取最新的一条即可，Background/Objectives 基本不随版本变。结果按评价缓存。
 */
export async function findCochraneAbstract(
  pubmed: Pick<PubMedClient, "searchIds" | "fetchAbstracts">,
  review: Pick<BenchmarkReview, "id" | "review">,
  cacheDir: string,
): Promise<PubMedAbstract | null> {
  const file = join(cacheDir, `${review.id}.json`);
  try {
    const cached = JSON.parse(await readFile(file, "utf8")) as CachedLookup;
    if (cached.v === 1) return cached.found ? cached.abstract : null;
  } catch {
    // 没缓存，下面查。
  }
  const title = cleanTitleForSearch(review.review.title);
  const tried: string[] = [];
  const terms = [
    `"${title}"[Title] AND "Cochrane Database Syst Rev"[Journal]`,
    `${title}[Title] AND "Cochrane Database Syst Rev"[Journal]`,
  ];
  let abstract: PubMedAbstract | null = null;
  for (const term of terms) {
    tried.push(term);
    const ids = await pubmed.searchIds(term, 5);
    if (ids.length === 0) continue;
    const records = await pubmed.fetchAbstracts(ids);
    // esearch 默认按最近排序；取第一条有摘要的。
    const withAbstract = records.filter((record) => record.sections.length > 0);
    abstract = withAbstract[0] ?? null;
    if (abstract) break;
  }
  await mkdir(cacheDir, { recursive: true });
  const payload: CachedLookup = abstract
    ? { v: 1, found: true, abstract }
    : { v: 1, found: false, tried };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return abstract;
}

const STOPWORDS = new Set([
  "with", "that", "this", "from", "were", "have", "been", "which", "their", "there", "these", "those",
  "than", "then", "into", "such", "also", "only", "both", "each", "other", "more", "most", "some", "any",
  "types", "type", "included", "include", "including", "studies", "study", "trials", "trial", "review",
  "participants", "interventions", "outcomes", "comparison", "randomised", "randomized", "controlled",
  "should", "could", "would", "about", "after", "before", "between", "during", "where", "when", "what",
  "used", "using", "based", "least", "less", "over", "under", "without", "within", "versus",
]);

export function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [];
  return new Set(words.filter((word) => !STOPWORDS.has(word)));
}

/** 金标准内容词里有多少出现在抽取文本里。粗指标，只用于看方向。 */
export function contentRecall(gold: string, predicted: string): number | null {
  const goldWords = contentWords(gold);
  if (goldWords.size === 0) return null;
  const predWords = contentWords(predicted);
  let hit = 0;
  for (const word of goldWords) if (predWords.has(word)) hit += 1;
  return hit / goldWords.size;
}
