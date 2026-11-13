import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_TURNS,
  areOnlySkillSourceInspections,
  isSkillSourceInspectionCall,
  maxToolCallsGracePrompt,
  resolveEffectiveMaxToolCalls,
  resolveEffectiveMaxTurns,
} from "../../../src/agent/loop/spinGuards.js";

test("defaults apply when maxTurns / maxToolCalls unset", () => {
  assert.equal(resolveEffectiveMaxTurns(undefined), DEFAULT_MAX_TURNS);
  assert.equal(resolveEffectiveMaxToolCalls(undefined), DEFAULT_MAX_TOOL_CALLS);
  assert.equal(resolveEffectiveMaxTurns(0), DEFAULT_MAX_TURNS);
  assert.equal(resolveEffectiveMaxToolCalls(-1), DEFAULT_MAX_TOOL_CALLS);
  assert.equal(resolveEffectiveMaxTurns(40), 40);
  assert.equal(resolveEffectiveMaxToolCalls(200), 200);
});

// 2026-11-12 实跑：分析+交付类任务在 18 次调用时就被迫收尾，默认预算抬到 40/45。
// turn 上限必须高于 tool 上限，否则真正卡住的是"没有软提醒"的那条线。
test("default budgets leave room for analysis + deliverable tasks", () => {
  assert.equal(DEFAULT_MAX_TOOL_CALLS, 40);
  assert.equal(DEFAULT_MAX_TURNS, 45);
  assert.ok(DEFAULT_MAX_TURNS > DEFAULT_MAX_TOOL_CALLS);
});

test("detects skill-source inspection via path and pattern", () => {
  assert.equal(
    isSkillSourceInspectionCall("grep", {
      path: "skills/pdf/scripts",
      pattern: "image",
    }),
    true,
  );
  assert.equal(
    isSkillSourceInspectionCall("read_file", {
      file_path: "/repo/skills/pdf/scripts/pdf_cli.py",
    }),
    true,
  );
  assert.equal(
    isSkillSourceInspectionCall("glob", {
      glob_pattern: "**/pdf_cli.py",
    }),
    true,
  );
  assert.equal(
    isSkillSourceInspectionCall("bash", {
      command: "ls skills/pdf/scripts",
    }),
    false,
  );
  assert.equal(
    isSkillSourceInspectionCall("grep", {
      path: "docs",
      pattern: "pdf",
    }),
    false,
  );
});

test("areOnlySkillSourceInspections requires every call to be source dig", () => {
  assert.equal(
    areOnlySkillSourceInspections([
      { name: "grep", input: { path: "skills/pdf/scripts/pdf_cli.py", pattern: "Image" } },
      { name: "read_file", input: { path: "skills/pdf/scripts/pdf_cli.py" } },
    ]),
    true,
  );
  assert.equal(
    areOnlySkillSourceInspections([
      { name: "grep", input: { path: "skills/pdf/scripts/pdf_cli.py", pattern: "Image" } },
      { name: "bash", input: { command: "skills/pdf/scripts/pdf.sh make --help" } },
    ]),
    false,
  );
  assert.equal(areOnlySkillSourceInspections([]), false);
});

// 2026-11-12 实跑：软提醒被模型读成"已经用完"，于是放弃写交付物。
// 文案必须给出剩余次数，并明确"这不是停止信号"。
test("max tool calls grace prompt states the remaining budget", () => {
  const prompt = maxToolCallsGracePrompt(2);
  assert.match(prompt, /2 calls left/u);
  assert.match(prompt, /budget warning, not a stop/u);
  assert.doesNotMatch(prompt, /You are approaching the tool-call budget/u);
  assert.match(prompt, /deliverable/u);

  assert.match(maxToolCallsGracePrompt(1), /1 call left/u);
  assert.match(maxToolCallsGracePrompt(0), /used up/u);
  assert.match(maxToolCallsGracePrompt(0), /ends the turn with an error/u);
});
