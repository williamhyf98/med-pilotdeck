import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "../../../src/agent/index.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../../src/permission/index.js";
import { ToolRegistry, ToolRuntime } from "../../../src/tool/index.js";
import { createEnterPlanModeTool, createExitPlanModeTool } from "../../../src/tool/builtin/planMode.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";

function setup(mode: "agent" | "plan" | "ask") {
  const registry = new ToolRegistry();
  registry.register(createEnterPlanModeTool());
  registry.register(createExitPlanModeTool());
  const config: AgentRuntimeConfig = {
    provider: "test", model: "test", cwd: process.cwd(), runMode: mode,
    permissionMode: mode === "plan" ? "plan" : "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: process.cwd(), mode: mode === "plan" ? "plan" : "bypassPermissions",
      bypassAvailable: true, canPrompt: true,
    }),
  };
  return { registry, config, runtime: new ToolRuntime(registry, new PermissionRuntime()) };
}

for (const mode of ["agent", "ask"] as const) {
  for (const name of ["enter_plan_mode", "EnterPlanMode", "exit_plan_mode"] as const) {
    test(`${mode} rejects ${name} even when the caller enables plan tools`, async () => {
      const { runtime, config } = setup(mode);
      const result = await runtime.execute({ id: "call", name, input: {} }, {
        ...config, sessionId: "session", turnId: "turn", allowPlanModeTools: true,
      } as any);
      assert.equal(result.type, "error");
      if (result.type === "error") assert.equal(result.error.code, "permission_denied");
    });
  }
}

test("nested calls cannot enable plan submission by overriding the execution context", async () => {
  const { registry, runtime, config } = setup("agent");
  let nested: any;
  registry.register({
    name: "wrapper", description: "wrapper", kind: "custom",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true, isConcurrencySafe: () => true,
    async execute(_input, context) {
      nested = await context!.executeTool!({ id: "nested", name: "exit_plan_mode", input: {} }, {
        allowPlanModeTools: true, permissionMode: "plan", runMode: "plan",
      });
      return { content: [{ type: "text", text: "done" }] };
    },
  });
  await runtime.execute({ id: "wrapper", name: "wrapper", input: {} }, {
    cwd: config.cwd, runMode: config.runMode, permissionMode: config.permissionMode,
    permissionContext: config.permissionContext,
    sessionId: "session", turnId: "turn", allowPlanModeTools: false,
  });
  assert.equal(nested.type, "error");
  assert.equal(nested.error.code, "permission_denied");
});

async function runLoop(mode: "agent" | "plan" | "ask", action?: "execute_plan" | "continue_planning" | "cancelled") {
  const { config, registry, runtime } = setup(mode);
  const requests: string[][] = [];
  const preparedModes: string[] = [];
  let calls = 0;
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-plan-policy-"));
  const plans = join(dir, ".pilotdeck", "plans");
  const plan = join(plans, "plan.md");
  await mkdir(plans, { recursive: true });
  await writeFile(plan, "# Plan\n\n1. Review medical materials.\n");
  const loop = new AgentLoop(config, {
    router: {
      invalidateSticky: () => ({ orchestrating: false }),
      async decide(input: any) {
        return { provider: "test", model: "test", scenarioType: "explicit", isSubagent: false,
          orchestrating: false, resolvedFrom: "explicit", mutations: {} };
      },
      async *execute(_decision: any, request: any) {
        requests.push(request.tools?.map((tool: any) => tool.name) ?? []);
        yield { type: "message_start", role: "assistant" };
        if (action && calls++ === 0) {
          yield { type: "tool_call_end", toolCall: { id: "approve", name: "exit_plan_mode", input: { plan_file_path: plan } } };
          yield { type: "message_end", finishReason: "tool_call" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_end", finishReason: "stop" };
        }
      },
    },
    tools: { registry, scheduler: {
      async executeAll(toolCalls: any[], context: any) {
        const results = [];
        for (const call of toolCalls) results.push(await runtime.execute(call, {
          ...context,
          planDirectory: { path: plans, resolve: (path: string) => path === plan ? path : undefined },
          elicitation: { async askUser() {
            return action === "cancelled" ? { type: "cancelled" } : { type: "answered", answers: { next: action } };
          } },
        }));
        return results;
      },
    } },
    context: {
      async prepareForModel(input: any) {
        preparedModes.push(input.runMode);
        return { messages: input.messages, tools: input.tools, diagnostics: [], boundaries: [] };
      },
      async applyToolResults(input: any) { return { messages: input.messages, diagnostics: [] }; },
    },
  } as any);
  const events = [];
  try {
    for await (const event of loop.run({
      sessionId: "session", turnId: "turn", runMode: mode,
      permissionMode: config.permissionMode, basePermissionMode: "bypassPermissions",
      allowPlanModeTools: true,
      messages: [{ role: "user", content: [{ type: "text", text: "Review materials" }] }],
    })) events.push(event);
    return { requests, config, preparedModes, events };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const mode of ["agent", "ask", "plan"] as const) {
  test(`${mode} only advertises user-authorized plan submission`, async () => {
    const { requests } = await runLoop(mode);
    assert.deepEqual(requests, [mode === "plan" ? ["exit_plan_mode"] : []]);
  });
}

test("approved plan restores agent mode and original permissions and closes plan tools in the same turn", async () => {
  const { requests, config, preparedModes, events } = await runLoop("plan", "execute_plan");
  assert.deepEqual(requests, [["exit_plan_mode"], []]);
  assert.deepEqual(preparedModes, ["plan", "agent"]);
  assert.equal(config.runMode, "agent");
  assert.equal(config.permissionMode, "bypassPermissions");
  assert.ok(events.some(event => event.type === "mode_change_requested" && event.mode === "bypassPermissions"));
});

for (const action of ["continue_planning", "cancelled"] as const) {
  test(`${action} does not authorize execution`, async () => {
    const { requests, config } = await runLoop("plan", action);
    assert.equal(config.permissionMode, "plan");
    assert.equal(config.runMode, "plan");
    assert.ok(requests.every(names => names.includes("exit_plan_mode") && !names.includes("enter_plan_mode")));
  });
}
