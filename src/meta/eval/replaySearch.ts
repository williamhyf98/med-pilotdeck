/**
 * 步骤 1 回放：gold PICO → 概念表 → 检索式 → 去 PubMed 量召回。
 *
 * 为什么用 gold PICO 当输入：把"PICO 抽得准不准"和"检索式写得好不好"分开。
 * 抽取工位还没做，若用自己抽的 PICO，一步错会连累下一步，看不出问题出在哪。
 *
 * 评价标准不是"命中数越多越好"。Cochrane 原检索式召回率常常是 100%，代价是
 * 命中十几万条。真正的目标是召回率持平，而命中数明显更少。所以两个数字要一起看。
 *
 * 用法：
 *   tsx src/meta/eval/replaySearch.ts --dir reviews_a --reviews CD000028
 *   tsx src/meta/eval/replaySearch.ts --dir reviews_a --split dev --limit 10 --baseline
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  benchmarkFile,
  loadBenchmarkReview,
  loadOrCreateSplit,
  resolveCriteriaSet,
} from "../benchmark/load.js";
import { createPubMedClient, parseNcbiApiKey, withDateCeiling } from "../search/pubmed.js";
import { composeQuery } from "../search/queryComposer.js";
import {
  createConceptBuilderStation,
  validateMeshTerms,
} from "../stations/conceptBuilder.js";
import type { SearchStagePrediction } from "../types.js";
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
    split: (splitRaw === "test" || splitRaw === "all" ? splitRaw : "dev") as "dev" | "test" | "all",
    limit: num("limit"),
    reviews: map.get("reviews")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
    criteria: map.get("criteria") ?? "article_picos.PICOS",
    // 默认不跑基线，因为那是每篇额外两次 PubMed 请求。
    baseline: map.get("baseline") === "true",
    rctFilter: map.get("no-rct-filter") !== "true",
    devSize: num("dev-size") ?? 100,
    baseUrl: map.get("base-url") ?? process.env.META_MODEL_BASE_URL ?? "http://10.31.112.13:8040/v1",
    model: map.get("model") ?? process.env.META_MODEL ?? "Qwen3.8-27B",
    apiKey: map.get("api-key") ?? process.env.META_MODEL_API_KEY ?? "EMPTY",
    ncbiKey: map.get("ncbi-key") ?? process.env.NCBI_API_KEY ?? undefined,
    email: map.get("email") ?? process.env.NCBI_EMAIL ?? undefined,
  };
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
  const station = createConceptBuilderStation(model);
  // 密钥优先级：命令行 > 环境变量 > 仓库根目录的 NCBI_API_KEY.txt。
  // 文件里常带着 "NCBI_API_KEY=" 前缀或引号，parseNcbiApiKey 负责抽出真正的 key。
  let ncbiKey = args.ncbiKey;
  if (!ncbiKey) {
    ncbiKey = await readFile("NCBI_API_KEY.txt", "utf8").then(parseNcbiApiKey).catch(() => undefined);
  }
  const pubmed = createPubMedClient({
    apiKey: ncbiKey,
    email: args.email,
    tool: "med-pilotdeck-meta",
  });

  console.log(
    `[replay-search] model=${args.model} reviews=${ids.length} `
    + `rctFilter=${args.rctFilter} baseline=${args.baseline} ncbiKey=${ncbiKey ? "yes" : "no"}`,
  );

  for (const id of ids) {
    const review = await loadBenchmarkReview(benchmarkFile(args.dir, id));
    const criteria = resolveCriteriaSet(review, args.criteria);
    const goldIn = review.gold.filter((g) => g.label === "in").map((g) => g.pmid);
    const startedAt = new Date().toISOString();

    const write = async (payload: SearchStagePrediction) => {
      const dir = join(args.out, review.id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "search.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    };

    try {
      if (criteria.keys.length === 0) throw new Error(`criteria ${args.criteria} has no elements`);

      const rawTable = await station.build({ criteria });
      const { table, dropped } = await validateMeshTerms(rawTable, pubmed);
      const composed = composeQuery(table, { rctFilter: args.rctFilter });
      const executedQuery = withDateCeiling(composed.query, review.search.cutoff);

      const total = await pubmed.count(executedQuery);
      const recallIn = await pubmed.recallCheck(executedQuery, goldIn);

      // 每块单独的命中数：哪一块把结果卡窄了，一眼能看出来。
      const blockHitCounts: { label: string; count: number }[] = [];
      for (const block of composed.blockQueries) {
        const one = await pubmed.count(withDateCeiling(block.query, review.search.cutoff));
        blockHitCounts.push({ label: block.label, count: one.count });
      }

      let baseline: SearchStagePrediction["baseline"] = null;
      if (args.baseline && review.search.query) {
        const baseQuery = withDateCeiling(review.search.query, review.search.cutoff);
        const baseCount = await pubmed.count(baseQuery);
        const baseRecall = await pubmed.recallCheck(baseQuery, goldIn);
        baseline = {
          hitCount: baseCount.count,
          recallIn: baseRecall.hits.length,
          totalIn: goldIn.length,
        };
      }

      const payload: SearchStagePrediction = {
        reviewId: review.id,
        stage: "search",
        criteriaSource: criteria.source,
        model: { provider: "openai-compatible", model: args.model },
        startedAt,
        finishedAt: new Date().toISOString(),
        conceptTable: table,
        droppedMeshTerms: dropped,
        query: composed.query,
        executedQuery,
        hitCount: total.count,
        blockHitCounts,
        recall: [{
          label: "in",
          total: goldIn.length,
          hit: recallIn.hits.length,
          missed: recallIn.missed,
          absent: recallIn.absent,
        }],
        baseline,
      };
      await write(payload);

      const denom = goldIn.length - recallIn.absent.length;
      const rate = denom > 0 ? (recallIn.hits.length / denom).toFixed(3) : "n/a";
      const parts = [
        review.id,
        `blocks=${table.blocks.length}`,
        `hits=${total.count}`,
        `recall_in=${rate}(${recallIn.hits.length}/${denom})`,
      ];
      if (recallIn.absent.length > 0) parts.push(`absent=${recallIn.absent.length}`);
      if (dropped.length > 0) parts.push(`bad_mesh=${dropped.length}`);
      if (total.phrasesNotFound.length > 0) {
        parts.push(`notfound=${total.phrasesNotFound.slice(0, 3).join("|")}`);
      }
      if (baseline) {
        parts.push(`baseline_hits=${baseline.hitCount}`);
        parts.push(`baseline_recall=${baseline.recallIn}/${baseline.totalIn}`);
      }
      console.log(parts.join(" "));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${review.id} FAILED ${message}`);
      await write({
        reviewId: review.id,
        stage: "search",
        criteriaSource: criteria.source,
        model: { provider: "openai-compatible", model: args.model },
        startedAt,
        finishedAt: new Date().toISOString(),
        conceptTable: { blocks: [], omittedElements: [] },
        droppedMeshTerms: [],
        query: "",
        executedQuery: "",
        hitCount: 0,
        blockHitCounts: [],
        recall: [],
        baseline: null,
        failed: true,
        error: message,
      });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
