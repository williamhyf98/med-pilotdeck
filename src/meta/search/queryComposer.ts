import type { ConceptBlock, ConceptTable } from "../types.js";

/**
 * 概念表 → PubMed Boolean 检索式。
 *
 * 这一步是纯程序，不用模型。原因见 conceptBuilderPrompt.ts：括号嵌套与字段标签
 * 交给代码才不会出语法错误，模型只负责想词。同一张概念表永远拼出同一条检索式，
 * 这样检索式的差异只来自概念表，评测才能定位问题出在"想词"还是"拼装"。
 *
 * 结构：每个块内部 OR（MeSH 词与自由词并列），块之间 AND，最后可选 AND 研究设计过滤器。
 */

/**
 * Cochrane 高敏感度 RCT 过滤器（PubMed 版，取其核心部分）。
 * 用途是把结果限制在随机对照试验，同时尽量不漏。
 * 来源：Cochrane Handbook 第 4 章的 sensitivity-maximizing 版本。
 */
export const COCHRANE_RCT_FILTER = [
  "randomized controlled trial[pt]",
  "controlled clinical trial[pt]",
  "randomized[tiab]",
  "randomised[tiab]",
  "placebo[tiab]",
  "clinical trials as topic[mesh:noexp]",
  "randomly[tiab]",
  "trial[ti]",
].join(" OR ");

/** 排除动物实验但保留同时涉及人的研究。 */
export const ANIMAL_EXCLUSION = "animals[mh] NOT humans[mh]";

/** 检索词里可能破坏 Boolean 结构的字符。 */
function sanitizeTerm(term: string): string {
  return term
    .replace(/["()\[\]]/g, " ")
    .replace(/\b(AND|OR|NOT)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteIfPhrase(term: string): string {
  return term.includes(" ") ? `"${term}"` : term;
}

/** 单个概念块：MeSH 词加 [mh]，自由词加 [tiab]，块内全部 OR。 */
export function composeBlock(block: ConceptBlock): string | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const raw of block.meshTerms) {
    const term = sanitizeTerm(raw);
    if (!term) continue;
    const key = `mh:${term.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`"${term}"[mh]`);
  }
  for (const raw of block.freeTerms) {
    const term = sanitizeTerm(raw);
    if (!term) continue;
    const key = `tiab:${term.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`${quoteIfPhrase(term)}[tiab]`);
  }
  if (parts.length === 0) return null;
  return `(${parts.join(" OR ")})`;
}

export type ComposeOptions = {
  /** 加 Cochrane 高敏感度 RCT 过滤器。默认加。 */
  rctFilter?: boolean;
  /** 排除纯动物研究。默认加。 */
  excludeAnimals?: boolean;
};

export type ComposedQuery = {
  query: string;
  /** 实际参与拼装的块，按元素分组，便于界面显示每块命中数。 */
  blockQueries: { element: ConceptBlock["element"]; label: string; query: string }[];
  skipped: { label: string; reason: string }[];
};

export function composeQuery(table: ConceptTable, options: ComposeOptions = {}): ComposedQuery {
  const blockQueries: ComposedQuery["blockQueries"] = [];
  const skipped: ComposedQuery["skipped"] = [];
  for (const block of table.blocks) {
    const query = composeBlock(block);
    if (!query) {
      skipped.push({ label: block.label, reason: "该块没有可用检索词" });
      continue;
    }
    blockQueries.push({ element: block.element, label: block.label, query });
  }
  if (blockQueries.length === 0) {
    throw new Error("concept table produced no usable blocks");
  }
  const clauses = blockQueries.map((item) => item.query);
  if (options.rctFilter !== false) clauses.push(`(${COCHRANE_RCT_FILTER})`);
  let query = clauses.join(" AND ");
  if (options.excludeAnimals !== false) query = `(${query}) NOT (${ANIMAL_EXCLUSION})`;
  return { query, blockQueries, skipped };
}
