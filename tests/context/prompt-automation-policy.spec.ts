import assert from "node:assert/strict";
import test from "node:test";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";
import { createBashTool } from "../../src/tool/builtin/bash.js";
import { createEditFileTool } from "../../src/tool/builtin/editFile.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";

test("default prompt exposes bundled declarative automation instead of a script workflow", () => {
  const assembler = new PromptAssembler({
    listMcpInstructions: () => [],
    listCommands: () => [],
    listSkills: () => [],
  } as never);
  const prompt = assembler.assemble({
    cwd: "/workspace",
    provider: "test",
    model: "test",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    tools: [],
  }).joined;

  assert.match(prompt, /随附自动化策略|Bundled automation policy/u);
  assert.match(prompt, /Markdown[,、]\s*JSON[,、]\s*CSV[,、]?\s*(or|或)\s*TSV/u);
  assert.doesNotMatch(prompt, /Reusable script workflow/u);
  assert.doesNotMatch(prompt, /write it to a workspace file first/u);
});

test("model-visible write and bash descriptions do not recommend generated programs", () => {
  const descriptions = [
    createWriteFileTool().description,
    createEditFileTool().description,
    createBashTool().description,
  ].join("\n");

  assert.match(descriptions, /declarative/u);
  assert.doesNotMatch(descriptions, /reusable scripts|generators|python -|node -e|heredoc/iu);
});
