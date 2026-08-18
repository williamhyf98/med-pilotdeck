// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession, TurnRunner, } from "../../../src/agent/index.js";
import { InProcessGateway } from "../../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../../src/gateway/SessionRouter.js";
const TURN_OVERRIDES = {
    provider: "openai",
    model: "gpt-medical",
    maxOutputTokens: 2_048,
    temperature: 0.1,
    topP: 0.9,
    allowedTools: ["read_file"],
    metadata: { workflow: "triage" },
};
test("gateway forwards profile and turn overrides to AgentSubmitOptions", async () => {
    let captured;
    const router = new SessionRouter({
        idleSweepIntervalMs: 0,
        createSession: () => fakeSession((options) => {
            captured = options;
        }),
    });
    const gateway = new InProcessGateway(router, { uuid: () => "run-1" });
    for await (const _event of gateway.submitTurn({
        sessionKey: "session-1",
        channelKey: "test",
        message: "triage",
        profile: "medical:triage",
        turnOverrides: TURN_OVERRIDES,
    })) {
        // Drain.
    }
    assert.equal(captured?.profile, "medical:triage");
    assert.deepEqual(captured?.turnOverrides, TURN_OVERRIDES);
});
test("AgentSession forwards profile and turn overrides to TurnRunnerOptions", async () => {
    let captured;
    const turnRunner = {
        async *run(options) {
            captured = options;
            return { result: successResult(options.sessionId, options.turnId), messages: options.messages };
        },
    };
    const session = new AgentSession({
        sessionId: "session-1",
        turnRunner: turnRunner,
        uuid: () => "turn-1",
    });
    for await (const _event of session.submit({ type: "text", text: "triage" }, { profile: "medical:triage", turnOverrides: TURN_OVERRIDES })) {
        // Drain.
    }
    assert.equal(captured?.profile, "medical:triage");
    assert.deepEqual(captured?.turnOverrides, TURN_OVERRIDES);
});
test("TurnRunner forwards profile and turn overrides to AgentLoopInput", async () => {
    let captured;
    let acceptedMetadata;
    const loop = {
        async *run(input) {
            captured = input;
            return { result: successResult(input.sessionId, input.turnId), messages: input.messages };
        },
    };
    const transcript = {
        async recordAcceptedInput(_sessionId, _turnId, _messages, metadata) {
            acceptedMetadata = metadata;
        },
        async recordDurableMessage() { },
        async recordTurnResult() { },
    };
    const runner = new TurnRunner(loop, transcript, undefined, () => new Date("2026-08-06T00:00:00.000Z"), undefined, { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false });
    for await (const _event of runner.run({
        sessionId: "session-1",
        turnId: "turn-1",
        messages: [],
        input: { type: "text", text: "triage" },
        profile: "medical:triage",
        turnOverrides: TURN_OVERRIDES,
    })) {
        // Drain.
    }
    assert.equal(captured?.profile, "medical:triage");
    assert.deepEqual(captured?.turnOverrides, TURN_OVERRIDES);
    assert.deepEqual(acceptedMetadata, {
        agentProfile: "medical:triage",
        turnMetadata: { workflow: "triage" },
    });
});
function fakeSession(onSubmit) {
    return {
        async *submit(_input, options = {}) {
            onSubmit(options);
            yield {
                type: "turn_completed",
                sessionId: "session-1",
                turnId: options.turnId ?? "turn-1",
                result: successResult("session-1", options.turnId ?? "turn-1"),
            };
        },
        abort() { },
        snapshot() {
            return {
                sessionId: "session-1",
                messages: [],
                usage: {},
                status: "idle",
                permissionDenials: [],
            };
        },
    };
}
function successResult(sessionId, turnId) {
    return {
        type: "success",
        sessionId,
        turnId,
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: "2026-08-06T00:00:00.000Z",
        completedAt: "2026-08-06T00:00:00.000Z",
    };
}
