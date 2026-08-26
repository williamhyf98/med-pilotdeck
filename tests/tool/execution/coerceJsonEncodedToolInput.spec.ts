import test from "node:test";
import assert from "node:assert/strict";
import { coerceJsonEncodedToolInput } from "../../../src/tool/execution/coerceJsonEncodedToolInput.js";
import { validateToolInput } from "../../../src/tool/execution/validateToolInput.js";
import { createAskUserQuestionTool } from "../../../src/tool/builtin/askUserQuestion.js";

test("unwraps ask_user_question.questions when the model stringifies the array", () => {
  const schema = createAskUserQuestionTool().inputSchema;
  const encoded = `
[{"header": "救治阶段", "question": "您希望按哪个阶段生成正式救治方案？", "options": [{"label": "伤员发生地", "description": "现场急救"}, {"label": "野战分类场", "description": "前沿分类"}], "multiSelect": false}]
`;
  const coerced = coerceJsonEncodedToolInput({ questions: encoded }, schema);
  const validation = validateToolInput(coerced, schema);
  assert.equal(validation.ok, true);
  assert.ok(Array.isArray((coerced as { questions: unknown }).questions));
  assert.equal((coerced as { questions: { header: string }[] }).questions[0].header, "救治阶段");
});

test("leaves already-valid nested arrays unchanged", () => {
  const schema = createAskUserQuestionTool().inputSchema;
  const input = {
    questions: [
      {
        header: "阶段",
        question: "选一个阶段",
        options: [
          { label: "伤员发生地", description: "现场" },
          { label: "手术组", description: "手术" },
        ],
      },
    ],
  };
  const coerced = coerceJsonEncodedToolInput(input, schema);
  assert.deepEqual(coerced, input);
});

test("does not parse a string field that happens to look like JSON", () => {
  const schema = {
    type: "object" as const,
    properties: {
      injury_text: { type: "string" },
    },
  };
  const input = { injury_text: '{"note":"keep me as text"}' };
  const coerced = coerceJsonEncodedToolInput(input, schema);
  assert.equal((coerced as { injury_text: string }).injury_text, '{"note":"keep me as text"}');
});

test("unwraps nested stringified option arrays", () => {
  const schema = createAskUserQuestionTool().inputSchema;
  const coerced = coerceJsonEncodedToolInput(
    {
      questions: [
        {
          header: "阶段",
          question: "选一个",
          options: JSON.stringify([
            { label: "伤员发生地", description: "现场" },
            { label: "手术组", description: "手术" },
          ]),
        },
      ],
    },
    schema,
  );
  const validation = validateToolInput(coerced, schema);
  assert.equal(validation.ok, true);
  const questions = (coerced as { questions: { options: unknown[] }[] }).questions;
  assert.equal(questions[0].options.length, 2);
});
