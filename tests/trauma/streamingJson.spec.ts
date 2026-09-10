import assert from "node:assert/strict";
import test from "node:test";

import {
  NaturalLanguageAnswerStreamExtractor,
} from "../../src/trauma/streamingJson.js";

test("extracts naturalLanguageAnswer deltas from split JSON text", () => {
  const extractor = new NaturalLanguageAnswerStreamExtractor();
  const deltas = [
    extractor.accept('{"naturalLanguageAnswer":"当前'),
    extractor.accept("按初级急救"),
    extractor.accept('处理。","classification":{}'),
  ].filter(Boolean);

  assert.deepEqual(deltas, ["当前", "按初级急救", "处理。"]);
  assert.equal(extractor.currentText(), "当前按初级急救处理。");
});

test("decodes escaped characters without leaking JSON syntax", () => {
  const extractor = new NaturalLanguageAnswerStreamExtractor();
  const deltas = [
    extractor.accept('{"naturalLanguageAnswer":"第一行\\n第二'),
    extractor.accept('行：\\"止血\\"'),
    extractor.accept('。","memo":{}'),
  ].filter(Boolean);

  assert.deepEqual(deltas, ["第一行\n第二", "行：\"止血\"", "。"]);
  assert.equal(extractor.currentText(), "第一行\n第二行：\"止血\"。");
});

test("waits until naturalLanguageAnswer appears even when it is not the first field", () => {
  const extractor = new NaturalLanguageAnswerStreamExtractor();
  assert.equal(extractor.accept('{"classification":{"severity":"severe"},'), undefined);
  assert.equal(extractor.accept('"naturalLanguageAnswer":"需要继续评估'), "需要继续评估");
  assert.equal(extractor.accept('循环状态。","memo":{}'), "循环状态。");
});

test("does not emit incomplete JSON escape sequences", () => {
  const extractor = new NaturalLanguageAnswerStreamExtractor();
  assert.equal(extractor.accept('{"naturalLanguageAnswer":"体温36'), "体温36");
  assert.equal(extractor.accept("\\u002E"), ".");
  assert.equal(extractor.accept('5℃。","memo":{}'), "5℃。");
  assert.equal(extractor.currentText(), "体温36.5℃。");
});
