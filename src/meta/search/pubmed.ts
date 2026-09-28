/**
 * PubMed E-utilities 客户端，只用于检索式评测所需的三件事：
 *   1. 数一条检索式命中多少条（esearch retmax=0，不下载结果）；
 *   2. 判断一批指定 PMID 里有哪些被这条检索式命中（交集法，见 recallCheck）；
 *   3. 校验一个 MeSH 词在 PubMed 里是否真实存在。
 *
 * 为什么用交集法而不是把结果全下来比对：PubMed 单次检索最多返回 10000 条，
 * 而一条高敏感度的 Cochrane 检索式动辄命中十几万条。把
 * "检索式 AND (pmid1[uid] OR pmid2[uid] ...)" 交给 PubMed，让它自己算交集，
 * 一次请求就能得到命中了哪几条，既不受上限影响也不用下载大量数据。
 *
 * 限速：无 api_key 时 3 请求/秒，有 key 时 10 请求/秒。默认留足余量。
 */

const ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

/** efetch 回来的一条 PubMed 记录，只保留步骤 0 需要的字段。 */
export type PubMedAbstract = {
  pmid: string;
  title: string;
  journal: string;
  year: string;
  /** 结构化摘要的各段；无标签的摘要只有一段，label 为空串。 */
  sections: { label: string; text: string }[];
};

function stripXml(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
      if (/^#x/i.test(body)) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }[body.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** 解析 efetch db=pubmed retmode=xml 的输出。纯函数，便于测试。 */
export function parsePubMedAbstracts(xml: string): PubMedAbstract[] {
  const out: PubMedAbstract[] = [];
  const articles = xml.split(/<PubmedArticle[\s>]/).slice(1);
  for (const chunk of articles) {
    const pmid = chunk.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    if (!pmid) continue;
    const title = stripXml(chunk.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1] ?? "");
    const journalBlock = chunk.match(/<Journal>([\s\S]*?)<\/Journal>/)?.[1] ?? "";
    const journal = stripXml(journalBlock.match(/<Title>([\s\S]*?)<\/Title>/)?.[1] ?? "");
    const year = journalBlock.match(/<Year>(\d{4})<\/Year>/)?.[1]
      ?? journalBlock.match(/<MedlineDate>(\d{4})/)?.[1]
      ?? "";
    const sections: PubMedAbstract["sections"] = [];
    const abstractBlock = chunk.match(/<Abstract>([\s\S]*?)<\/Abstract>/)?.[1] ?? "";
    const re = /<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g;
    for (let m = re.exec(abstractBlock); m; m = re.exec(abstractBlock)) {
      const label = m[1].match(/Label="([^"]*)"/)?.[1] ?? "";
      const text = stripXml(m[2]);
      if (text) sections.push({ label: stripXml(label), text });
    }
    out.push({ pmid, title, journal, year, sections });
  }
  return out;
}

/**
 * 从密钥文件内容里抽出 NCBI API key。
 *
 * 用户保存密钥时常连同变量名一起写进去（"NCBI_API_KEY=xxxx"），或带引号、
 * 空格、换行。直接把整段内容当 key 发出去会得到 HTTP 400。NCBI key 固定是
 * 36 位十六进制，按这个特征抽取最稳。抽不到时原样返回去掉空白的内容，
 * 让上游报错而不是静默无 key 运行。
 */
export function parseNcbiApiKey(raw: string): string | undefined {
  const text = raw.replace(/﻿/g, "").trim();
  if (!text) return undefined;
  const hex = text.match(/[0-9a-fA-F]{36}/);
  if (hex) return hex[0];
  const afterEquals = text.split("=").pop()?.trim().replace(/^["']|["']$/g, "");
  return afterEquals || undefined;
}

export type PubMedClientOptions = {
  apiKey?: string;
  /** NCBI 要求标识调用方，便于出问题时联系。 */
  tool?: string;
  email?: string;
  timeoutMs?: number;
  /** 每秒最多几次请求。无 key 上限 3，有 key 上限 10。 */
  requestsPerSecond?: number;
  maxRetries?: number;
};

type EsearchResult = {
  esearchresult?: {
    count?: string;
    idlist?: string[];
    errorlist?: { phrasesnotfound?: string[]; fieldsnotfound?: string[] };
    warninglist?: { phrasesignored?: string[]; outputmessages?: string[] };
    ERROR?: string;
  };
};

export type SearchCount = {
  count: number;
  /** PubMed 未能匹配的词。MeSH 词拼错时会出现在这里，是检索式的硬错误。 */
  phrasesNotFound: string[];
  fieldsNotFound: string[];
};

export type RecallCheck = {
  /** 被检索式命中的目标 PMID。 */
  hits: string[];
  /** 未被命中的目标 PMID。 */
  missed: string[];
  /** 在 PubMed 中根本查不到的 PMID，不应计入漏检。 */
  absent: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPubMedClient(options: PubMedClientOptions = {}) {
  const minIntervalMs = 1000 / (options.requestsPerSecond ?? (options.apiKey ? 8 : 2.5));
  const timeoutMs = options.timeoutMs ?? 90_000;
  const maxRetries = options.maxRetries ?? 3;
  let nextSlot = 0;

  /** 串行化所有请求并保持最小间隔，避免触发 429。 */
  async function throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minIntervalMs;
    if (wait > 0) await sleep(wait);
  }

  async function esearch(term: string, retmax = 0): Promise<EsearchResult["esearchresult"]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await throttle();
      const body = new URLSearchParams({
        db: "pubmed",
        term,
        retmode: "json",
        retmax: String(retmax),
        tool: options.tool ?? "med-pilotdeck",
        ...(options.email ? { email: options.email } : {}),
        ...(options.apiKey ? { api_key: options.apiKey } : {}),
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // 检索式常有两千字符以上，必须用 POST，GET 会超出 URL 长度限制。
        const response = await fetch(ESEARCH, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: controller.signal,
        });
        if (response.status === 429) throw new Error("pubmed 429 rate limited");
        if (!response.ok) throw new Error(`pubmed http ${response.status}`);
        const payload = (await response.json()) as EsearchResult;
        if (payload.esearchresult?.ERROR) {
          throw new Error(`pubmed error: ${payload.esearchresult.ERROR}`);
        }
        return payload.esearchresult;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) await sleep(1000 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    /** 数命中条数，不下载结果。 */
    async count(term: string): Promise<SearchCount> {
      const result = await esearch(term, 0);
      return {
        count: Number.parseInt(result?.count ?? "0", 10) || 0,
        phrasesNotFound: result?.errorlist?.phrasesnotfound ?? [],
        fieldsNotFound: result?.errorlist?.fieldsnotfound ?? [],
      };
    },

    /**
     * 交集法核对召回：只问"这些 PMID 里哪些被命中"，不下载全部结果。
     * PMID 较多时分批，避免检索式过长。
     */
    async recallCheck(term: string, pmids: readonly string[]): Promise<RecallCheck> {
      const unique = [...new Set(pmids)].filter(Boolean);
      if (unique.length === 0) return { hits: [], missed: [], absent: [] };
      const hits = new Set<string>();
      const existing = new Set<string>();
      const batchSize = 150;
      for (let i = 0; i < unique.length; i += batchSize) {
        const batch = unique.slice(i, i + batchSize);
        const uids = batch.map((pmid) => `${pmid}[uid]`).join(" OR ");
        const intersect = await esearch(`(${term}) AND (${uids})`, batch.length);
        for (const pmid of intersect?.idlist ?? []) hits.add(pmid);
        // 单独确认这些 PMID 是否存在：查不到的记录不能算作漏检。
        const present = await esearch(uids, batch.length);
        for (const pmid of present?.idlist ?? []) existing.add(pmid);
      }
      return {
        hits: unique.filter((pmid) => hits.has(pmid)),
        missed: unique.filter((pmid) => !hits.has(pmid) && existing.has(pmid)),
        absent: unique.filter((pmid) => !existing.has(pmid)),
      };
    },

    /** 校验 MeSH 主题词是否存在。LLM 经常编出不存在的 MeSH 词。 */
    async meshExists(term: string): Promise<boolean> {
      const result = await esearch(`"${term}"[mh]`, 0);
      const notFound = result?.errorlist?.phrasesnotfound ?? [];
      if (notFound.length > 0) return false;
      return (Number.parseInt(result?.count ?? "0", 10) || 0) > 0;
    },

    /** 取命中的 PMID 列表（少量），步骤 0 用它按标题找 Cochrane 评价自己的 PubMed 记录。 */
    async searchIds(term: string, retmax = 20): Promise<string[]> {
      const result = await esearch(term, retmax);
      return result?.idlist ?? [];
    },

    /** 下载几条记录的结构化摘要。 */
    async fetchAbstracts(pmids: readonly string[]): Promise<PubMedAbstract[]> {
      const unique = [...new Set(pmids)].filter(Boolean);
      if (unique.length === 0) return [];
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        await throttle();
        const body = new URLSearchParams({
          db: "pubmed",
          id: unique.join(","),
          retmode: "xml",
          rettype: "abstract",
          tool: options.tool ?? "med-pilotdeck",
          ...(options.email ? { email: options.email } : {}),
          ...(options.apiKey ? { api_key: options.apiKey } : {}),
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(EFETCH, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
            signal: controller.signal,
          });
          if (response.status === 429) throw new Error("pubmed 429 rate limited");
          if (!response.ok) throw new Error(`pubmed http ${response.status}`);
          return parsePubMedAbstracts(await response.text());
        } catch (error) {
          lastError = error;
          if (attempt < maxRetries) await sleep(1000 * 2 ** attempt);
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}

export type PubMedClient = ReturnType<typeof createPubMedClient>;

/** 给检索式加上与数据集一致的日期上限，保证与基线可比。 */
export function withDateCeiling(query: string, cutoffIso: string): string {
  const hi = cutoffIso.replace(/-/g, "/");
  return `(${query}) AND ("1900/01/01"[dp] : "${hi}"[dp])`;
}
