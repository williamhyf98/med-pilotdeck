import assert from "node:assert/strict";
import test from "node:test";

import { parseSessionInfoFromLite } from "../../src/session/storage/SessionList.js";

test("durable trauma user messages make a persisted session discoverable", () => {
  const head = JSON.stringify({
    type: "durable_message",
    createdAt: "2026-09-04T02:20:17.112Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "爆炸后有一名伤员" }],
    },
  });
  const tail = [
    head,
    JSON.stringify({
      type: "assistant_message",
      createdAt: "2026-09-04T02:23:42.075Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "请继续补充生命体征" }],
      },
    }),
  ].join("\n");

  const session = parseSessionInfoFromLite(
    "web:s_trauma",
    { path: "/tmp/web:s_trauma.jsonl", head, tail, mtime: 1_000, size: tail.length },
    "trauma_med-demo",
  );

  assert.ok(session);
  assert.equal(session.firstPrompt, "爆炸后有一名伤员");
  assert.equal(session.summary, "爆炸后有一名伤员");
});
