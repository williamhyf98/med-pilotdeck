// @ts-nocheck
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
} from "../../src/tool/builtin/planMode.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "../../src/tool/planModeConstraints.js";

test("exit_plan_mode is callable while plan mode is active", () => {
  assert.ok(
    PLAN_MODE_ALLOWED_TOOLS.has("exit_plan_mode"),
    "plan mode must allow the tool that submits the plan for approval",
  );
  assert.ok(!PLAN_MODE_ALLOWED_TOOLS.has("mcp__med-tools__parse_document"));
});

test("enter_plan_mode describes medical workspace planning instead of coding", async () => {
  const tool = createEnterPlanModeTool();
  assert.match(tool.description, /医学工作区/);
  assert.match(tool.description, /医学解析|战创伤 RAG/);
  assert.doesNotMatch(tool.description, /codebase|implementation|coding/i);

  const result = await tool.execute({}, {
    permissionMode: "default",
    planDirectory: { path: "/workspace/.pilotdeck/plans" },
  });
  const text = result.content[0]?.text ?? "";
  assert.match(text, /查看当前工作区的附件/);
  assert.match(text, /mcp__med-tools__|医学 MCP/);
  assert.doesNotMatch(text, /start coding|explore the codebase/i);
  assert.deepEqual(result.data, { requestedMode: "plan" });
});

test("exit_plan_mode approval restores execution with medical tool guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-med-plan-"));
  const planDir = join(root, ".pilotdeck", "plans");
  const planPath = join(planDir, "救治材料处理.md");
  const approved: string[] = [];
  try {
    await mkdir(planDir, { recursive: true });
    await writeFile(planPath, "# 救治材料处理\n\n1. 解析附件\n2. 生成 HTML\n", "utf8");
    const tool = createExitPlanModeTool();
    const result = await tool.execute({ plan_file_path: planPath }, {
      permissionMode: "plan",
      turnId: "turn-1",
      planDirectory: {
        path: planDir,
        resolve(filePath: string) {
          const candidate = resolve(filePath);
          return candidate === planPath ? candidate : undefined;
        },
      },
      elicitation: {
        async askUser() {
          return {
            type: "answered",
            answers: { "下一步怎么做？": "execute_plan" },
          };
        },
      },
      planTodo: {
        markPlanApproved(plan: string) {
          approved.push(plan);
        },
      },
    });

    assert.equal(result.data?.requestedMode, "default");
    assert.equal(result.data?.action, "execute_plan");
    assert.match(result.content[0]?.text ?? "", /read_skill/);
    assert.match(result.content[0]?.text ?? "", /mcp__med-tools__/);
    assert.match(result.content[0]?.text ?? "", /continuation_mode="material"/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /start coding/i);
    assert.equal(approved.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
