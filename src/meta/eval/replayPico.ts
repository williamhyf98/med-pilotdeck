/**
 * 步骤 0 回放：Cochrane 评价的 Background + Objectives → PICOS 抽取 → 与金标准 PICO 对比。
 *
 * 输入来源与为什么不能用 Selection criteria，见 cochraneAbstract.ts。
 * 这里打印的对比只是冒烟：逐元素状态，以及金标准内容词在抽取结果里的召回。
 * 正式的 token 级 F1、缺失识别率由评测方基于 predictions/<review>/pico.json 计算。
 *
 * 用法：
 *   tsx src/meta/eval/replayPico.ts --dir reviews_a --reviews CD000028
 *   tsx src/meta/eval/replayPico.ts --dir reviews_a --split dev --limit 20
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  benchmarkFile,
  loadBenchmarkReview,
  loadOrCreateSplit,
} from "../benchmark/load.js";
import { PICO_KEYS, type CriteriaSource } from "../benchmark/types.js";
import { createPubMedClient, parseNcbiApiKey } from "../search/pubmed.js";
import { createPicoExtractorStation } from "../stations/picoExtractor.js";
import type { PicoElementSmoke, PicoStagePrediction } from "../types.js";
import { buildQuestionText, contentRecall, findCochraneAbstract } from "./cochraneAbstract.js";
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
  const goldRaw = map.get("gold") ?? "article_picos";
  return {
    dir: map.get("dir") ?? process.env.META_BENCHMARK_DIR ?? "reviews_a",
    out: map.get("out") ?? "predictions",
    cacheDir: map.get("cache-dir") ?? join(".cache", "cochrane-abstracts"),
    split: (splitRaw === "test" || splitRaw === "all" ? splitRaw : "dev") as "dev" | "test" | "all",
    limit: num("limit"),
    reviews: map.get("reviews")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
    gold: (goldRaw === "refined_picos" ? "refined_picos" : "article_picos") as CriteriaSource,
    devSize: num("dev-size") ?? 100,
    baseUrl: map.get("base-url") ?? process.env.META_MODEL_BASE_URL ?? "http://10.31.112.13:8040/v1",
    model: map.get("model") ?? process.env.META_MODEL ?? "Qwen3.8-27B",
    apiKey: map.get("api-key") ?? process.env.META_MODEL_API_KEY ?? "EMPTY",
    ncbiKey: map.get("ncbi-key") ?? process.env.NCBI_API_KEY ?? undefined,
    email: map.get("email") ?? process.env.NCBI_EMAIL ?? undefined,
  };
}

function formatSmoke(smoke: readonly PicoElementSmoke[], spanVerified: boolean, demoted: readonly string[]): string {
  const parts = smoke.map((item) => {
    const score = !item.goldPresent
      ? "gold_null"
      : item.contentRecall === null
        ? "-"
        : item.contentRecall.toFixed(2);
    return `${item.key}:${item.status}(${score})`;
  });
  parts.push(`span_ok=${spanVerified ? "yes" : `no[${demoted.join(",")}]`}`);
  return parts.join(" ");
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
  const pubmed = createPubMedClient({ apiKey: ncbiKey, email: args.email, tool: "med-pilotdeck-meta" });
  const model = createOpenAiCompatibleClient({ baseUrl: args.baseUrl, model: args.model, apiKey: args.apiKey });
  const station = createPicoExtractorStation(model);

  console.log(`[replay-pico] model=${args.model} reviews=${ids.length} gold=${args.gold} ncbiKey=${ncbiKey ? "yes" : "no"}`);

  const totals = { reviews: 0, noAbstract: 0, spanOk: 0, byStatus: new Map<string, number>() };
  for (const id of ids) {
    const review = await loadBenchmarkReview(benchmarkFile(args.dir, id));
    const startedAt = new Date().toISOString();
    const write = async (payload: PicoStagePrediction) => {
      const dir = join(args.out, review.id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "pico.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    };
    const base = {
      reviewId: review.id,
      stage: "pico" as const,
      model: { provider: "openai-compatible", model: args.model },
      startedAt,
      goldSource: args.gold,
    };

    const abstract = await findCochraneAbstract(pubmed, review, args.cacheDir);
    const question = abstract ? buildQuestionText(abstract) : null;
    if (!abstract || !question) {
      totals.noAbstract += 1;
      console.log(`${review.id} skipped: ${abstract ? "abstract has no Background/Objectives sections" : "PubMed record not found"}`);
      await write({
        ...base,
        finishedAt: new Date().toISOString(),
        input: { pmid: abstract?.pmid ?? null, sections: [], text: "" },
        prediction: null,
        smoke: [],
        failed: true,
        error: abstract ? "no question sections" : "pubmed record not found",
      });
      continue;
    }

    const prediction = await station.extract({ question: question.text });
    const gold = review.criteria[args.gold];
    const smoke: PicoElementSmoke[] = PICO_KEYS.map((key) => {
      const element = prediction.elements.find((item) => item.key === key)!;
      const goldText = gold[key];
      return {
        key,
        status: element.status,
        goldPresent: Boolean(goldText),
        contentRecall: goldText && element.text ? contentRecall(goldText, element.text) : null,
      };
    });
    await write({
      ...base,
      finishedAt: new Date().toISOString(),
      input: { pmid: abstract.pmid, sections: question.sections, text: question.text },
      prediction,
      smoke,
      ...(prediction.failed ? { failed: true, error: prediction.error } : {}),
    });

    totals.reviews += 1;
    if (prediction.spanVerified) totals.spanOk += 1;
    for (const item of smoke) {
      const k = `${item.key}:${item.status}`;
      totals.byStatus.set(k, (totals.byStatus.get(k) ?? 0) + 1);
    }
    console.log(`${review.id} pmid=${abstract.pmid} ${formatSmoke(smoke, prediction.spanVerified, prediction.demoted)}${prediction.failed ? " FAILED" : ""}`);
  }

  const statusLine = [...totals.byStatus.entries()].sort().map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`[replay-pico] done reviews=${totals.reviews} no_abstract=${totals.noAbstract} span_ok=${totals.spanOk}/${totals.reviews} | ${statusLine}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
