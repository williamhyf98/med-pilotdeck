import assert from "node:assert/strict";
import test from "node:test";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";
import { filterToolsForProjectType } from "../../src/pilot/projectTypePolicy.js";

const skills = [
  "med-case-report",
  "med-medical",
  "med-trauma-assist",
  "med-trauma-stage-plan",
].map((name) => ({
  name: `med-tools:${name}`,
  description: name,
  path: `/plugins/med-tools/skills/${name}/SKILL.md`,
  namespace: "med-tools",
}));

const extension = {
  listCommands: () => [],
  listSkills: () => [
    ...skills,
    {
      name: "general-custom",
      description: "general custom",
      path: "/pilot-home/skills/general-custom/SKILL.md",
      availability: ["general_medicine"] as const,
    },
    {
      name: "trauma-custom",
      description: "trauma custom",
      path: "/pilot-home/skills/trauma-custom/SKILL.md",
      availability: ["war_trauma"] as const,
    },
  ],
  listMcpInstructions: () => [],
};

function assemble(cwd: string): string {
  return new PromptAssembler(extension).assemble({
    cwd,
    provider: "test",
    model: "test",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    tools: [],
  }).joined;
}

test("general-medicine projects receive their persona and all medical skills", () => {
  const prompt = assemble("/pilot/workspaces/general_med/general_med-example");
  assert.match(prompt, /九格通用医学智能体助手/u);
  assert.match(prompt, /med-tools:med-case-report/u);
  assert.match(prompt, /med-tools:med-medical/u);
  assert.match(prompt, /med-tools:med-trauma-assist/u);
  assert.match(prompt, /med-tools:med-trauma-stage-plan/u);
  assert.match(prompt, /general-custom/u);
  assert.doesNotMatch(prompt, /trauma-custom/u);
});

test("war-trauma projects retain their persona and receive all medical skills", () => {
  const prompt = assemble("/pilot/workspaces/trauma_med/trauma_med-example");
  assert.match(prompt, /九格战创伤医学智能体助手/u);
  assert.match(prompt, /med-tools:med-case-report/u);
  assert.match(prompt, /med-tools:med-medical/u);
  assert.match(prompt, /med-tools:med-trauma-assist/u);
  assert.match(prompt, /med-tools:med-trauma-stage-plan/u);
  assert.match(prompt, /trauma-custom/u);
  assert.doesNotMatch(prompt, /general-custom/u);
});

test("personas describe the shared full medical capability set", () => {
  const general = assemble("/pilot/workspaces/general_med/general_med-example");
  assert.match(general, /可使用当前系统已注册的全部医学能力/u);
  assert.doesNotMatch(general, /建议用户新建或切换到「战创伤医学」项目提问/u);

  const trauma = assemble("/pilot/workspaces/trauma_med/trauma_med-example");
  assert.match(trauma, /可使用当前系统已注册的全部医学能力/u);
});

test("general-medicine model tool catalog includes trauma MCP tools", () => {
  const tools = [
    { name: "read_file" },
    { name: "mcp__med-tools__med_parse_medical" },
    { name: "mcp__med-tools__med_trauma_rag_query" },
    { name: "mcp__med-tools__med_trauma_rag_status" },
    { name: "mcp__med-tools__med_trauma_stage_plan" },
  ];
  assert.deepEqual(
    filterToolsForProjectType(tools, "general_medicine").map((tool) => tool.name),
    tools.map((tool) => tool.name),
  );
});
