/**
 * PMC 全文获取：PMID → PMCID → JATS XML → 解析后的 FullTextDocument，按 PMID 落盘缓存。
 *
 * 路径选择依据（2026-09-23 实测）：
 *   - PMID→PMCID 用 idconv，而不是 elink。elink 会把"引用了该文的 PMC 文章"
 *     也当成链接，给出错误的 PMCID；idconv 是一一对应的权威映射。
 *   - 全文用 eutils efetch db=pmc，返回 JATS XML，带分节。Europe PMC 对旧文献
 *     返回 500；PMC 的 OA 批量服务只覆盖 OA 子集，其余 404；PDF 直链 403。
 *   - 旧文献可能有 PMCID 但没有 <body>（扫描件），必须区分 no_body 与 available。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseJats, type FullTextDocument } from "./jats.js";

const IDCONV = "https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/";
const EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

export type FullTextAvailability =
  | { status: "available"; pmid: string; pmcid: string; doc: FullTextDocument }
  | { status: "no_pmc"; pmid: string }
  | { status: "no_body"; pmid: string; pmcid: string }
  | { status: "error"; pmid: string; pmcid?: string; error: string };

export type FullTextClientOptions = {
  apiKey?: string;
  email?: string;
  tool?: string;
  /** 解析结果缓存目录；默认 .cache/fulltext。 */
  cacheDir?: string;
  requestsPerSecond?: number;
  timeoutMs?: number;
  maxRetries?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFullTextClient(options: FullTextClientOptions = {}) {
  const cacheDir = options.cacheDir ?? join(".cache", "fulltext");
  const minIntervalMs = 1000 / (options.requestsPerSecond ?? 3);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const maxRetries = options.maxRetries ?? 3;
  const tool = options.tool ?? "med-pilotdeck";
  let nextSlot = 0;

  async function throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minIntervalMs;
    if (wait > 0) await sleep(wait);
  }

  async function fetchText(url: string, init?: RequestInit): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await throttle();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          ...init,
          headers: { "user-agent": `${tool}/0.1 (academic research)`, ...(init?.headers ?? {}) },
          signal: controller.signal,
        });
        if (response.status === 429) throw new Error("ncbi 429 rate limited");
        if (!response.ok) throw new Error(`ncbi http ${response.status}`);
        return await response.text();
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) await sleep(1000 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  const common = () => ({
    tool,
    ...(options.email ? { email: options.email } : {}),
    ...(options.apiKey ? { api_key: options.apiKey } : {}),
  });

  return {
    /** 批量 PMID → PMCID。没有 PMC 全文的 PMID 不出现在返回表里。 */
    async resolvePmcIds(pmids: readonly string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      const unique = [...new Set(pmids)].filter(Boolean);
      for (let i = 0; i < unique.length; i += 200) {
        const batch = unique.slice(i, i + 200);
        const params = new URLSearchParams({ ids: batch.join(","), format: "json", ...common() });
        const payload = JSON.parse(await fetchText(`${IDCONV}?${params}`)) as {
          records?: { pmid?: string; pmcid?: string }[];
        };
        for (const record of payload.records ?? []) {
          if (record.pmid && record.pmcid) out.set(String(record.pmid), record.pmcid);
        }
      }
      return out;
    },

    /** 取一篇的 JATS XML 原文。 */
    async fetchJats(pmcid: string): Promise<string> {
      const numeric = pmcid.replace(/^PMC/i, "");
      const params = new URLSearchParams({ db: "pmc", id: numeric, retmode: "xml", ...common() });
      return fetchText(EFETCH, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params,
      });
    },

    /**
     * 拿一篇的解析结果，优先读缓存。
     * pmcid 可预先传入（已批量解析过时省一次 idconv）。
     */
    async get(pmid: string, knownPmcid?: string): Promise<FullTextAvailability> {
      const cacheFile = join(cacheDir, `${pmid}.json`);
      try {
        const cached = JSON.parse(await readFile(cacheFile, "utf8")) as FullTextAvailability;
        // 错误结果不缓存复用，下次重试。
        if (cached.status !== "error") return cached;
      } catch {
        // 无缓存
      }

      let result: FullTextAvailability;
      try {
        let pmcid = knownPmcid;
        if (!pmcid) {
          const map = await this.resolvePmcIds([pmid]);
          pmcid = map.get(pmid);
        }
        if (!pmcid) {
          result = { status: "no_pmc", pmid };
        } else {
          const xml = await this.fetchJats(pmcid);
          if (/<error\b/i.test(xml) && !/<article\b/i.test(xml)) {
            throw new Error(`efetch error: ${xml.replace(/<[^>]+>/g, " ").trim().slice(0, 120)}`);
          }
          const doc = parseJats(xml, { pmid, pmcid });
          result = doc.hasBody
            ? { status: "available", pmid, pmcid, doc }
            : { status: "no_body", pmid, pmcid };
        }
      } catch (error) {
        result = {
          status: "error",
          pmid,
          ...(knownPmcid ? { pmcid: knownPmcid } : {}),
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (result.status !== "error") {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cacheFile, `${JSON.stringify(result)}\n`, "utf8");
      }
      return result;
    },
  };
}

export type FullTextClient = ReturnType<typeof createFullTextClient>;
