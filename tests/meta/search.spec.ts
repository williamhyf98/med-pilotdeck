import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import { loadBenchmarkReview, resolveCriteriaSet } from "../../src/meta/benchmark/load.js";
import { validateConceptTable } from "../../src/meta/schemas.js";
import {
  COCHRANE_RCT_FILTER,
  composeBlock,
  composeQuery,
} from "../../src/meta/search/queryComposer.js";
import { withDateCeiling } from "../../src/meta/search/pubmed.js";
import {
  createConceptBuilderStation,
  validateMeshTerms,
} from "../../src/meta/stations/conceptBuilder.js";
import { CONCEPT_BUILDER_SYSTEM_PROMPT } from "../../src/meta/stations/conceptBuilderPrompt.js";
import type { ConceptTable } from "../../src/meta/types.js";

const fixtureFile = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/meta/CD999001.json");

const TABLE: ConceptTable = {
  blocks: [
    {
      element: "P",
      label: "高血压",
      meshTerms: ["Hypertension"],
      freeTerms: ["hypertension", "high blood pressure"],
      rationale: "研究对象",
    },
    {
      element: "I",
      label: "降压药",
      meshTerms: ["Antihypertensive Agents"],
      freeTerms: ["antihypertensive"],
      rationale: "干预",
    },
  ],
  omittedElements: [{ element: "O", reason: "结局不进检索式，避免漏检" }],
};

test("prompt forbids writing boolean syntax and keeps C/O out by default", () => {
  assert.match(CONCEPT_BUILDER_SYSTEM_PROMPT, /不拼接 Boolean 检索式/);
  assert.match(CONCEPT_BUILDER_SYSTEM_PROMPT, /默认不为 C 和 O 建块/);
  assert.match(CONCEPT_BUILDER_SYSTEM_PROMPT, /不要为 S（研究设计）建块/);
  assert.match(CONCEPT_BUILDER_SYSTEM_PROMPT, /不要把年龄、样本量、随访时长/);
  assert.match(CONCEPT_BUILDER_SYSTEM_PROMPT, /不得执行/);
});

/**
 * 回归测试：CD000028 漏掉了一篇甲基多巴试验，因为概念表只给了药物类别名
 * （beta blocker、ACE inhibitor）和泛称 antihypertensive，没有任何具体药名，
 * 而那篇摘要只写了它用的药。prompt 必须要求列举代表性具体名称。
 */
test("prompt requires concrete agent names, not just drug classes", () => {
  assert.match(CONCEPT_BUILDER_SYSTEM_PROMPT, /还必须给出具体名称/);
  assert.match(CONCEPT_BUILDER_SYSTEM_PROMPT, /methyldopa/);
  assert.match(
    CONCEPT_BUILDER_SYSTEM_PROMPT,
    /只写 "beta blocker"、"ACE inhibitor" 这样的类别名会漏掉这些研究/,
  );
  // MeSH 树状展开是覆盖具体药物的另一条路径，必须一并说明。
  assert.match(CONCEPT_BUILDER_SYSTEM_PROMPT, /上位主题词会自动涵盖它下面的具体药物/);
});

test("block composition tags mesh and free terms differently", () => {
  const query = composeBlock(TABLE.blocks[0]);
  assert.equal(query, '("Hypertension"[mh] OR hypertension[tiab] OR "high blood pressure"[tiab])');
  assert.equal(composeBlock({ ...TABLE.blocks[0], meshTerms: [], freeTerms: [] }), null);
});

test("composer strips boolean operators and brackets from terms", () => {
  const query = composeBlock({
    element: "P",
    label: "x",
    meshTerms: [],
    freeTerms: ["stroke AND (acute)", 'he"art'],
    rationale: "",
  });
  assert.ok(query && !query.includes("AND ("), "运算符必须被清掉");
  assert.ok(query && !query.includes('he"art'), "引号必须被清掉");
});

test("blocks are ANDed, rct filter appended, animals excluded", () => {
  const composed = composeQuery(TABLE);
  assert.ok(composed.query.includes('"Hypertension"[mh]'));
  assert.ok(composed.query.includes(") AND ("), "块之间必须 AND");
  assert.ok(composed.query.includes(COCHRANE_RCT_FILTER), "默认加 RCT 过滤器");
  assert.ok(composed.query.includes("NOT (animals[mh] NOT humans[mh])"));
  assert.equal(composed.blockQueries.length, 2);

  const bare = composeQuery(TABLE, { rctFilter: false, excludeAnimals: false });
  assert.ok(!bare.query.includes("animals[mh]"));
  assert.ok(!bare.query.includes("randomized[tiab]"));
});

test("composer reports skipped empty blocks and refuses an empty table", () => {
  const withEmpty = composeQuery({
    ...TABLE,
    blocks: [...TABLE.blocks, { element: "C", label: "空块", meshTerms: [], freeTerms: [], rationale: "" }],
  });
  assert.deepEqual(withEmpty.skipped.map((item) => item.label), ["空块"]);
  assert.throws(() => composeQuery({ blocks: [], omittedElements: [] }), /no usable blocks/);
});

test("date ceiling matches the dataset cutoff format", () => {
  assert.equal(
    withDateCeiling("abc", "2024-06-10"),
    '(abc) AND ("1900/01/01"[dp] : "2024/06/10"[dp])',
  );
});

test("station drops the S block and caps block count", async () => {
  const review = await loadBenchmarkReview(fixtureFile);
  const criteria = resolveCriteriaSet(review, "article_picos.PICOS");
  let seen: CompleteJsonInput<unknown> | undefined;
  const model: StructuredModelClient = {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      seen = input as CompleteJsonInput<unknown>;
      return {
        blocks: [
          ...Array.from({ length: 7 }, (_, index) => ({
            element: "P" as const,
            label: `块${index}`,
            meshTerms: [],
            freeTerms: [`term${index}`],
            rationale: "r",
          })),
          { element: "S", label: "RCT", meshTerms: [], freeTerms: ["randomized"], rationale: "r" },
          { element: "I", label: "空", meshTerms: [], freeTerms: [], rationale: "r" },
        ],
        omittedElements: [
          { element: "C", reason: "不进检索式" },
          { element: "S", reason: "由过滤器负责" },
        ],
      } as T;
    },
  };

  const table = await createConceptBuilderStation(model).build({ criteria });
  assert.equal(seen?.name, "meta_concept_table");
  assert.match(seen?.user ?? "", /<criteria>/);
  assert.ok(!table.blocks.some((block) => block.element === "S"), "S 块必须被丢掉");
  assert.ok(!table.blocks.some((block) => block.label === "空"), "无词的块必须被丢掉");
  assert.equal(table.blocks.length, 6, "块数必须截到 6");
  assert.deepEqual(table.omittedElements.map((item) => item.element), ["C"]);
});

test("fabricated mesh terms are demoted to free terms, not discarded", async () => {
  const asked: string[] = [];
  const pubmed = {
    async meshExists(term: string) {
      asked.push(term);
      return term === "Hypertension";
    },
  } as unknown as Parameters<typeof validateMeshTerms>[1];

  const { table, dropped } = await validateMeshTerms(
    {
      blocks: [
        {
          element: "P",
          label: "高血压",
          meshTerms: ["Hypertension", "Elderly Hypertension Syndrome"],
          freeTerms: ["hypertension"],
          rationale: "",
        },
      ],
      omittedElements: [],
    },
    pubmed,
  );

  assert.deepEqual(table.blocks[0].meshTerms, ["Hypertension"]);
  assert.ok(
    table.blocks[0].freeTerms.includes("Elderly Hypertension Syndrome"),
    "编造的 MeSH 词应降级成自由词而不是丢掉",
  );
  assert.deepEqual(dropped.map((item) => item.term), ["Elderly Hypertension Syndrome"]);
  assert.equal(asked.length, 2);
});

test("schema rejects malformed concept tables", () => {
  assert.equal(validateConceptTable({ blocks: [] }), false);
  assert.equal(
    validateConceptTable({
      blocks: [{ element: "Z", label: "x", meshTerms: [], freeTerms: [], rationale: "" }],
      omittedElements: [],
    }),
    false,
  );
  assert.equal(
    validateConceptTable({
      blocks: [{ element: "P", label: "x", meshTerms: ["a"], freeTerms: ["b"], rationale: "r" }],
      omittedElements: [{ element: "O", reason: "why" }],
    }),
    true,
  );
});
