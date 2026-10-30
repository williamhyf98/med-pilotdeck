import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_TURNS,
  areOnlySkillSourceInspections,
  isSkillSourceInspectionCall,
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
