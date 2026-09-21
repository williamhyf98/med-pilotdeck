import assert from "node:assert/strict";
import test from "node:test";
import { createMcpToolDefinitionsFromRuntime, shouldEndTurnAfterDirectStream } from "../../src/mcp/runtime/PluginToToolBridge.js";

test("med_parse_medical always leaves the final answer to the main agent", () => {
  assert.equal(
    shouldEndTurnAfterDirectStream("med_parse_medical", {}),
    false,
  );
  assert.equal(
    shouldEndTurnAfterDirectStream("med_parse_medical", { continuation_mode: "terminal" }),
    false,
  );
});

for (const mode of [undefined, "terminal", "material"]) {
  test(`medical ${mode} output stays in tool material rather than the answer stream`, async () => {
    const events: any[] = [];
    let calledInput: any;
    const payload = { ok: true, report: "影像所见：右肺异常，需结合临床", summary: "原始解析", continuation_mode: "terminal", presentation: "报告已作为最终回答，不要再输出" };
    const runtime = {
      async listAllTools() { return [{ serverId: "med-tools", toolName: "med_parse_medical", wireName: "mcp__med-tools__med_parse_medical", description: "parse", inputSchema: { type: "object" } }]; },
      getClient() { return { spec: { transport: "http" }, async callTool(_name: string, input: any, options: any) {
        calledInput = input;
        options.onProgress?.({ progress: 1, message: payload.report });
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } }; },
    };
    const [tool] = await createMcpToolDefinitionsFromRuntime(runtime as any);
    const result = await tool!.execute({ path: "/record.dcm", ...(mode ? { continuation_mode: mode } : {}) }, {
      sessionId: "session", turnId: "turn", progress: (event: any) => events.push(event),
    } as any);
    assert.equal(calledInput.continuation_mode, "material");
    assert.equal(events.some(event => event.metadata?.channel === "assistant_text_delta"), false);
    assert.equal(result.metadata?.directFinalAssistantText, undefined);
    const data = result.data as any;
    assert.equal(data.report, payload.report);
    assert.equal(data.agent_continue, true);
    assert.equal(data.continuation_mode, "material");
    assert.ok(result.content.some(item => item.type === "text" && item.text.includes(payload.report)));
    assert.ok(!JSON.stringify(result.content).includes("报告已作为最终回答"));
  });
}

test("med_parse_medical material mode keeps the turn open", () => {
  assert.equal(
    shouldEndTurnAfterDirectStream("med_parse_medical", { continuation_mode: "material" }),
    false,
  );
  assert.equal(
    shouldEndTurnAfterDirectStream(
      "med_parse_medical",
      { continuation_mode: "terminal" },
      "material",
    ),
    false,
  );
});

test("med_trauma_stage_plan never ends the turn via direct-final", () => {
  assert.equal(
    shouldEndTurnAfterDirectStream("med_trauma_stage_plan", {}),
    false,
  );
});

test("failed medical calls remain errors and never leak partial model prose", async () => {
  const events: any[] = [];
  const runtime = {
    async listAllTools() { return [{ serverId: "med-tools", toolName: "med_parse_medical", wireName: "mcp__med-tools__med_parse_medical", inputSchema: { type: "object" } }]; },
    getClient() { return { spec: { transport: "http" }, async callTool(_name: string, _input: unknown, options: any) {
      options.onProgress?.({ progress: 1, message: "不完整判读" });
      return { isError: true, content: [{ type: "text", text: "parse failed" }] };
    } }; },
  };
  const [tool] = await createMcpToolDefinitionsFromRuntime(runtime as any);
  await assert.rejects(() => tool!.execute({ path: "/record.dcm" }, {
    progress: (event: any) => events.push(event),
  } as any), /parse failed/);
  assert.equal(events.length, 0);
});

test("empty medical reports still hand available sources to the main agent", async () => {
  const runtime = {
    async listAllTools() { return [{ serverId: "med-tools", toolName: "med_parse_medical", wireName: "mcp__med-tools__med_parse_medical", inputSchema: { type: "object" } }]; },
    getClient() { return { spec: { transport: "http" }, async callTool() {
      return { content: [{ type: "text", text: JSON.stringify({ report: "", summary: "可用解析资料", vlm_error: "unavailable" }) }] };
    } }; },
  };
  const [tool] = await createMcpToolDefinitionsFromRuntime(runtime as any);
  const result = await tool!.execute({ path: "/record.dcm" }, {} as any);
  assert.equal((result.data as any).summary, "可用解析资料");
  assert.equal((result.data as any).vlm_error, "unavailable");
  assert.equal((result.data as any).agent_continue, true);
  assert.equal(result.metadata?.directFinalAssistantText, undefined);
});
