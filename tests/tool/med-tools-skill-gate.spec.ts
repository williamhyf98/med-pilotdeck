import assert from "node:assert/strict";
import test from "node:test";
import { PermissionRuntime } from "../../src/permission/index.js";
import { createReadSkillTool } from "../../src/tool/builtin/readSkill.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import {
  getMedToolsSkillRequirement,
  isMedToolDisabled,
  isSpecializedCtEnabled,
  normalizeLoadedSkillName,
} from "../../src/tool/medToolsSkillGate.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

const MEDICAL_TOOLS = [
  "mcp__med-tools__med_deepchest_status",
  "mcp__med-tools__med_deepchest_submit",
  "mcp__med-tools__med_deepchest_job",
  "mcp__med-tools__med_parse_medical",
  "mcp__med-tools__med_dicom_route",
  "mcp__med-tools__med_trauma_rag_query",
  "mcp__med-tools__med_trauma_rag_status",
  "mcp__med-tools__med_trauma_stage_plan",
  "mcp__med-tools__med_radar_analyze_ct",
  "mcp__med-tools__med_radar_status",
  "mcp__med-tools__med_tools_health",
] as const;

const DISABLED_MEDICAL_TOOLS = [
  "mcp__med-tools__med_deepchest_status",
  "mcp__med-tools__med_deepchest_submit",
  "mcp__med-tools__med_deepchest_job",
  "mcp__med-tools__med_radar_analyze_ct",
  "mcp__med-tools__med_radar_status",
] as const;

function context(): PilotDeckToolRuntimeContext {
  const cwd = "/pilot/workspaces/trauma_med/trauma_med-test";
  return {
    sessionId: "session",
    turnId: "turn",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function generalContext(): PilotDeckToolRuntimeContext {
  const base = context();
  const cwd = "/pilot/workspaces/general_med/general_med-test";
  return {
    ...base,
    cwd,
    permissionContext: { ...base.permissionContext, cwd },
  };
}

function createRuntime(toolName: string): {
  runtime: ToolRuntime;
  executions: { count: number };
} {
  const registry = new ToolRegistry();
  const skills = [
    "med-medical",
    "med-trauma-assist",
    "med-trauma-stage-plan",
    "med-case-report",
    "med-radar-ct",
    "med-deepchest-3dmedagent",
    "med-dicom-router",
  ].map((name) => ({
    name: `med-tools:${name}`,
    path: `/plugins/med-tools/skills/${name}/SKILL.md`,
    description: name,
  }));
  registry.register(createReadSkillTool({
    loader: async (name) => {
      const shortName = normalizeLoadedSkillName(name);
      return skills.some((skill) => normalizeLoadedSkillName(skill.name) === shortName)
        ? `---\nname: ${shortName}\n---\n# ${shortName}\nFollow every step.`
        : undefined;
    },
    lister: () => skills,
  }));

  const executions = { count: 0 };
  registry.register({
    name: toolName,
    description: "medical test tool",
    kind: "mcp",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      executions.count += 1;
      return { content: [{ type: "text", text: "medical tool executed" }] };
    },
  });

  return {
    runtime: new ToolRuntime(registry, new PermissionRuntime()),
    executions,
  };
}

test("every med-tools MCP tool has a skill-gate mapping", () => {
  for (const toolName of MEDICAL_TOOLS) {
    assert.ok(getMedToolsSkillRequirement(toolName), toolName);
  }
  assert.ok(
    getMedToolsSkillRequirement("mcp__med-tools__future_medical_tool"),
    "future med-tools MCP tools must fail closed behind the default medical skill gate",
  );
  assert.equal(getMedToolsSkillRequirement("mcp__other__tool"), undefined);
});

test("RADAR tools require the med-radar-ct skill", () => {
  for (const toolName of [
    "mcp__med-tools__med_radar_analyze_ct",
    "mcp__med-tools__med_radar_status",
  ]) {
    assert.deepEqual(getMedToolsSkillRequirement(toolName), {
      loadSkill: "med-radar-ct",
      acceptedSkills: ["med-radar-ct"],
    });
  }
});

test("RADAR and DeepChest tools are hard-disabled before skill loading or execution", async () => {
  const previous = process.env.MED_SPECIALIZED_CT_ENABLED;
  process.env.MED_SPECIALIZED_CT_ENABLED = "0";
  try {
    for (const toolName of DISABLED_MEDICAL_TOOLS) {
      assert.equal(isMedToolDisabled(toolName), true, toolName);
      const { runtime, executions } = createRuntime(toolName);
      const result = await runtime.execute(
        { id: `${toolName}-disabled`, name: toolName, input: {} },
        context(),
      );
      assert.equal(result.type, "error", toolName);
      assert.equal(result.error.code, "permission_denied", toolName);
      assert.match(result.error.message, /temporarily disabled in offline mode/u);
      assert.equal(executions.count, 0, toolName);
    }
  } finally {
    if (previous === undefined) delete process.env.MED_SPECIALIZED_CT_ENABLED;
    else process.env.MED_SPECIALIZED_CT_ENABLED = previous;
  }
});

test("the specialized CT flag allows the skill gate to proceed", async () => {
  const previous = process.env.MED_SPECIALIZED_CT_ENABLED;
  process.env.MED_SPECIALIZED_CT_ENABLED = "1";
  try {
    assert.equal(isSpecializedCtEnabled(), true);
    const { runtime, executions } = createRuntime("mcp__med-tools__med_radar_status");
    const result = await runtime.execute(
      { id: "radar-enabled", name: "mcp__med-tools__med_radar_status", input: {} },
      context(),
    );
    assert.equal(result.type, "success");
    assert.equal(executions.count, 0);
    assert.equal(
      (result.metadata?.medToolsSkillGate as { retryRequired?: boolean } | undefined)
        ?.retryRequired,
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.MED_SPECIALIZED_CT_ENABLED;
    else process.env.MED_SPECIALIZED_CT_ENABLED = previous;
  }
});

test("DICOM route uses med-medical while specialized CT skills are hidden", () => {
  assert.deepEqual(getMedToolsSkillRequirement("mcp__med-tools__med_dicom_route"), {
    loadSkill: "med-medical",
    acceptedSkills: ["med-medical"],
  });
  assert.deepEqual(
    getMedToolsSkillRequirement("mcp__med-tools__med_radar_analyze_ct")?.acceptedSkills,
    ["med-radar-ct"],
  );
});

test("DeepChest is accepted for generic medical health checks but not RADAR", async () => {
  const previous = process.env.MED_SPECIALIZED_CT_ENABLED;
  process.env.MED_SPECIALIZED_CT_ENABLED = "1";
  try {
  const health = createRuntime("mcp__med-tools__med_tools_health");
  const loadedHealth = await health.runtime.execute(
    {
      id: "read-deepchest-health",
      name: "read_skill",
      input: { skillName: "med-tools:med-deepchest-3dmedagent" },
    },
    context(),
  );
  assert.equal(loadedHealth.type, "success");
  const healthResult = await health.runtime.execute(
    { id: "health", name: "mcp__med-tools__med_tools_health", input: {} },
    context(),
  );
  assert.equal(healthResult.type, "success");
  assert.equal(health.executions.count, 1);

  const radar = createRuntime("mcp__med-tools__med_radar_status");
  const loadedRadar = await radar.runtime.execute(
    {
      id: "read-deepchest-radar",
      name: "read_skill",
      input: { skillName: "med-deepchest-3dmedagent" },
    },
    context(),
  );
  assert.equal(loadedRadar.type, "success");
  const radarResult = await radar.runtime.execute(
    { id: "radar", name: "mcp__med-tools__med_radar_status", input: {} },
    context(),
  );
  assert.equal(radarResult.type, "success");
  assert.equal(radar.executions.count, 0);
  assert.equal(
    (radarResult.metadata?.medToolsSkillGate as { retryRequired?: boolean } | undefined)
      ?.retryRequired,
    true,
  );
  } finally {
    if (previous === undefined) delete process.env.MED_SPECIALIZED_CT_ENABLED;
    else process.env.MED_SPECIALIZED_CT_ENABLED = previous;
  }
});

test("general-medicine projects can load the trauma RAG skill gate", async () => {
  const toolName = "mcp__med-tools__med_trauma_rag_query";
  const { runtime, executions } = createRuntime(toolName);
  const result = await runtime.execute(
    { id: "general-trauma-rag", name: toolName, input: {} },
    generalContext(),
  );
  assert.equal(result.type, "success");
  assert.equal(
    (result.metadata?.medToolsSkillGate as { retryRequired?: boolean } | undefined)
      ?.retryRequired,
    true,
  );
  assert.equal(executions.count, 0);
});

test("every med-tools MCP tool is blocked once, loads its skill, and executes on retry", async () => {
  for (const toolName of MEDICAL_TOOLS) {
    if (isMedToolDisabled(toolName)) continue;
    const { runtime, executions } = createRuntime(toolName);
    const first = await runtime.execute(
      { id: `${toolName}-first`, name: toolName, input: {} },
      context(),
    );
    assert.equal(first.type, "success", toolName);
    assert.equal(executions.count, 0, toolName);
    assert.equal(
      (first.metadata?.medToolsSkillGate as { retryRequired?: boolean } | undefined)
        ?.retryRequired,
      true,
      toolName,
    );

    const second = await runtime.execute(
      { id: `${toolName}-second`, name: toolName, input: {} },
      context(),
    );
    assert.equal(second.type, "success", toolName);
    assert.equal(executions.count, 1, toolName);
  }
});

test("first medical MCP call loads its skill without executing, then retry executes", async () => {
  const toolName = "mcp__med-tools__med_trauma_stage_plan";
  const { runtime, executions } = createRuntime(toolName);

  const first = await runtime.execute(
    { id: "first", name: toolName, input: {} },
    context(),
  );
  assert.equal(first.type, "success");
  assert.equal(executions.count, 0);
  assert.equal(
    (first.metadata?.medToolsSkillGate as { retryRequired?: boolean } | undefined)
      ?.retryRequired,
    true,
  );
  assert.match(
    first.content.map((item) => item.type === "text" ? item.text : "").join("\n"),
    /med-tools:med-trauma-stage-plan/u,
  );

  const second = await runtime.execute(
    { id: "second", name: toolName, input: {} },
    context(),
  );
  assert.equal(second.type, "success");
  assert.equal(executions.count, 1);
  assert.equal(second.metadata?.medToolsSkillGate, undefined);
});

test("an explicit read_skill call unlocks the corresponding medical MCP tool", async () => {
  const toolName = "mcp__med-tools__med_trauma_rag_query";
  const { runtime, executions } = createRuntime(toolName);

  const loaded = await runtime.execute(
    {
      id: "read",
      name: "read_skill",
      input: { skillName: "med-tools:med-trauma-assist" },
    },
    context(),
  );
  assert.equal(loaded.type, "success");

  const result = await runtime.execute(
    { id: "query", name: toolName, input: {} },
    context(),
  );
  assert.equal(result.type, "success");
  assert.equal(executions.count, 1);
});

test("med-case-report unlocks attachment parsing without loading med-medical again", async () => {
  const toolName = "mcp__med-tools__med_parse_medical";
  const { runtime, executions } = createRuntime(toolName);

  await runtime.execute(
    {
      id: "read-report",
      name: "read_skill",
      input: { skillName: "med-tools:med-case-report" },
    },
    context(),
  );
  const result = await runtime.execute(
    { id: "parse", name: toolName, input: {} },
    context(),
  );

  assert.equal(result.type, "success");
  assert.equal(executions.count, 1);
  assert.equal(result.metadata?.medToolsSkillGate, undefined);
});
