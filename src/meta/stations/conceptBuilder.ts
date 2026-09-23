import type { StructuredModelClient } from "../../trauma/modelClient.js";
import type { CriteriaSet, PicoKey } from "../benchmark/types.js";
import { CONCEPT_TABLE_SCHEMA, validateConceptTable } from "../schemas.js";
import type { PubMedClient } from "../search/pubmed.js";
import type { ConceptTable, MeshValidation } from "../types.js";
import { CONCEPT_BUILDER_SYSTEM_PROMPT } from "./conceptBuilderPrompt.js";

const ELEMENT_LABEL: Record<PicoKey, string> = {
  P: "P 研究对象",
  I: "I 干预措施",
  C: "C 对照",
  O: "O 结局指标",
  S: "S 研究设计",
};

export function buildCriteriaMessage(criteria: CriteriaSet): string {
  const lines = criteria.keys.map((key) => `${ELEMENT_LABEL[key]}：${criteria.elements[key] ?? ""}`);
  return `<criteria>\n${lines.join("\n\n")}\n</criteria>`;
}

/** 去掉空白词与重复词，保持顺序。 */
function tidyTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, " ").trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * 程序兜底：S 块一律丢掉（研究设计由标准过滤器负责），
 * 并把块数截到 6 个以内，防止检索面被切得太碎导致漏检。
 */
function normalizeTable(table: ConceptTable): ConceptTable {
  const blocks = table.blocks
    .filter((block) => block.element !== "S")
    .map((block) => ({
      element: block.element,
      label: block.label.trim() || ELEMENT_LABEL[block.element],
      meshTerms: tidyTerms(block.meshTerms),
      freeTerms: tidyTerms(block.freeTerms),
      rationale: block.rationale.trim(),
    }))
    .filter((block) => block.meshTerms.length + block.freeTerms.length > 0)
    .slice(0, 6);
  return {
    blocks,
    omittedElements: table.omittedElements.filter((item) => item.element !== "S"),
  };
}

/**
 * 逐个校验 MeSH 词是否真实存在，把不存在的移出 meshTerms。
 *
 * 为什么必须做：模型编造 MeSH 词是这一步最常见的错误，而一个不存在的主题词
 * 会让 PubMed 静默返回零结果或忽略该词，检索式看起来正常但实际已经漏检。
 * 被剔除的词不丢弃，降级成自由词，因为词本身的语义往往是对的。
 */
export async function validateMeshTerms(
  table: ConceptTable,
  pubmed: PubMedClient,
): Promise<{ table: ConceptTable; dropped: MeshValidation[] }> {
  const dropped: MeshValidation[] = [];
  const checked = new Map<string, boolean>();
  const blocks = await Promise.all(
    table.blocks.map(async (block) => {
      const keptMesh: string[] = [];
      const demoted: string[] = [];
      for (const term of block.meshTerms) {
        const key = term.toLowerCase();
        let exists = checked.get(key);
        if (exists === undefined) {
          exists = await pubmed.meshExists(term).catch(() => false);
          checked.set(key, exists);
        }
        if (exists) {
          keptMesh.push(term);
        } else {
          dropped.push({ term, exists: false, blockLabel: block.label });
          demoted.push(term);
        }
      }
      return {
        ...block,
        meshTerms: keptMesh,
        freeTerms: tidyTerms([...block.freeTerms, ...demoted]),
      };
    }),
  );
  return { table: { ...table, blocks }, dropped };
}

export type ConceptBuilderStation = {
  build(input: { criteria: CriteriaSet; signal?: AbortSignal }): Promise<ConceptTable>;
};

export function createConceptBuilderStation(
  model: StructuredModelClient,
): ConceptBuilderStation {
  return {
    async build(input) {
      const raw = await model.completeJson({
        name: "meta_concept_table",
        system: CONCEPT_BUILDER_SYSTEM_PROMPT,
        user: buildCriteriaMessage(input.criteria),
        schema: CONCEPT_TABLE_SCHEMA,
        validate: validateConceptTable,
        signal: input.signal,
      });
      const table = normalizeTable(raw);
      if (table.blocks.length === 0) {
        throw new Error("concept table has no usable blocks after normalization");
      }
      return table;
    },
  };
}
