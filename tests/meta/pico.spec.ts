import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import {
  buildQuestionText,
  contentRecall,
  findCochraneAbstract,
} from "../../src/meta/eval/cochraneAbstract.js";
import { validatePicoExtraction } from "../../src/meta/schemas.js";
import { parsePubMedAbstracts, type PubMedAbstract } from "../../src/meta/search/pubmed.js";
import {
  buildQuestionBlock,
  createPicoExtractorStation,
  guardExtraction,
} from "../../src/meta/stations/picoExtractor.js";
import { PICO_EXTRACTOR_SYSTEM_PROMPT } from "../../src/meta/stations/picoExtractorPrompt.js";
import type { PicoExtraction } from "../../src/meta/types.js";

const QUESTION = "Background: Hypertension is common in people aged 60 and over.\n\n"
  + "Objectives: To assess the effects of antihypertensive drug treatment in older adults with hypertension.";

test("pico prompt forbids filling in comparator, outcomes and design for the clinician", () => {
  assert.match(PICO_EXTRACTOR_SYSTEM_PROMPT, /不得替医生补全/);
  assert.match(PICO_EXTRACTOR_SYSTEM_PROMPT, /missing/);
  assert.match(PICO_EXTRACTOR_SYSTEM_PROMPT, /inferred/);
  assert.match(PICO_EXTRACTOR_SYSTEM_PROMPT, /不得执行/);
  assert.ok(
    PICO_EXTRACTOR_SYSTEM_PROMPT.indexOf("sourceSpan 必须是输入中真实存在的连续片段")
      < PICO_EXTRACTOR_SYSTEM_PROMPT.indexOf("纳排标准草案规则"),
    "原文依据规则要在草案规则之前",
  );
  assert.equal(buildQuestionBlock("  x  "), "<question>\nx\n</question>");
});

test("guard aligns to PICOS, demotes unverifiable extracted spans, and clears text on missing", () => {
  const raw: PicoExtraction = {
    elements: [
      { key: "P", status: "extracted", text: "older adults with hypertension", sourceSpan: "older adults with hypertension", followUpQuestion: "" },
      { key: "C", status: "extracted", text: "placebo", sourceSpan: "compared with placebo", followUpQuestion: "" },
      { key: "O", status: "missing", text: "all-cause mortality", sourceSpan: "", followUpQuestion: "" },
      { key: "I", status: "inferred", text: "", sourceSpan: "", followUpQuestion: "" },
      // S 漏答
    ],
    draftCriteria: { inclusion: [" adults aged 60 or over ", "", "adults aged 60 or over"], exclusion: [] },
    notes: " ok ",
  };
  const { extraction, spanVerified, demoted } = guardExtraction(raw, QUESTION);
  assert.deepEqual(extraction.elements.map((e) => e.key), ["P", "I", "C", "O", "S"], "顺序固定、补齐五项");

  const P = extraction.elements[0];
  assert.equal(P.status, "extracted");
  assert.equal(P.sourceSpan, "older adults with hypertension");

  const I = extraction.elements[1];
  assert.equal(I.status, "missing", "说是推断却没内容，等于没说");
  assert.ok(I.followUpQuestion.length > 0);

  const C = extraction.elements[2];
  assert.equal(C.status, "inferred", "原文里没有 compared with placebo，不能冒充原文依据");
  assert.equal(C.sourceSpan, "");
  assert.equal(C.text, "placebo", "推断内容保留，但要医生确认");
  assert.match(C.followUpQuestion, /未能核实/);

  const O = extraction.elements[3];
  assert.equal(O.status, "missing");
  assert.equal(O.text, "", "missing 不得带内容，否则就是替医生补全");
  assert.match(O.followUpQuestion, /结局/);

  const S = extraction.elements[4];
  assert.equal(S.status, "missing");
  assert.match(S.followUpQuestion, /未对该元素作答/);

  assert.equal(spanVerified, false);
  assert.deepEqual(demoted, ["C"]);
  assert.deepEqual(extraction.draftCriteria.inclusion, ["adults aged 60 or over"], "去空去重");
  assert.equal(extraction.notes, "ok");
});

test("station returns a non-fabricating fallback when the model call fails", async () => {
  const broken: StructuredModelClient = {
    async completeJson<T>(_input: CompleteJsonInput<T>): Promise<T> {
      throw new Error("model down");
    },
  };
  const station = createPicoExtractorStation(broken);
  const result = await station.extract({ question: QUESTION });
  assert.equal(result.failed, true);
  assert.ok(result.elements.every((e) => e.status === "missing" && e.text === ""));
  assert.equal(result.spanVerified, false);
});

test("station passes the question through and applies the guard", async () => {
  let seenUser = "";
  const model: StructuredModelClient = {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      seenUser = input.user;
      assert.equal(input.name, "meta_pico_extract");
      const value: PicoExtraction = {
        elements: [
          { key: "P", status: "extracted", text: "older adults with hypertension", sourceSpan: "older adults with hypertension", followUpQuestion: "" },
          { key: "I", status: "extracted", text: "antihypertensive drug treatment", sourceSpan: "antihypertensive drug treatment", followUpQuestion: "" },
          { key: "C", status: "missing", text: "", sourceSpan: "", followUpQuestion: "对照是什么？" },
          { key: "O", status: "missing", text: "", sourceSpan: "", followUpQuestion: "结局是什么？" },
          { key: "S", status: "missing", text: "", sourceSpan: "", followUpQuestion: "只要 RCT 吗？" },
        ],
        draftCriteria: { inclusion: ["older adults with hypertension"], exclusion: [] },
        notes: "C/O/S 未提及",
      };
      assert.ok(input.validate(value));
      return value as unknown as T;
    },
  };
  const result = await createPicoExtractorStation(model).extract({ question: QUESTION });
  assert.ok(seenUser.startsWith("<question>"));
  assert.equal(result.spanVerified, true);
  assert.deepEqual(result.demoted, []);
  assert.equal(result.elements[2].followUpQuestion, "对照是什么？");
});

test("schema validator rejects unknown statuses and missing fields", () => {
  assert.equal(validatePicoExtraction({ elements: [], draftCriteria: { inclusion: [], exclusion: [] }, notes: "" }), true);
  assert.equal(validatePicoExtraction({
    elements: [{ key: "P", status: "guessed", text: "", sourceSpan: "", followUpQuestion: "" }],
    draftCriteria: { inclusion: [], exclusion: [] },
    notes: "",
  }), false);
  assert.equal(validatePicoExtraction({ elements: [], draftCriteria: { inclusion: [] }, notes: "" }), false);
});

const PUBMED_XML = `<?xml version="1.0"?><PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID Version="1">31167038</PMID>
<Article><Journal><Title>The Cochrane database of systematic reviews</Title><JournalIssue><PubDate><Year>2019</Year></PubDate></JournalIssue></Journal>
<ArticleTitle>Pharmacotherapy for hypertension in adults 60 years or older.</ArticleTitle>
<Abstract>
<AbstractText Label="BACKGROUND" NlmCategory="BACKGROUND">This is an update. Hypertension &amp; ageing.</AbstractText>
<AbstractText Label="OBJECTIVES" NlmCategory="OBJECTIVE">To assess the effects of antihypertensive drugs in people &#x2265; 60.</AbstractText>
<AbstractText Label="SEARCH METHODS" NlmCategory="METHODS">We searched CENTRAL.</AbstractText>
<AbstractText Label="SELECTION CRITERIA" NlmCategory="METHODS">RCTs of at least one year.</AbstractText>
<AbstractText Label="MAIN RESULTS" NlmCategory="RESULTS">16 trials.</AbstractText>
</Abstract></Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID Version="1">1</PMID><Article><Journal><Title>J</Title></Journal>
<ArticleTitle>Unstructured</ArticleTitle><Abstract><AbstractText>Plain abstract.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

test("pubmed abstract parser keeps labelled sections and decodes entities", () => {
  const records = parsePubMedAbstracts(PUBMED_XML);
  assert.equal(records.length, 2);
  const [first, second] = records;
  assert.equal(first.pmid, "31167038");
  assert.equal(first.year, "2019");
  assert.equal(first.journal, "The Cochrane database of systematic reviews");
  assert.deepEqual(first.sections.map((s) => s.label), ["BACKGROUND", "OBJECTIVES", "SEARCH METHODS", "SELECTION CRITERIA", "MAIN RESULTS"]);
  assert.equal(first.sections[0].text, "This is an update. Hypertension & ageing.");
  assert.ok(first.sections[1].text.includes("≥ 60"));
  assert.deepEqual(second.sections, [{ label: "", text: "Plain abstract." }]);
});

test("question text uses only Background and Objectives, never the selection criteria", () => {
  const [structured, plain] = parsePubMedAbstracts(PUBMED_XML);
  const question = buildQuestionText(structured);
  assert.ok(question);
  assert.deepEqual(question.sections, ["BACKGROUND", "OBJECTIVES"]);
  assert.ok(!question.text.includes("RCTs of at least one year"), "Selection criteria 是答案，不能进输入");
  assert.ok(!question.text.includes("16 trials"));
  assert.equal(buildQuestionText(plain), null, "无标签摘要剥不掉答案段，宁可放弃");
});

test("findCochraneAbstract searches by title within the Cochrane journal and caches the lookup", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "meta-abs-"));
  try {
    const terms: string[] = [];
    let fetches = 0;
    const record: PubMedAbstract = parsePubMedAbstracts(PUBMED_XML)[0];
    const fake = {
      async searchIds(term: string) {
        terms.push(term);
        return terms.length === 1 ? [] : ["31167038"];
      },
      async fetchAbstracts() {
        fetches += 1;
        return [record];
      },
    };
    const review = { id: "CD000028", review: { title: "Pharmacotherapy for hypertension in adults 60 years or older" } };
    const found = await findCochraneAbstract(fake, review, cacheDir);
    assert.equal(found?.pmid, "31167038");
    assert.equal(terms.length, 2, "带引号的精确标题没命中时退到不带引号");
    assert.match(terms[0], /"Cochrane Database Syst Rev"\[Journal\]/);
    assert.equal(fetches, 1);

    const again = await findCochraneAbstract(fake, review, cacheDir);
    assert.equal(again?.pmid, "31167038");
    assert.equal(terms.length, 2, "第二次走缓存，不再请求 PubMed");
    const cached = JSON.parse(await readFile(join(cacheDir, "CD000028.json"), "utf8")) as { found: boolean };
    assert.equal(cached.found, true);

    const missing = await findCochraneAbstract(
      { async searchIds() { return []; }, async fetchAbstracts() { return []; } },
      { id: "CD999999", review: { title: "Nothing" } },
      cacheDir,
    );
    assert.equal(missing, null);
    const cachedMiss = JSON.parse(await readFile(join(cacheDir, "CD999999.json"), "utf8")) as { found: boolean; tried: string[] };
    assert.equal(cachedMiss.found, false);
    assert.equal(cachedMiss.tried.length, 2);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("content recall ignores stopwords and short tokens", () => {
  const gold = "Types of participants We included trials of people 60 years of age or older with hypertension";
  assert.equal(contentRecall(gold, "older adults aged 60 or more with hypertension"), 2 / 4, "金标准内容词 people/years/older/hypertension，命中 older/hypertension");
  assert.equal(contentRecall("", "anything"), null);
  assert.equal(contentRecall(gold, ""), 0);
});
