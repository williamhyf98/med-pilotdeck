// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpenAIStreamState,
  normalizeOpenAIStreamEvent,
  splitThinkContent,
} from "../../src/model/providers/openai/stream.js";

test("Qwen3-style bare </think> splits reasoning from answer text", () => {
  const state = createOpenAIStreamState();
  const events = splitThinkContent("The user asked a question.\n</think>\n\n好的，以下是回答。", state, {});
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "thinking_delta");
  assert.match(events[0].text, /The user asked a question/);
  assert.equal(events[1].type, "text_delta");
  assert.match(events[1].text, /好的，以下是回答/);
});

test("paired <think></think> tags still work", () => {
  const state = createOpenAIStreamState();
  const events = splitThinkContent("intro <think>internal</think> answer", state, {});
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "text_delta");
  assert.equal(events[0].text, "intro ");
  assert.equal(events[1].type, "thinking_delta");
  assert.equal(events[1].text, "internal");
  assert.equal(events[2].type, "text_delta");
  assert.equal(events[2].text, " answer");
});

test("close tag split across chunks is buffered correctly in holdback mode", () => {
  const state = createOpenAIStreamState({ holdBackInlineThink: true });
  const events1 = splitThinkContent("reasoning text...</th", state, {});
  assert.equal(events1.length, 0); // fully held back
  const events2 = splitThinkContent("ink>\nanswer", state, {});
  assert.equal(events2.length, 2);
  assert.equal(events2[0].type, "thinking_delta");
  assert.equal(events2[0].text, "reasoning text...");
  assert.equal(events2[1].type, "text_delta");
  assert.equal(events2[1].text, "\nanswer");
});

test("holdback flushes as text at message end when no marker appears", () => {
  const state = createOpenAIStreamState({ holdBackInlineThink: true });
  const events1 = normalizeOpenAIStreamEvent({
    id: "cmpl-a", object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "hello " } }],
  }, state);
  assert.equal(events1.length, 1); // message_start only; text held back
  const events2 = normalizeOpenAIStreamEvent({
    id: "cmpl-b", object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "world" }, finish_reason: "stop" }],
  }, state);
  const types = events2.map((e) => e.type);
  assert.ok(types.includes("text_delta") && types.includes("message_end"), JSON.stringify(types));
  const text = events2.find((e) => e.type === "text_delta");
  assert.equal(text?.text, "hello world");
});

test("content without any think tags stays plain text", () => {
  const state = createOpenAIStreamState();
  const events = splitThinkContent("plain answer", state, {});
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "text_delta");
  assert.equal(events[0].text, "plain answer");
});

test("openai stream event routes bare-close reasoning into thinking deltas", () => {
  const state = createOpenAIStreamState();
  const events = normalizeOpenAIStreamEvent({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "reasoning\n</think>\n\nanswer text" } }],
  }, state);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("thinking_delta"), JSON.stringify(types));
  assert.ok(types.includes("text_delta"), JSON.stringify(types));
});
