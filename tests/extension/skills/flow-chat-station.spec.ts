import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFlowChatUserMessage,
  createSkillFlowChatStation,
  normalizeFlowChatResult,
  serializeFlowForChat,
  validateFlowChatResult,
  type FlowChatGraph,
  type FlowChatResult,
} from "../../../src/extension/skills/flowChatStation.js";
import type { StructuredModelClient } from "../../../src/trauma/modelClient.js";

const SAMPLE_FLOW: FlowChatGraph = {
  nodes: [
    { id: "n1", kind: "step", text: "接收CT报告" },
    { id: "n2", kind: "decision", text: "有危急值？" },
    { id: "n3", kind: "step", text: "" },
  ],
  edges: [
    { source: "n1", target: "n2", sourceHandle: null },
    { source: "n2", target: "n3", sourceHandle: "yes" },
  ],
};

test("serializeFlowForChat renders real ids, branch labels and the empty-canvas marker", () => {
  const text = serializeFlowForChat(SAMPLE_FLOW);
  assert.match(text, /n1 ｜ 步骤 ｜ 接收CT报告/);
  assert.match(text, /n2 ｜ 判断 ｜ 有危急值？/);
  assert.match(text, /n3 ｜ 步骤 ｜ （空）/);
  assert.match(text, /n2 →（是）→ n3/);
  assert.match(serializeFlowForChat({ nodes: [], edges: [] }), /画布为空/);
});

test("buildFlowChatUserMessage separates history from the latest user message", () => {
  const message = buildFlowChatUserMessage({
    flow: SAMPLE_FLOW,
    messages: [
      { role: "user", text: "画一个分诊流程" },
      { role: "assistant", text: "已画好基本流程。" },
      { role: "user", text: "加一步复核" },
    ],
  });
  assert.match(message, /<当前流程图>/);
  assert.match(message, /<对话历史>\n用户：画一个分诊流程\n助手：已画好基本流程。\n<\/对话历史>/);
  assert.match(message, /<用户最新消息>\n加一步复核\n<\/用户最新消息>/);
});

test("normalizeFlowChatResult repairs ids, branches and dangling edges", () => {
  const normalized = normalizeFlowChatResult({
    reply: "  好的，已加入复核步骤。  ",
    nodes: [
      { id: "n1", kind: "step", text: " 接收CT报告 " },
      { id: "n1", kind: "weird", text: "重复 id 的节点" },
      { id: "c1", kind: "decision", text: "复核通过？" },
    ],
    edges: [
      // branch on a step source must collapse to null.
      { source: "n1", target: "c1", branch: "yes" },
      // duplicates collapse to one edge.
      { source: "n1", target: "c1", branch: "yes" },
      // the model may echo the UI field name instead of `branch`.
      { source: "c1", target: "n1", sourceHandle: "no" },
      // dangling + self-loop edges drop.
      { source: "c1", target: "ghost", branch: "no" },
      { source: "c1", target: "c1", branch: "yes" },
    ],
  }) as FlowChatResult;

  assert.ok(validateFlowChatResult(normalized));
  assert.equal(normalized.reply, "好的，已加入复核步骤。");
  assert.deepEqual(normalized.flow.nodes.map((n) => n.id), ["n1", "x1", "c1"]);
  // 非法 kind 回落为 step；重复 id 的后一个节点换新 id。
  assert.equal(normalized.flow.nodes[1]!.kind, "step");
  assert.equal(normalized.flow.nodes[0]!.text, "接收CT报告");
  assert.deepEqual(normalized.flow.edges, [
    { source: "n1", target: "c1", sourceHandle: null },
    { source: "c1", target: "n1", sourceHandle: "no" },
  ]);
});

test("normalizeFlowChatResult falls back to a non-empty reply", () => {
  const normalized = normalizeFlowChatResult({
    reply: "   ",
    nodes: [],
    edges: [],
  }) as FlowChatResult;
  assert.ok(validateFlowChatResult(normalized));
  assert.ok(normalized.reply.length > 0);
  assert.deepEqual(normalized.flow, { nodes: [], edges: [] });
});

test("createSkillFlowChatStation runs the model output through normalize + validate", async () => {
  let capturedSystem = "";
  let capturedUser = "";
  const rawModelOutput = {
    reply: "已加入复核分支。",
    nodes: [
      { id: "n1", kind: "step", text: "接收CT报告" },
      { id: "n2", kind: "decision", text: "有危急值？" },
      { id: "c1", kind: "step", text: "电话通知临床" },
    ],
    edges: [
      { source: "n1", target: "n2", branch: null },
      { source: "n2", target: "c1", branch: "yes" },
    ],
  };
  const model: StructuredModelClient = {
    async completeJson<T>(input: {
      system: string;
      user: string;
      validate: (value: unknown) => value is T;
      normalize?: (value: unknown) => unknown;
    }): Promise<T> {
      capturedSystem = input.system;
      capturedUser = input.user;
      const value = input.normalize ? input.normalize(rawModelOutput) : rawModelOutput;
      assert.ok(input.validate(value));
      return value as T;
    },
  };
  const station = createSkillFlowChatStation(model);
  const result = await station.chat({
    flow: SAMPLE_FLOW,
    messages: [{ role: "user", text: "危急值走通知分支" }],
  });
  assert.match(capturedSystem, /流程图协作助手/);
  assert.match(capturedUser, /危急值走通知分支/);
  assert.equal(result.reply, "已加入复核分支。");
  assert.deepEqual(result.flow.edges[1], { source: "n2", target: "c1", sourceHandle: "yes" });
});
