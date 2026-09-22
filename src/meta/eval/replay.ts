/**
 * 基准回放入口：拿 reviews_a 的评价，跑指定工位，把预测写进 predictions 目录。
 *
 * 正式指标由评测方的评分器基于 predictions 计算。这里只在控制台打一行
 * 冒烟数字（保留了多少条金标准），用于开发时快速判断改动方向，不落盘、
 * 不作为对外口径。
 *
 * 用法：
 *   tsx src/meta/eval/replay.ts --dir <reviews_a> --split dev --limit 5
 *   tsx src/meta/eval/replay.ts --dir <reviews_a> --reviews CD000028,CD000029
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  benchmarkFile,
  loadBenchmarkReview,
  loadOrCreateSplit,
  resolveCriteriaSet,
} from "../benchmark/load.js";
import type { BenchmarkReview } from "../benchmark/types.js";
import { createScreenerStation } from "../stations/screener.js";
import type { ScreeningPrediction, ScreeningStagePrediction } from "../types.js";
import { createOpenAiCompatibleClient } from "./openaiClient.js";

type Args = {
  dir: string;
  out: string;
  split: "dev" | "test" | "all";
  limit: number | null;
  reviews: string[] | null;
  criteria: string | null;
  maxCandidates: number | null;
  concurrency: number;
  baseUrl: string;
  model: string;
  apiKey: string;
  devSize: number;
};

function parseArgs(argv: readonly string[]): Args {
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
  const number = (key: string): number | null => {
    const raw = map.get(key);
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  };
  const splitRaw = map.get("split") ?? "dev";
  return {
    dir: map.get("dir") ?? process.env.META_BENCHMARK_DIR ?? "reviews_a",
    out: map.get("out") ?? "predictions",
    split: splitRaw === "test" || splitRaw === "all" ? splitRaw : "dev",
    limit: number("limit"),
    reviews: map.get("reviews")?.split(",").map((item) => item.trim()).filter(Boolean) ?? null,
    criteria: map.get("criteria") ?? null,
    maxCandidates: number("max-candidates"),
    concurrency: number("concurrency") ?? 4,
    baseUrl: map.get("base-url") ?? process.env.META_MODEL_BASE_URL ?? "http://10.31.112.13:8040/v1",
    model: map.get("model") ?? process.env.META_MODEL ?? "Qwen3.8-27B",
    apiKey: map.get("api-key") ?? process.env.META_MODEL_API_KEY ?? "EMPTY",
    devSize: number("dev-size") ?? 100,
  };
}

/** 固定并发的任务池，保持输入顺序返回。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 金标准按标签分开统计。
 *
 * retain_gold_labels 把 in 与 ex 都算作"题摘阶段应当保留"，因为 Cochrane 也是
 * 检索到之后读全文才排除的。但这两类的含义完全不同：
 *   - in：最终纳入。漏掉就是真漏，这是敏感度的硬指标。
 *   - ex：检索到、读全文后排除。模型在题摘阶段就排掉它，往往是提前做了
 *         全文筛选的工作，不一定是错误。
 * 合成一个数字会把后者的"提前排除"记成漏检，掩盖真实敏感度，所以分开报。
 */
function goldByLabel(review: BenchmarkReview): { included: Set<string>; excluded: Set<string> } {
  const labels = new Set(review.screening.initial.retain_gold_labels ?? ["in", "ex"]);
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const item of review.gold) {
    if (!labels.has(item.label)) continue;
    (item.label === "in" ? included : excluded).add(item.pmid);
  }
  return { included, excluded };
}

function ratio(kept: number, total: number): string {
  return total > 0 ? (kept / total).toFixed(3) : "n/a";
}

function summarize(review: BenchmarkReview, predictions: readonly ScreeningPrediction[]): string {
  const { included: goldIn, excluded: goldEx } = goldByLabel(review);
  const keptPmids = new Set(
    predictions.filter((item) => item.decision === "include").map((item) => item.pmid),
  );
  const keptIn = [...goldIn].filter((pmid) => keptPmids.has(pmid)).length;
  const keptEx = [...goldEx].filter((pmid) => keptPmids.has(pmid)).length;
  const isGold = (pmid: string) => goldIn.has(pmid) || goldEx.has(pmid);
  const negatives = predictions.filter((item) => !isGold(item.pmid));
  const negativesDropped = negatives.filter((item) => item.decision === "exclude").length;
  const failed = predictions.filter((item) => item.failed).length;
  const spliced = predictions.filter((item) => item.evidenceFailure === "spliced").length;
  const missing = predictions.filter((item) => item.evidenceFailure === "missing").length;
  return [
    review.id,
    `n=${predictions.length}`,
    // 真正的敏感度：最终纳入的研究有没有被留下。
    `sens_in=${ratio(keptIn, goldIn.size)}(${keptIn}/${goldIn.size})`,
    // 参考值：全文阶段才被排除的研究，题摘阶段留下了多少。
    `kept_ex=${ratio(keptEx, goldEx.size)}(${keptEx}/${goldEx.size})`,
    `spec=${ratio(negativesDropped, negatives.length)}(${negativesDropped}/${negatives.length})`,
    failed > 0 ? `failed=${failed}` : "",
    spliced > 0 ? `span_spliced=${spliced}` : "",
    missing > 0 ? `span_missing=${missing}` : "",
  ]
    .filter(Boolean)
    .join(" ");
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

  const model = createOpenAiCompatibleClient({
    baseUrl: args.baseUrl,
    model: args.model,
    apiKey: args.apiKey,
  });
  const station = createScreenerStation(model);

  console.log(`[replay] model=${args.model} reviews=${ids.length} concurrency=${args.concurrency}`);

  for (const id of ids) {
    const review = await loadBenchmarkReview(benchmarkFile(args.dir, id));
    const option = args.criteria
      ?? review.screening.initial.criteria_options.at(-1)
      ?? "article_picos.PICOS";
    const criteria = resolveCriteriaSet(review, option);
    if (criteria.keys.length === 0) {
      console.warn(`[replay] ${id} skipped: criteria option ${option} resolved to no elements`);
      continue;
    }
    const candidates = args.maxCandidates !== null
      ? review.candidates.slice(0, args.maxCandidates)
      : review.candidates;

    const startedAt = new Date().toISOString();
    const predictions = await mapWithConcurrency(candidates, args.concurrency, (record) =>
      station.screen({ record, criteria }));
    const payload: ScreeningStagePrediction = {
      reviewId: review.id,
      stage: "initial",
      criteriaSource: criteria.source,
      criteriaKeys: criteria.keys,
      model: { provider: "openai-compatible", model: args.model },
      startedAt,
      finishedAt: new Date().toISOString(),
      predictions,
    };
    const dir = join(args.out, review.id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "screen-initial.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    console.log(summarize(review, predictions));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
