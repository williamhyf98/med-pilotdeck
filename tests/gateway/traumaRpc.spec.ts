import assert from "node:assert/strict";
import test from "node:test";

import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";

test("remote gateway forwards trauma case reads through websocket RPC", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { current: null, snapshots: [] };
    },
  };
  const gateway = new RemoteGateway(client as never);
  const input = { projectKey: "trauma_med-demo", sessionKey: "web:s_demo" };

  const result = await gateway.traumaGetCase(input);

  assert.deepEqual(calls, [{ method: "trauma_get_case", params: input }]);
  assert.deepEqual(result, { current: null, snapshots: [] });
});

test("remote gateway forwards trauma transition and override RPCs", async () => {
  const methods: string[] = [];
  const client = {
    request: async (method: string) => {
      methods.push(method);
      return {};
    },
  };
  const gateway = new RemoteGateway(client as never);

  await gateway.traumaConfirmTransition({
    projectKey: "trauma_med-demo",
    sessionKey: "web:s_demo",
    answer: "confirmed",
    expectedVersion: 1,
  });
  await gateway.traumaOverrideStage({
    projectKey: "trauma_med-demo",
    sessionKey: "web:s_demo",
    actorId: "web-user",
    toStage: "early_treatment",
    toSubStage: "emergency_treatment",
    reason: "人工调整",
    riskAcknowledged: true,
  });

  assert.deepEqual(methods, ["trauma_confirm_transition", "trauma_override_stage"]);
});
