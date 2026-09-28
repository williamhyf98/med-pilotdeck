import type { StructuredModelClient } from "../../trauma/modelClient.js";
import { PICO_KEYS, type PicoKey } from "../benchmark/types.js";
import { PICO_EXTRACTION_SCHEMA, validatePicoExtraction } from "../schemas.js";
import type { PicoElement, PicoExtraction, PicoExtractionPrediction } from "../types.js";
import { PICO_EXTRACTOR_SYSTEM_PROMPT } from "./picoExtractorPrompt.js";

export function buildQuestionBlock(text: string): string {
  return `<question>\n${text.trim()}\n</question>`;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

const DEFAULT_FOLLOW_UP: Record<PicoKey, string> = {
  P: "请说明研究对象：哪类人群或疾病，是否限定年龄段或场景？",
  I: "请说明要评价的干预或暴露是什么？",
  C: "请说明对照组是安慰剂、不治疗、常规治疗还是另一种干预？",
  O: "请说明关注的主要结局和次要结局是什么？",
  S: "请说明只纳入随机对照试验，还是也接受其他研究设计？",
};

function tidyList(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.replace(/\s+/g, " ").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 程序兜底，三件事：
 *   1. 对齐到 P I C O S 五个元素，漏答的补 missing，多答的丢掉；
 *   2. extracted 的 sourceSpan 必须能在输入里找到，找不到就降为 inferred——
 *      推断不是错，但冒充原文依据是错，医生看到 extracted 会少一次确认；
 *   3. missing 不能带 text（那就是替医生补全），inferred/missing 必须带追问。
 */
export function guardExtraction(
  raw: PicoExtraction,
  question: string,
): { extraction: PicoExtraction; spanVerified: boolean; demoted: PicoKey[] } {
  const haystack = normalize(question);
  const byKey = new Map(raw.elements.map((item) => [item.key, item]));
  const demoted: PicoKey[] = [];
  const elements: PicoElement[] = PICO_KEYS.map((key) => {
    const found = byKey.get(key);
    if (!found) {
      return { key, status: "missing", text: "", sourceSpan: "", followUpQuestion: `模型未对该元素作答。${DEFAULT_FOLLOW_UP[key]}` };
    }
    const text = found.text.replace(/\s+/g, " ").trim();
    const span = found.sourceSpan.replace(/\s+/g, " ").trim();
    const followUp = found.followUpQuestion.replace(/\s+/g, " ").trim();
    if (found.status === "extracted") {
      if (span && haystack.includes(normalize(span))) {
        return { key, status: "extracted", text, sourceSpan: span, followUpQuestion: "" };
      }
      demoted.push(key);
      return {
        key,
        status: "inferred",
        text,
        sourceSpan: "",
        followUpQuestion: followUp || `该元素的原文依据未能核实，请确认：${text || DEFAULT_FOLLOW_UP[key]}`,
      };
    }
    if (found.status === "missing") {
      return { key, status: "missing", text: "", sourceSpan: "", followUpQuestion: followUp || DEFAULT_FOLLOW_UP[key] };
    }
    if (!text) {
      // 说是推断却没给内容，等于没说。
      return { key, status: "missing", text: "", sourceSpan: "", followUpQuestion: followUp || DEFAULT_FOLLOW_UP[key] };
    }
    return { key, status: "inferred", text, sourceSpan: "", followUpQuestion: followUp || `请确认推断是否正确：${text}` };
  });
  return {
    extraction: {
      elements,
      draftCriteria: {
        inclusion: tidyList(raw.draftCriteria.inclusion),
        exclusion: tidyList(raw.draftCriteria.exclusion),
      },
      notes: raw.notes.trim(),
    },
    spanVerified: demoted.length === 0,
    demoted,
  };
}

export type PicoExtractorStation = {
  extract(input: { question: string; signal?: AbortSignal }): Promise<PicoExtractionPrediction>;
};

export function createPicoExtractorStation(model: StructuredModelClient): PicoExtractorStation {
  return {
    async extract(input) {
      try {
        const raw = await model.completeJson({
          name: "meta_pico_extract",
          system: PICO_EXTRACTOR_SYSTEM_PROMPT,
          user: buildQuestionBlock(input.question),
          schema: PICO_EXTRACTION_SCHEMA,
          validate: validatePicoExtraction,
          signal: input.signal,
        });
        const guarded = guardExtraction(raw, input.question);
        return { ...guarded.extraction, spanVerified: guarded.spanVerified, demoted: guarded.demoted };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        return {
          elements: PICO_KEYS.map((key) => ({
            key,
            status: "missing" as const,
            text: "",
            sourceSpan: "",
            followUpQuestion: DEFAULT_FOLLOW_UP[key],
          })),
          draftCriteria: { inclusion: [], exclusion: [] },
          notes: "模型调用失败，未能结构化",
          spanVerified: false,
          demoted: [],
          failed: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
