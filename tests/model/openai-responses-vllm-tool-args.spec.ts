// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpenAIResponsesStreamState,
  normalizeOpenAIResponsesStreamEvent,
  extractLastJsonObject,
} from "../../src/model/providers/openai-responses/stream.js";
import { parseOpenAIResponsesResponse } from "../../src/model/providers/openai-responses/response.js";

function replay(events: unknown[]): { toolCalls: unknown[]; errors: unknown[] } {
  const state = createOpenAIResponsesStreamState();
  const toolCalls: unknown[] = [];
  const errors: unknown[] = [];
  for (const event of events) {
    for (const e of normalizeOpenAIResponsesStreamEvent(event, state)) {
      if (e.type === "tool_call_end") toolCalls.push(e.toolCall);
      if (e.type === "error") errors.push(e.error);
    }
  }
  return { toolCalls, errors };
}

test("vLLM concatenated arguments in function_call_arguments.done do not corrupt per-item delta buffers", () => {
  // Real vLLM stream shape: two parallel calls, deltas are clean per item,
  // but the second done event carries BOTH calls' argument objects.
  const events = [
    { type: "response.created", response: { id: "resp_1" } },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "item_a", call_id: "call_a", name: "read_doc", type: "function_call", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "item_a", output_index: 1, delta: '{"path": ' },
    { type: "response.function_call_arguments.delta", item_id: "item_a", output_index: 1, delta: '"C:/data/a.xml"}' },
    // vLLM emits output_item.done with type "message" for the function_call item.
    { type: "response.output_item.done", output_index: 1, item: { id: "item_a", type: "message", content: [] } },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: { id: "item_b", call_id: "call_b", name: "read_doc", type: "function_call", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "item_b", output_index: 2, delta: '{"path": ' },
    { type: "response.function_call_arguments.delta", item_id: "item_b", output_index: 2, delta: '"C:/data/b.xml"}' },
    {
      // The bug: concatenation of both calls' arguments.
      type: "response.function_call_arguments.done",
      item_id: "item_b",
      output_index: 2,
      name: "read_doc",
      arguments: '{"path": "C:/data/a.xml"}{"path": "C:/data/b.xml"}',
    },
    {
      type: "response.output_item.done",
      output_index: 2,
      item: { id: "item_b", call_id: "call_b", name: "read_doc", type: "function_call", arguments: '{"path": "C:/data/a.xml"}{"path": "C:/data/b.xml"}' },
    },
    { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
  ];

  const { toolCalls, errors } = replay(events);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(toolCalls.length, 2);
  const inputs = toolCalls.map((c) => JSON.stringify(c.input)).sort();
  assert.deepEqual(inputs, ['{"path":"C:/data/a.xml"}', '{"path":"C:/data/b.xml"}']);
});

test("done event arguments are used when no deltas were emitted", () => {
  const events = [
    { type: "response.created", response: { id: "resp_2" } },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "item_a", call_id: "call_a", name: "read_doc", type: "function_call", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "item_a",
      output_index: 1,
      name: "read_doc",
      arguments: '{"path":"C:/data/solo.xml"}',
    },
    { type: "response.completed", response: { id: "resp_2", status: "completed" } },
  ];

  const { toolCalls, errors } = replay(events);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(toolCalls[0].input, { path: "C:/data/solo.xml" });
});

test("non-stream response extracts the last object from concatenated arguments", () => {
  const raw = {
    id: "resp_3",
    model: "Qwen3.8-27B",
    status: "completed",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { id: "fc_1", call_id: "call_1", type: "function_call", name: "read_doc", arguments: '{"path":"C:/data/a.xml"}' },
      { id: "fc_2", call_id: "call_2", type: "function_call", name: "read_doc", arguments: '{"path":"C:/data/a.xml"}{"path":"C:/data/b.xml"}' },
    ],
  };
  const parsed = parseOpenAIResponsesResponse(raw);
  const blocks = parsed.content.filter((b) => b.type === "tool_call");
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].input, { path: "C:/data/a.xml" });
  assert.deepEqual(blocks[1].input, { path: "C:/data/b.xml" });
});

test("genuinely invalid arguments still raise invalid_tool_arguments", () => {
  const events = [
    { type: "response.created", response: { id: "resp_4" } },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "item_a", call_id: "call_a", name: "read_doc", type: "function_call", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "item_a",
      output_index: 1,
      name: "read_doc",
      arguments: "not json at all {",
    },
  ];
  assert.throws(
    () => replay(events),
    (error) => error?.error?.code === "invalid_tool_arguments" && error.message.includes("not valid JSON"),
  );
});

test("extractLastJsonObject picks the tail object and rejects junk", () => {
  assert.deepEqual(extractLastJsonObject('{"a":1}{"b":2}'), { b: 2 });
  assert.deepEqual(extractLastJsonObject('{"a":{"x":1}}{"b":"}{"}'), { b: "}{" });
  assert.equal(extractLastJsonObject("no json here"), undefined);
  assert.equal(extractLastJsonObject(""), undefined);
});
