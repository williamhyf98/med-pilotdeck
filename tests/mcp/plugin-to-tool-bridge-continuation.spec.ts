import assert from "node:assert/strict";
import test from "node:test";
import { shouldEndTurnAfterDirectStream } from "../../src/mcp/runtime/PluginToToolBridge.js";

test("med_parse_medical defaults to ending the turn after a successful report", () => {
  assert.equal(
    shouldEndTurnAfterDirectStream("med_parse_medical", {}),
    true,
  );
  assert.equal(
    shouldEndTurnAfterDirectStream("med_parse_medical", { continuation_mode: "terminal" }),
    true,
  );
});

test("med_parse_medical material mode keeps the turn open", () => {
  assert.equal(
    shouldEndTurnAfterDirectStream("med_parse_medical", { continuation_mode: "material" }),
    false,
  );
  assert.equal(
    shouldEndTurnAfterDirectStream(
      "med_parse_medical",
      { continuation_mode: "terminal" },
      "material",
    ),
    false,
  );
});

test("med_trauma_stage_plan never ends the turn via direct-final", () => {
  assert.equal(
    shouldEndTurnAfterDirectStream("med_trauma_stage_plan", {}),
    false,
  );
});
