import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoop,
  ProfileRegistry,
} from "../../../src/agent/index.js";
import {
  createDefaultPermissionContext,
  PermissionRuntime,
} from "../../../src/permission/index.js";
import { ToolRegistry, ToolRuntime } from "../../../src/tool/index.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";

function fakeTool(name: string) {
  return {
    name,
    description: name,
    kind: "custom" as const,
    inputSchema: { type: "object" as const, properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  };
}

test("agent loop applies trusted profile context, model controls, and narrowed tools", async () => {
  const profiles = new ProfileRegistry();
  profiles.replaceAll([
    {
      id: "triage",
      provider: "openrouter",
      model: "medical/model",
      maxOutputTokens: 2_048,
      temperature: 0.1,
      topP: 0.85,
      topK: 40,
      minP: 0.05,
      presencePenalty: 0.2,
      frequencyPenalty: 0.3,
      repetitionPenalty: 1.1,
      seed: 7,
      thinking: { enabled: true, mode: "low" as const, budgetTokens: 512 },
      allowedTools: ["read_file", "web_search"],
      deniedTools: ["bash"],
      metadata: { profileKind: "medical", memoryPolicy: "disabled" },
      systemContext: "Use the trusted clinical safety policy.",
    },
  ]);

  const tools = new ToolRegistry();
  for (const name of ["read_file", "web_search", "bash"]) {
    tools.register(fakeTool(name));
  }

  let routedMetadata: any;
  let executedRequest: any;
  let preparedMemoryPolicy: any;
  let captureCount = 0;

  const router = {
    invalidateSticky: () => ({ orchestrating: false }),
    async decide(input: any) {
      routedMetadata = input.metadata;
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "explicit",
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "explicit",
        mutations: {},
      };
    },
    async *execute(_decision: any, request: any) {
      executedRequest = request;
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream() {
      yield { type: "message_end", finishReason: "stop" };
    },
  };

  const context = {
    async prepareForModel(input: any) {
      preparedMemoryPolicy = input.memoryPolicy;
      return {
        messages: input.messages,
        systemPrompt: input.appendSystemPrompt,
        systemPromptParts: input.appendSystemPrompt
          ? [input.appendSystemPrompt]
          : [],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
      };
    },
    async applyToolResults(input: any) {
      return { messages: input.messages, diagnostics: [] };
    },
    async captureTurn() {
      captureCount += 1;
    },
  };

  const config: AgentRuntimeConfig = {
    provider: "openai",
    model: "default-model",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: process.cwd(),
      mode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
    }),
  };

  const loop = new AgentLoop(config, {
    router,
    tools: {
      registry: tools,
      scheduler: { async executeAll() { return []; } } as any,
    },
    context,
    profileRegistry: profiles,
    isModelAvailable: (provider: string, model: string) =>
      provider === "openrouter" && model === "medical/model",
    getModelTokenLimits: () => ({
      maxContextTokens: 128_000,
      maxOutputTokens: 4_096,
    }),
  } as AgentRuntimeDependencies);

  for await (const _event of loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    profile: "triage",
    turnOverrides: {
      allowedTools: ["read_file", "bash"],
      deniedTools: ["web_search"],
      temperature: 0.2,
      metadata: { workflow: "triage" },
    },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "review chart" }],
      },
    ],
  })) {
    // Drain.
  }

  assert.ok(executedRequest);
  assert.equal(executedRequest.provider, "openrouter");
  assert.equal(executedRequest.model, "medical/model");
  assert.equal(executedRequest.maxOutputTokens, 2_048);
  assert.equal(executedRequest.temperature, 0.2);
  assert.equal(executedRequest.topP, 0.85);
  assert.equal(executedRequest.topK, 40);
  assert.equal(executedRequest.minP, 0.05);
  assert.equal(executedRequest.presencePenalty, 0.2);
  assert.equal(executedRequest.frequencyPenalty, 0.3);
  assert.equal(executedRequest.repetitionPenalty, 1.1);
  assert.equal(executedRequest.seed, 7);
  assert.deepEqual(executedRequest.thinking, {
    enabled: true,
    mode: "low",
    budgetTokens: 512,
  });
  assert.deepEqual(
    executedRequest.tools?.map((tool: any) => tool.name),
    ["read_file"],
  );
  assert.equal(
    executedRequest.systemPrompt,
    "Use the trusted clinical safety policy.",
  );
  assert.deepEqual(executedRequest.metadata, {
    profileKind: "medical",
    memoryPolicy: "disabled",
    workflow: "triage",
  });
  assert.equal(preparedMemoryPolicy, "disabled");
  assert.equal(captureCount, 0);
  assert.equal(routedMetadata?.explicitProvider, "openrouter");
  assert.equal(routedMetadata?.explicitModel, "medical/model");
  assert.equal(routedMetadata?.serverValidatedModelOverride, true);
});

test("single-tool-pass profiles close tools after the first successful retrieval", async () => {
  const profiles = new ProfileRegistry();
  profiles.replaceAll([
    {
      id: "retrieval",
      allowedTools: ["read_file"],
      metadata: { singleToolPass: true },
      systemContext: "Retrieve once, then answer.",
    },
  ]);

  const tools = new ToolRegistry();
  tools.register(fakeTool("read_file"));

  const requests: string[][] = [];
  let modelCall = 0;
  const router = {
    invalidateSticky: () => ({ orchestrating: false }),
    async decide(input: any) {
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "explicit",
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "explicit",
        mutations: {},
      };
    },
    async *execute(_decision: any, request: any) {
      requests.push(request.tools?.map((tool: any) => tool.name) ?? []);
      yield { type: "message_start", role: "assistant" };
      if (modelCall++ === 0) {
        yield {
          type: "tool_call_end",
          toolCall: { id: "call-1", name: "read_file", input: {} },
        };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "final answer" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream() {
      yield { type: "message_end", finishReason: "stop" };
    },
  };

  const config: AgentRuntimeConfig = {
    provider: "openai",
    model: "default-model",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: process.cwd(),
      mode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
    }),
  };

  const loop = new AgentLoop(config, {
    router,
    tools: {
      registry: tools,
      scheduler: {
        async executeAll(calls: any[]) {
          const now = new Date().toISOString();
          return calls.map((call) => ({
            type: "success" as const,
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: "retrieved evidence" }],
            startedAt: now,
            completedAt: now,
          }));
        },
      },
    },
    profileRegistry: profiles,
  } as any);

  for await (const _event of loop.run({
    sessionId: "session-single-pass",
    turnId: "turn-single-pass",
    profile: "retrieval",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "retrieve evidence" }],
      },
    ],
  })) {
    // Drain.
  }

  assert.deepEqual(requests, [["read_file"], []]);
});

test("tool runtime enforces profile policy even for direct or nested calls", async () => {
  const tools = new ToolRegistry();
  let executed = false;
  let nestedErrorCode: string | undefined;

  tools.register({
    ...fakeTool("bash"),
    async execute() {
      executed = true;
      return { content: [{ type: "text" as const, text: "unexpected" }] };
    },
  });

  tools.register({
    ...fakeTool("wrapper"),
    async execute(_input: any, context: any) {
      const nested = await context.executeTool?.(
        { id: "call-nested", name: "bash", input: {} },
        { toolPolicy: undefined },
      );
      nestedErrorCode =
        nested?.type === "error" ? nested.error.code : undefined;
      return { content: [{ type: "text" as const, text: "wrapped" }] };
    },
  });

  const runtime = new ToolRuntime(tools, new PermissionRuntime());
  const permissionContext = createDefaultPermissionContext({
    cwd: process.cwd(),
    mode: "bypassPermissions",
    bypassAvailable: true,
    canPrompt: false,
  });

  const result = await runtime.execute(
    { id: "call-1", name: "wrapper", input: {} },
    {
      sessionId: "session-1",
      turnId: "turn-1",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      permissionContext,
      toolPolicy: { allowedTools: ["wrapper"], deniedTools: ["bash"] },
    } as any,
  );

  assert.equal(result.type, "success");
  assert.equal(nestedErrorCode, "permission_denied");
  assert.equal(executed, false);
});
