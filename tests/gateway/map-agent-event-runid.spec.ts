// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";
test("mapAgentEvent propagates runId to streaming lifecycle boundaries", () => {
    const runId = "run-1";
    const toolStarted = mapAgentEvent({
        type: "tool_calls_detected",
        sessionId: "session-1",
        turnId: "turn-1",
        calls: [{ id: "call-1", name: "bash", input: { command: "pwd" } }],
    }, runId);
    assert.equal(toolStarted[0]?.type, "tool_call_started");
    assert.equal(toolStarted[0]?.runId, runId);
    const completed = mapAgentEvent({
        type: "turn_completed",
        sessionId: "session-1",
        turnId: "turn-1",
        result: {
            stopReason: "completed",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
    }, runId);
    assert.equal(completed[0]?.type, "turn_completed");
    assert.equal(completed[0]?.runId, runId);
    const failed = mapAgentEvent({
        type: "turn_failed",
        sessionId: "session-1",
        turnId: "turn-1",
        error: { code: "model_error", message: "boom" },
    }, runId);
    assert.equal(failed[0]?.type, "error");
    assert.equal(failed[0]?.runId, runId);
});

test("mapAgentEvent projects direct tool text progress into assistant deltas", () => {
    const events = mapAgentEvent({
        type: "tool_progress",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "mcp__med-tools__med_trauma_stage_plan",
        message: "G9 stream",
        metadata: {
            channel: "assistant_text_delta",
            text: "一、图像/影像判读",
        },
        createdAt: new Date().toISOString(),
    }, "run-1");
    assert.deepEqual(events, [{
        type: "assistant_text_delta",
        text: "一、图像/影像判读",
        runId: "run-1",
    }]);
});

test("mapAgentEvent projects allow-listed medical progress into tool activity", () => {
    const events = mapAgentEvent({
        type: "tool_progress",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "call-radar",
        toolName: "mcp__med-tools__med_radar_analyze_ct",
        message: "正在执行 RADAR 推理",
        metadata: {
            channel: "medical_activity",
            activityId: "medical:call-radar",
            title: "正在执行 RADAR 推理",
            detail: "远程模型正在分析三维 CT",
            state: "running",
        },
        createdAt: "2026-09-21T08:00:00.000Z",
    }, "run-medical");

    assert.deepEqual(events, [{
        type: "tool_activity",
        activityId: "medical:call-radar",
        toolCallId: "call-radar",
        toolName: "mcp__med-tools__med_radar_analyze_ct",
        title: "正在执行 RADAR 推理",
        detail: "远程模型正在分析三维 CT",
        state: "running",
        phase: "medical",
        createdAt: "2026-09-21T08:00:00.000Z",
        runId: "run-medical",
    }]);
});

test("mapAgentEvent drops arbitrary tool progress instead of exposing stdout", () => {
    const events = mapAgentEvent({
        type: "tool_progress",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "call-bash",
        toolName: "bash",
        message: "stdout: 24 bytes",
        metadata: {
            stream: "stdout",
            chunk: "/private/patient/path\n",
        },
        createdAt: "2026-09-21T08:00:00.000Z",
    }, "run-medical");

    assert.deepEqual(events, []);
});
