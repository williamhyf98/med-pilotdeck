// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { applyWebGatewayEvent, createWebMessageReducerState } from "../../src/web/client/webMessage.js";

function reducerOptions() {
  let id = 0;
  return {
    sessionKey: "s1",
    projectKey: "p1",
    now: () => new Date("2026-07-09T00:00:00.000Z"),
    newId: () => `msg-${++id}`,
  };
}

test("read_skill tool call surfaces the invoked skill name in the message text", () => {
  const options = reducerOptions();
  let state = createWebMessageReducerState();
  state = applyWebGatewayEvent(state, {
    type: "tool_call_started",
    toolCallId: "call-skill",
    name: "read_skill",
    argsPreview: '{"skillName":"med-tools:med-case-report"}',
  }, options);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.kind, "tool_use");
  assert.equal(state.messages[0]?.text, "read_skill: med-tools:med-case-report");
  assert.equal(state.messages[0]?.toolInput, '{"skillName":"med-tools:med-case-report"}');
});

test("non-read_skill tool calls keep the raw args preview", () => {
  const options = reducerOptions();
  let state = createWebMessageReducerState();
  state = applyWebGatewayEvent(state, {
    type: "tool_call_started",
    toolCallId: "call-other",
    name: "bash",
    argsPreview: '{"command":"ls"}',
  }, options);
  assert.equal(state.messages[0]?.text, '{"command":"ls"}');
  assert.equal(state.messages[0]?.toolInput, '{"command":"ls"}');
});

test("toolInput survives the tool_call_finished merge", () => {
  const options = reducerOptions();
  let state = createWebMessageReducerState();
  state = applyWebGatewayEvent(state, {
    type: "tool_call_started",
    toolCallId: "call-skill-2",
    name: "read_skill",
    argsPreview: '{"skillName":"med-medical"}',
  }, options);
  state = applyWebGatewayEvent(state, {
    type: "tool_call_finished",
    toolCallId: "call-skill-2",
    ok: true,
    resultPreview: "report content",
  }, options);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.kind, "tool_result");
  assert.equal(state.messages[0]?.toolInput, '{"skillName":"med-medical"}');
  assert.equal(state.messages[0]?.toolName, "read_skill");
});
