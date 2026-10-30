import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentLoop } from "../../../src/agent/index.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../../src/permission/index.js";
import { ToolRegistry, ToolRuntime } from "../../../src/tool/index.js";
import { createReadFileTool } from "../../../src/tool/builtin/readFile.js";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";
import { EdgeClawMemoryProvider } from "../../../src/context/memory/EdgeClawMemoryProvider.js";
import type { ContextMemoryMessage } from "../../../src/context/memory/MemoryResolver.js";

test("loop captures source before context replacement and never reuses previous upload allowlist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-attachment-"));
  const file = join(dir, "record.xml");
  writeFileSync(file, "<record>既往高血压，青霉素过敏</record>");
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const captured: ContextMemoryMessage[][] = [];
  let calls = 0;
  const provider = new EdgeClawMemoryProvider({ service: {
    async retrieveContext() { return {}; },
    captureTurn(messages, input) {
      const normalizedMessages = [...messages] as ContextMemoryMessage[];
      captured.push(normalizedMessages);
      return { captured: true, normalizedMessages, sessionKey: input.sessionKey };
    },
  } });
  // Exercise the actual runtime handoff as well as the provider conversion.
  const captureTurn = DefaultContextRuntime.prototype.captureTurn.bind({ memoryResolver: provider, projectRoot: dir });
  const loop = new AgentLoop({ provider: "test", model: "test", cwd: dir,
    runMode: "agent", permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({ cwd: dir, mode: "bypassPermissions", bypassAvailable: true, canPrompt: false }),
  }, {
    router: {
      invalidateSticky: () => ({ orchestrating: false }),
      async decide() { return { provider: "test", model: "test", scenarioType: "explicit", isSubagent: false,
        orchestrating: false, resolvedFrom: "explicit", mutations: {} }; },
      async *execute() {
        yield { type: "message_start", role: "assistant" };
        if (calls++ % 2 === 0) {
          yield { type: "tool_call_end", toolCall: { id: "read", name: "read_file", input: { file_path: file } } };
          yield { type: "message_end", finishReason: "tool_call" };
        } else {
          yield { type: "text_delta", text: "病情分析完成" };
          yield { type: "message_end", finishReason: "stop" };
        }
      },
    },
    tools: { registry, scheduler: { async executeAll(toolCalls: any[], context: any) {
      return Promise.all(toolCalls.map(call => runtime.execute(call, context)));
    } } },
    context: {
      async prepareForModel(input: any) { return { messages: input.messages, tools: input.tools, diagnostics: [], boundaries: [] }; },
      async applyToolResults() {
        // Simulate compaction/budgeting removing the original user and read result.
        return { messages: [{ role: "user", content: [{ type: "text", text: "压缩摘要" }], metadata: { synthetic: true } }], diagnostics: [] };
      },
      captureTurn,
    },
  } as any);
  try {
    for (const turn of [1, 2]) {
      for await (const _event of loop.run({ sessionId: "session", turnId: String(turn),
        messages: [{ role: "user", content: [{ type: "text", text: "请分析当前病人情况" }] }],
        ...(turn === 1 ? { allowedReadFiles: [file] } : {}),
      })) { /* Drain the complete turn, including capture. */ }
    }
    assert.equal(captured.length, 2);
    assert.ok(captured[0]?.[0]?.attachmentEvidence?.[0]?.chunks.join("").includes("青霉素过敏"));
    assert.equal(captured[0]?.[0]?.content, "请分析当前病人情况");
    assert.ok(captured[1]!.every(message => !message.attachmentEvidence?.length));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
