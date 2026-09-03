// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

const KEPT_WITHOUT_READ_SKILL = [
  "get_current_time",
  "read_file",
  "glob",
  "grep",
  "edit_file",
  "write_file",
  "bash",
  "ask_user_question",
  "enter_plan_mode",
  "exit_plan_mode",
  "todo_write",
];

test("createBuiltinRegistry registers only the offline kept builtins", () => {
  const registry = createBuiltinRegistry({
    readSkill: {
      loader: async () => undefined,
      lister: () => [],
    },
  });
  assert.deepEqual(
    registry.list().map((tool) => tool.name).sort(),
    [...KEPT_WITHOUT_READ_SKILL, "read_skill"].sort(),
  );
  for (const removed of [
    "web_search",
    "web_fetch",
    "execute_code",
    "send_attachment",
    "agent",
    "task_create",
    "edit_notebook",
    "structured_output",
  ]) {
    assert.equal(registry.has(removed), false);
  }
});

test("createBuiltinRegistry can disable plan mode tools for constrained hosts", () => {
  const registry = createBuiltinRegistry({ planMode: false });
  assert.equal(registry.has("enter_plan_mode"), false);
  assert.equal(registry.has("exit_plan_mode"), false);
});
