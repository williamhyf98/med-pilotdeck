/**
 * 步骤 3b 回放：对每篇综述的金标准文献取全文、做全文筛选、写预测。
 *
 * 全文阶段的考题是"能不能把 in 和 ex 分开"：
 *   - gold in  → 应判 include
 *   - gold ex  → 应判 exclude（Cochrane 读了全文才排除的，全文里有依据）
 * 判 unresolved 不算错，算人工成本，单独统计。
 *
 * 只有 27% 的 gold 文献在 PMC 有全文，所以每篇综述都会有 no_pmc 的条目；
 * 它们如实记录，不参与准确率分母。
 *
 * 用法：
 *   tsx src/meta/eval/replayFullText.ts --dir reviews_a --reviews CD015177
 *   tsx src/meta/eval/replayFullText.ts --dir reviews_a --split dev --min-available 3
 *   加 --no-evidence-gate 得到实验矩阵里的 B0 基线。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  benchmarkFile,
  loadBenchmarkReview,
  loadOrCreateSplit,
  resolveCriteriaSet,
} from "../benchmark/load.js";
import { createFullTextClient } from "../fulltext/pmc.js";
import { parseNcbiApiKey } from "../search/pubmed.js";
import { createFullTextScreenerStation } from "../stations/fulltextScreener.js";
import type { FullTextItemRecord, FullTextStagePrediction } from "../types.js";
import { createOpenAiCompatibleClient } from "./openaiClient.js";

function parseArgs(argv: readonly string[]) {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const eq = key.indexOf("=");
    if (eq >= 0) {
      map.set(key.slice(0, eq), key.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      map.set(key, next);
      i += 1;
    } else {
      map.set(key, "true");
    }
  }
  const num = (key: string): number | null => {
    const raw = map.get(key);
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  };
  const splitRaw = map.get("split") ?? "dev";
  return {
    dir: map.get("dir") ?? process.env.META_BENCHMARK_DIR ?? "reviews_a",
    out: map.get("out") ?? "predictions",
    cacheDir: map.get("cache-dir") ?? join(".cache", "fulltext"),
    split: (splitRaw === "test" || splitRaw === "all" ? splitRaw : "dev") as "dev" | "test" | "all",
    limit: num("limit"),
    reviews: map.get("reviews")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
    // 数据集里全文阶段的标准就是 refined_picos.PICOS
    criteria: map.get("criteria") ?? "refined_picos.PICOS",
    evidenceGate: map.get("no-evidence-gate") !== "true",
    /** 可得全文少于此数的综述跳过，省模型调用。 */
    minAvailable: num("min-available") ?? 1,
    concurrency: num("concurrency") ?? 2,
    devSize: num("dev-size") ?? 100,
    baseUrl: map.get("base-url") ?? process.env.META_MODEL_BASE_URL ?? "http://10.31.112.13:8040/v1",
    model: map.get("model") ?? process.env.META_MODEL ?? "Qwen3.8-27B",
    apiKey: map.get("api-key") ?? process.env.META_MODEL_API_KEY ?? "EMPTY",
    ncbiKey: map.get("ncbi-key") ?? process.env.NCBI_API_KEY ?? undefined,
    email: map.get("email") ?? process.env.NCBI_EMAIL ?? undefined,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function summarize(reviewId: string, items: readonly FullTextItemRecord[]): string {
  const by = (label: "in" | "ex") => items.filter((item) => item.goldLabel === label);
  const avail = (list: FullTextItemRecord[]) => list.filter((item) => item.availability === "available");
  const count = (list: FullTextItemRecord[], decision: string) =>
    list.filter((item) => item.prediction?.decision === decision).length;

  const inAll = by("in");
  const exAll = by("ex");
  const inAv = avail(inAll);
  const exAv = avail(exAll);
  const noPmc = items.filter((item) => item.availability === "no_pmc").length;
  const noBody = items.filter((item) => item.availability === "no_body").length;
  const errors = items.filter((item) => item.availability === "error").length;
  const evFail = items.filter((item) => item.prediction && !item.prediction.evidenceVerified).length;
  const failed = items.filter((item) => item.prediction?.failed).length;

  return [
    reviewId,
    `in: ft=${inAv.length}/${inAll.length} include=${count(inAv, "include")} unresolved=${count(inAv, "unresolved")} exclude=${count(inAv, "exclude")}`,
    `ex: ft=${exAv.length}/${exAll.length} exclude=${count(exAv, "exclude")} unresolved=${count(exAv, "unresolved")} include=${count(exAv, "include")}`,
    `no_pmc=${noPmc}`,
    noBody > 0 ? `no_body=${noBody}` : "",
    errors > 0 ? `fetch_err=${errors}` : "",
    evFail > 0 ? `evidence_fail=${evFail}` : "",
    failed > 0 ? `model_fail=${failed}` : "",
  ].filter(Boolean).join(" | ");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let ids: string[];
  if (args.reviews) {
    ids = args.reviews;
  } else {
    const split = await loadOrCreateSplit(args.dir, args.devSize);
    ids = args.split === "all" ? [...split.dev, ...split.test].sort() : split[args.split];
  }
  if (args.limit !== null) ids = ids.slice(0, args.limit);
  if (ids.length === 0) throw new Error("no reviews selected");

  let ncbiKey = args.ncbiKey;
  if (!ncbiKey) {
    ncbiKey = await readFile("NCBI_API_KEY.txt", "utf8").then(parseNcbiApiKey).catch(() => undefined);
  }
  const fulltext = createFullTextClient({
    apiKey: ncbiKey,
    email: args.email,
    tool: "med-pilotdeck-meta",
    cacheDir: args.cacheDir,
  });
  const model = createOpenAiCompatibleClient({
    baseUrl: args.baseUrl,
    model: args.model,
    apiKey: args.apiKey,
    timeoutMs: 300_000,
  });
  const station = createFullTextScreenerStation(model, { evidenceGate: args.evidenceGate });

  console.log(
    `[replay-fulltext] model=${args.model} reviews=${ids.length} evidenceGate=${args.evidenceGate} `
    + `ncbiKey=${ncbiKey ? "yes" : "no"} concurrency=${args.concurrency}`,
  );

  for (const id of ids) {
    const review = await loadBenchmarkReview(benchmarkFile(args.dir, id));
    const criteria = resolveCriteriaSet(review, args.criteria);
    if (criteria.keys.length === 0) {
      console.warn(`${id} skipped: criteria ${args.criteria} resolved to no elements`);
      continue;
    }
    const gold = review.gold.filter((g) => g.label === "in" || g.label === "ex");
    const startedAt = new Date().toISOString();

    // 先批量解析 PMCID，再逐篇取全文（走缓存）。
    const pmcMap = await fulltext.resolvePmcIds(gold.map((g) => g.pmid));
    const fetched = await mapWithConcurrency(gold, 2, async (g) => ({
      gold: g,
      availability: await fulltext.get(g.pmid, pmcMap.get(g.pmid)),
    }));

    const available = fetched.filter((f) => f.availability.status === "available");
    if (available.length < args.minAvailable) {
      console.log(`${id} skipped: only ${available.length} full texts available (min ${args.minAvailable})`);
      continue;
    }

    const items = await mapWithConcurrency(fetched, args.concurrency, async ({ gold: g, availability }) => {
      const record: FullTextItemRecord = {
        pmid: g.pmid,
        goldLabel: g.label,
        availability: availability.status,
        ...("pmcid" in availability && availability.pmcid ? { pmcid: availability.pmcid } : {}),
        ...(availability.status === "error" ? { error: availability.error } : {}),
      };
      if (availability.status === "available") {
        record.prediction = await station.screen({ doc: availability.doc, criteria });
      }
      return record;
    });

    const payload: FullTextStagePrediction = {
      reviewId: review.id,
      stage: "fulltext",
      criteriaSource: criteria.source,
      criteriaKeys: criteria.keys,
      model: { provider: "openai-compatible", model: args.model },
      evidenceGate: args.evidenceGate,
      startedAt,
      finishedAt: new Date().toISOString(),
      items,
    };
    const dir = join(args.out, review.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "screen-fulltext.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(summarize(review.id, items));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
