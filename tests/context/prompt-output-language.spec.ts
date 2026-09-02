import assert from "node:assert/strict";
import test from "node:test";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";
import { createAskUserQuestionTool } from "../../src/tool/builtin/askUserQuestion.js";
import { createBashTool } from "../../src/tool/builtin/bash.js";
import { createEditFileTool } from "../../src/tool/builtin/editFile.js";
import { createGlobTool } from "../../src/tool/builtin/glob.js";
import { createGrepTool } from "../../src/tool/builtin/grep.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { createTodoWriteTool } from "../../src/tool/builtin/todoWrite.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";

function assemblePrompt(): string {
  const assembler = new PromptAssembler({
    listMcpInstructions: () => [],
    listCommands: () => [],
    listSkills: () => [],
  } as never);
  return assembler.assemble({
    cwd: "/workspace",
    provider: "test",
    model: "test",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    tools: [],
  }).joined;
}

test("default prompt requires Simplified Chinese for reasoning and replies", () => {
  const prompt = assemblePrompt();

  assert.match(prompt, /输出语言：/u);
  assert.match(prompt, /思考过程/u);
  assert.match(prompt, /简体中文/u);
  assert.match(prompt, /工具名、参数名、文件路径、命令、代码/u);
});

test("high-frequency builtin tool descriptions are written in Chinese", () => {
  const tools = [
    createReadFileTool(),
    createWriteFileTool(),
    createEditFileTool(),
    createBashTool(),
    createGrepTool(),
    createGlobTool(),
    createTodoWriteTool(),
    createAskUserQuestionTool(),
  ];

  for (const tool of tools) {
    const description = tool.description ?? "";
    assert.match(description, /用法：|使用说明|读取或更新|本工具|向用户提出/u, `${tool.name} description should be Chinese`);
    assert.doesNotMatch(description, /\bUsage:\n/u, `${tool.name} description should not keep the English usage block`);
  }
});
