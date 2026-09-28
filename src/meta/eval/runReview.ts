/**
 * 全流程运行：对一篇基准评价跑 题摘筛选 → 全文筛选，带状态、预算与断点续跑。
 *
 * 与 replay.ts / replayFullText.ts 的区别：那两个是"单工位回放"，每条候选独立打分；
 * 这个是"运行系统"视角——同一篇评价的所有条目在一个 ReviewState 里推进，
 * 排除/纳入按提交规则落盘，拿不准的进人工队列，重跑只补没做完的。
 *
 * 用法：
 *   tsx src/meta/eval/runReview.ts --dir reviews_a --reviews CD000028
 *   tsx src/meta/eval/runReview.ts --dir reviews_a --reviews CD000028 --steps abstract
 *   tsx src/meta/eval/runReview.ts --dir reviews_a --reviews CD000028 --no-evidence-gate   # B0 基线
 *   中断后原样重跑即续跑；改了标准要加 --allow-relock。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  benchmarkFile,
  loadBenchmarkReview,
  loadOrCreateSplit,
  resolveCriteriaSet,
} from "../benchmark/load.js";
import type { BenchmarkReview } from "../benchmark/types.js";
import { createFullTextClient } from "../fulltext/pmc.js";
import { createMetaReviewRunner, summarizeLedger, type RunnerStep } from "../runner.js";
import { parseNcbiApiKey } from "../search/pubmed.js";
import type { ItemState, ReviewState } from "../state/types.js";
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
  const steps = (map.get("steps") ?? "abstract,fulltext")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is RunnerStep => s === "abstract" || s === "fulltext");
  return {
    dir: map.get("dir") ?? process.env.META_BENCHMARK_DIR ?? "reviews_a",
    out: map.get("out") ?? "predictions",
    stateRoot: map.get("state-root") ?? "state",
    cacheDir: map.get("cache-dir") ?? join(".cache", "fulltext"),
    split: (splitRaw === "test" || splitRaw === "all" ? splitRaw : "dev") as "dev" | "test" | "all",
    limit: num("limit"),
    reviews: map.get("reviews")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
    criteria: map.get("criteria") ?? null,
    fulltextCriteria: map.get("fulltext-criteria") ?? "refined_picos.PICOS",
    steps,
    maxCandidates: num("max-candidates"),
    concurrency: num("concurrency") ?? 4,
    evidenceGate: map.get("no-evidence-gate") !== "true",
    fulltext: map.get("no-fulltext") !== "true",
    allowRelock: map.get("allow-relock") === "true",
    devSize: num("dev-size") ?? 100,
    baseUrl: map.get("base-url") ?? process.env.META_MODEL_BASE_URL ?? "http://10.31.112.13:8040/v1",
    model: map.get("model") ?? process.env.META_MODEL ?? "Qwen3.8-27B",
    apiKey: map.get("api-key") ?? process.env.META_MODEL_API_KEY ?? "EMPTY",
    ncbiKey: map.get("ncbi-key") ?? process.env.NCBI_API_KEY ?? undefined,
    email: map.get("email") ?? process.env.NCBI_EMAIL ?? undefined,
  };
}

type Outcome = "include" | "exclude" | "escalated" | "pending";

function outcomeOf(item: ItemState | undefined): Outcome {
  if (!item) return "pending";
  if (item.finalDecision === "include" || item.finalDecision === "exclude") return item.finalDecision;
  if (item.escalation) return "escalated";
  return "pending";
}

/** 冒烟摘要：金标准在最终状态里落到了哪里。正式指标由评测方算。 */
function goldSummary(review: BenchmarkReview, state: ReviewState): string {
  const tally = (label: "in" | "ex") => {
    const counts: Record<Outcome, number> = { include: 0, exclude: 0, escalated: 0, pending: 0 };
    let n = 0;
    for (const gold of review.gold) {
      if (gold.label !== label) continue;
      const item = state.items[gold.pmid];
      if (!item) continue;
      n += 1;
      counts[outcomeOf(item)] += 1;
    }
    return `gold_${label}(n=${n}): include=${counts.include} exclude=${counts.exclude} escalated=${counts.escalated} pending=${counts.pending}`;
  };
  return `${tally("in")} | ${tally("ex")}`;
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
  const model = createOpenAiCompatibleClient({
    baseUrl: args.baseUrl,
    model: args.model,
    apiKey: args.apiKey,
    timeoutMs: 300_000,
  });
  const fulltext = args.fulltext
    ? createFullTextClient({ apiKey: ncbiKey, email: args.email, tool: "med-pilotdeck-meta", cacheDir: args.cacheDir })
    : null;
  const runner = createMetaReviewRunner({
    model,
    stateRoot: args.stateRoot,
    fulltext,
    evidenceGate: args.evidenceGate,
    concurrency: args.concurrency,
  });

  console.log(
    `[run-review] model=${args.model} reviews=${ids.length} steps=${args.steps.join(",")} `
    + `evidenceGate=${args.evidenceGate} fulltext=${args.fulltext} ncbiKey=${ncbiKey ? "yes" : "no"} state=${args.stateRoot}`,
  );

  for (const id of ids) {
    const review = await loadBenchmarkReview(benchmarkFile(args.dir, id));
    const option = args.criteria
      ?? review.screening.initial.criteria_options.at(-1)
      ?? "article_picos.PICOS";
    const criteria = resolveCriteriaSet(review, option);
    if (criteria.keys.length === 0) {
      console.warn(`${id} skipped: criteria ${option} resolved to no elements`);
      continue;
    }
    const fulltextCriteria = resolveCriteriaSet(review, args.fulltextCriteria);
    const candidates = args.maxCandidates !== null
      ? review.candidates.slice(0, args.maxCandidates)
      : review.candidates;

    let lastLog = Date.now();
    const result = await runner.run({
      reviewId: review.id,
      criteria,
      fulltextCriteria: fulltextCriteria.keys.length > 0 ? fulltextCriteria : criteria,
      candidates,
      steps: args.steps,
      allowCriteriaRelock: args.allowRelock,
      onProgress: (progress) => {
        if (Date.now() - lastLog < 15_000 && progress.done < progress.total) return;
        lastLog = Date.now();
        console.log(`  ${id} ${progress.step} ${progress.done}/${progress.total}`);
      },
    });

    const dir = join(args.out, review.id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "pipeline.json"),
      `${JSON.stringify({
        reviewId: review.id,
        round: result.state.round,
        criteriaVersion: result.state.criteria?.criteriaVersion ?? null,
        evidenceGate: args.evidenceGate,
        model: { provider: "openai-compatible", model: args.model },
        ledger: result.ledger,
        budget: result.budget,
        decisions: Object.values(result.state.items).map((item) => ({
          pmid: item.pmid,
          stage: item.stage,
          outcome: outcomeOf(item),
          abstract: item.abstractDecision?.decision ?? null,
          fulltext: item.fulltextDecision?.decision ?? null,
          escalation: item.escalation?.reason ?? null,
        })),
      }, null, 2)}\n`,
      "utf8",
    );
    console.log(`${review.id} round=${result.state.round} ${summarizeLedger(result.ledger, result.budget)}`);
    console.log(`${review.id} ${goldSummary(review, result.state)}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
