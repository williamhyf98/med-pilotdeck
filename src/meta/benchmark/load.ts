import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  PICO_KEYS,
  type BenchmarkReview,
  type CandidateRecord,
  type CriteriaSet,
  type CriteriaSource,
  type GoldRecord,
  type PicoKey,
  type PicoText,
} from "./types.js";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
};

/** candidates 的标题摘要来自 PubMed HTML，带 &#x2265; 之类实体。 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * PICO 原文是从 PDF 抽的，里面粘着页眉页脚。页脚格式固定：
 *   "<综述标题> (Review) Copyright © 2024 The Cochrane Collaboration. Published by John Wiley & Sons, Ltd. 12"
 * 后面常跟下一页页眉 "Cochrane Library Trusted evidence. Informed decisions. Better health. Cochrane Database of Systematic Reviews"。
 *
 * 2026-10-02 修正：旧实现在第一个 "Copyright ©" 处把后文全部截掉。纳排标准往往跨页，
 * dev 集 101 篇里 52 篇因此丢掉页脚之后的正文（41 个要素各丢 ≥200 字；CD013562 的合格干预列表只剩第 1 项，
 * 18 篇纳入研究全部漏判）。现在只摘除页脚页眉本身，保留其后的正文；无法识别的其他 Copyright 变体仍按尾部截断。
 *
 * 跑在综述标题前的那段 running title 没有分隔符，取法是：回退到上一个句末标点为止（最多 200 字）。
 * 标题里含句点时会残留半截标题，这是可接受的噪音。
 */
const PAGE_FURNITURE =
  /(?:(?<=[.;:)\]])\s*[^.;:]{0,200}?)?\(Review\)\s*Copyright ©\s*\d{4}\s*The Cochrane Collaboration\.\s*Published by John Wiley & Sons, Ltd\.\s*\d*\s*(?:Cochrane Library\s*Trusted evidence\.\s*Informed decisions\.\s*Better health\.\s*Cochrane Database of Systematic Reviews\s*)?/g;

/** 页脚落在别的元素里时，本元素开头只剩下一页的页眉，单独摘掉。 */
const PAGE_HEADER =
  /Cochrane Library\s*Trusted evidence\.?(?:\s*Informed decisions\.?)?(?:\s*Better health\.?)?(?:\s*Cochrane Database of Systematic Reviews?)?\s*/g;

export function cleanPicoText(text: string | null): string | null {
  if (!text) return null;
  let cleaned = text.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(PAGE_FURNITURE, " ").replace(PAGE_HEADER, " ").replace(/\s+/g, " ").trim();
  const copyright = cleaned.indexOf("Copyright ©");
  if (copyright > 0) cleaned = cleaned.slice(0, copyright).trim();
  cleaned = cleaned.replace(/\(Review\)$/, "").trim();
  return cleaned || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string, file: string): string {
  if (typeof value !== "string") throw new Error(`${file}: field ${field} must be a string`);
  return value;
}

function normalizePico(raw: unknown, file: string, field: string): PicoText {
  if (!isRecord(raw)) throw new Error(`${file}: ${field} must be an object`);
  const out = {} as PicoText;
  for (const key of PICO_KEYS) {
    const value = raw[key];
    out[key] = typeof value === "string" ? cleanPicoText(value) : null;
  }
  return out;
}

export function parseBenchmarkReview(raw: unknown, file = "<memory>"): BenchmarkReview {
  if (!isRecord(raw)) throw new Error(`${file}: root must be an object`);
  const id = asString(raw.id, "id", file);
  if (!isRecord(raw.review) || !isRecord(raw.search) || !isRecord(raw.criteria)) {
    throw new Error(`${file}: review/search/criteria are required`);
  }
  if (!isRecord(raw.screening) || !Array.isArray(raw.gold) || !Array.isArray(raw.candidates)) {
    throw new Error(`${file}: screening/gold/candidates are required`);
  }
  const gold: GoldRecord[] = raw.gold.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${file}: gold[${index}] must be an object`);
    const label = item.label;
    if (label !== "in" && label !== "ex") {
      throw new Error(`${file}: gold[${index}].label must be in|ex`);
    }
    return {
      pmid: asString(item.pmid, `gold[${index}].pmid`, file),
      label,
      study_id: typeof item.study_id === "string" ? item.study_id : "",
    };
  });
  const candidates: CandidateRecord[] = raw.candidates.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${file}: candidates[${index}] must be an object`);
    return {
      pmid: asString(item.pmid, `candidates[${index}].pmid`, file),
      title: decodeHtmlEntities(typeof item.title === "string" ? item.title : ""),
      abstract: decodeHtmlEntities(typeof item.abstract === "string" ? item.abstract : ""),
      ...(typeof item.url === "string" ? { url: item.url } : {}),
    };
  });
  return {
    schema_version: typeof raw.schema_version === "string" ? raw.schema_version : "1.0",
    id,
    review: {
      title: asString(raw.review.title, "review.title", file),
      ...(typeof raw.review.pdf === "string" ? { pdf: raw.review.pdf } : {}),
    },
    search: {
      database: typeof raw.search.database === "string" ? raw.search.database : "",
      cutoff: typeof raw.search.cutoff === "string" ? raw.search.cutoff : "",
      query: typeof raw.search.query === "string" ? raw.search.query : "",
    },
    criteria: {
      article_picos: normalizePico(raw.criteria.article_picos, file, "criteria.article_picos"),
      refined_picos: normalizePico(raw.criteria.refined_picos, file, "criteria.refined_picos"),
    },
    screening: raw.screening as BenchmarkReview["screening"],
    gold,
    candidates,
    ...(isRecord(raw._recall_check) ? { _recall_check: raw._recall_check } : {}),
    ...(isRecord(raw._source) ? { _source: raw._source } : {}),
    ...(typeof raw._v === "number" ? { _v: raw._v } : {}),
  };
}

export async function loadBenchmarkReview(file: string): Promise<BenchmarkReview> {
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  return parseBenchmarkReview(raw, basename(file));
}

export async function listBenchmarkIds(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((name) => /^CD\d+\.json$/i.test(name))
    .map((name) => name.replace(/\.json$/i, ""))
    .sort();
}

export function benchmarkFile(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/**
 * 把 "article_picos.PICOS" 这类选项解析成纳排标准集合。
 * 数据集里 C 与 O 经常为 null；缺失的元素不参与判断，也不出现在 keys 里。
 */
export function resolveCriteriaSet(review: BenchmarkReview, option: string): CriteriaSet {
  const [sourceRaw, lettersRaw] = option.split(".");
  const source: CriteriaSource = sourceRaw === "refined_picos" ? "refined_picos" : "article_picos";
  const letters = (lettersRaw ?? "PICOS").toUpperCase();
  const pico = review.criteria[source];
  const keys: PicoKey[] = [];
  const elements: Partial<Record<PicoKey, string>> = {};
  for (const key of PICO_KEYS) {
    if (!letters.includes(key)) continue;
    const text = pico[key];
    if (!text) continue;
    keys.push(key);
    elements[key] = text;
  }
  return { source, keys, elements };
}

// ---- dev / test 划分 -------------------------------------------------------

export type BenchmarkSplit = {
  seed: number;
  devSize: number;
  dev: string[];
  test: string[];
};

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 固定种子的洗牌，保证开发方与评测方算出同一份划分。 */
export function computeSplit(
  ids: readonly string[],
  devSize: number,
  seed = 20260923,
): BenchmarkSplit {
  const shuffled = [...ids].sort();
  const random = mulberry32(seed);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = swap;
  }
  const dev = shuffled.slice(0, devSize).sort();
  const devSet = new Set(dev);
  const test = [...ids].filter((id) => !devSet.has(id)).sort();
  return { seed, devSize, dev, test };
}

export function splitFile(dir: string): string {
  return join(dir, "split.json");
}

/** 有 split.json 就用它（与评测方共享同一份）；没有就按固定种子生成并写入。 */
export async function loadOrCreateSplit(dir: string, devSize = 100): Promise<BenchmarkSplit> {
  const file = splitFile(dir);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as BenchmarkSplit;
    if (Array.isArray(parsed.dev) && Array.isArray(parsed.test)) return parsed;
  } catch {
    // 首次运行没有划分文件，下面生成。
  }
  const ids = await listBenchmarkIds(dir);
  const split = computeSplit(ids, devSize);
  await writeFile(file, `${JSON.stringify(split, null, 2)}\n`, "utf8");
  return split;
}
