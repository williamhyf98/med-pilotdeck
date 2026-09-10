import assert from "node:assert/strict";
import test from "node:test";

import {
  createMcpTraumaRagClient,
  normalizeRagPayload,
  payloadFromTool,
  TRAUMA_RAG_TOOL_NAME,
  TRAUMA_RAG_TOPIC,
} from "../../src/trauma/rag/client.js";

const PAYLOAD = {
  retrieval_backend: "remote",
  chunks: [
    {
      chunk_id: "war_trauma_chunk_0016427",
      text: "第二十四条【战现场急救】",
      score: 0.0406,
      title: "战伤救治规则",
      retrieval_backend: "remote",
    },
  ],
};

test("payloadFromTool unwraps the MCP content-block array returned by non-streaming tools", () => {
  // 非流式 MCP 工具的 `data` 就是这个形态；此前它会被原样透传并被当成空结果。
  const blocks = [{ type: "text", text: JSON.stringify(PAYLOAD) }];
  assert.deepEqual(payloadFromTool(blocks), PAYLOAD);
  assert.deepEqual(payloadFromTool({ content: blocks }), PAYLOAD);
});

test("payloadFromTool still accepts the string and { content: string } shapes", () => {
  assert.deepEqual(payloadFromTool(JSON.stringify(PAYLOAD)), PAYLOAD);
  assert.deepEqual(payloadFromTool({ content: JSON.stringify(PAYLOAD) }), PAYLOAD);
});

test("payloadFromTool joins multiple text blocks and ignores non-text ones", () => {
  const json = JSON.stringify(PAYLOAD);
  const split = [
    { type: "text", text: json.slice(0, 20) },
    { type: "image", mimeType: "image/png", data: "..." },
    { type: "text", text: json.slice(20) },
  ];
  assert.deepEqual(payloadFromTool(split), PAYLOAD);
});

test("normalizeRagPayload throws instead of masking an unparseable payload as 0 chunks", () => {
  // 这正是之前 step5 稳定返回 backend=local / chunkCount=0 的伪装路径。
  assert.throws(() => normalizeRagPayload([{ type: "text", text: "x" }]), /not an object/u);
  assert.throws(() => normalizeRagPayload("null"), /not an object/u);
});

test("normalizeRagPayload keeps a genuine empty result as an empty chunk list", () => {
  const empty = normalizeRagPayload({ retrieval_backend: "remote", chunks: [] });
  assert.equal(empty.chunks.length, 0);
  assert.equal(empty.retrieval_backend, "remote");
});

test("the MCP client sends the war-trauma topic and reads chunks out of content blocks", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const client = createMcpTraumaRagClient(async (name, input) => {
    calls.push({ name, input });
    return [{ type: "text", text: JSON.stringify(PAYLOAD) }];
  });

  const result = await client.query({ query: "战伤救治规则 分级救治", top_k: 8 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, TRAUMA_RAG_TOOL_NAME);
  assert.deepEqual(calls[0]?.input, {
    query: "战伤救治规则 分级救治",
    top_k: 8,
    topic: TRAUMA_RAG_TOPIC,
  });
  assert.equal(result.retrieval_backend, "remote");
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0]?.chunk_id, "war_trauma_chunk_0016427");
  assert.equal(result.chunks[0]?.title, "战伤救治规则");
});
