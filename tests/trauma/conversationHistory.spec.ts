import assert from "node:assert/strict";
import test from "node:test";
import { extractRecentConversationMessages, renderRecentConversation } from "../../src/trauma/conversationHistory.js";

test("recent conversation keeps only visible user and assistant text", () => {
  const messages = [
    { role: "user", kind: "text", text: "第一问" },
    { role: "assistant", kind: "text", text: "第一答" },
    { role: "tool", kind: "tool_result", text: "工具输出" },
    { role: "assistant", kind: "thinking", text: "内部思考" },
    { role: "user", kind: "text", text: "当前问题" },
  ] as never[];
  const extracted = extractRecentConversationMessages(messages, "当前问题");
  assert.deepEqual(extracted, [
    { role: "user", text: "第一问" },
    { role: "assistant", text: "第一答" },
  ]);
  assert.match(renderRecentConversation(extracted), /<turn role="user">第一问<\/turn>/u);
});
