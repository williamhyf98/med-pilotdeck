// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { detectSubagent } from "../../src/router/scenario/subagentDetector.js";

test("main agent without agent tool is not a subagent", () => {
  const detection = detectSubagent(
    [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    true,
  );
  assert.equal(detection.isSubagent, false);
  assert.equal(detection.taggedInUserMessage, false);
});

test("non-main requests are subagents", () => {
  const detection = detectSubagent(
    [{ role: "user", content: [{ type: "text", text: "inspect files" }] }],
    false,
  );
  assert.equal(detection.isSubagent, true);
});

test("subagent tag in the user message marks the request as a subagent", () => {
  const detection = detectSubagent(
    [{
      role: "user",
      content: [{ type: "text", text: "<pilotdeck-subagent-model>openai/gpt-5.5</pilotdeck-subagent-model>\ninspect" }],
    }],
    true,
  );
  assert.equal(detection.isSubagent, true);
  assert.equal(detection.taggedInUserMessage, true);
  assert.equal(detection.modelHint, "openai/gpt-5.5");
});
