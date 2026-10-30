import assert from "node:assert/strict";
import test from "node:test";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

function makeGateway(options: ConstructorParameters<typeof InProcessGateway>[1]) {
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => {
      throw new Error("no session needed for case reads");
    },
  });
  return new InProcessGateway(router, options);
}

test("in-process gateway answers an empty case for a non-trauma project instead of throwing", async () => {
  const seen: string[] = [];
  const gateway = makeGateway({
    traumaCaseReader: async ({ projectKey }) => {
      seen.push(projectKey);
      return { current: null, snapshots: [] };
    },
  });

  const result = await gateway.traumaGetCase({ projectKey: "general-notes", sessionKey: "web:s_1" });

  assert.deepEqual(result, { current: null, snapshots: [] });
  assert.deepEqual(seen, [], "the reader is only consulted for war_trauma projects");
});

test("in-process gateway forwards trauma project reads to the reader", async () => {
  const seen: string[] = [];
  const gateway = makeGateway({
    traumaCaseReader: async ({ projectKey }) => {
      seen.push(projectKey);
      return { current: null, snapshots: [] };
    },
  });

  await gateway.traumaGetCase({ projectKey: "trauma_med-demo", sessionKey: "web:s_1" });

  assert.deepEqual(seen, ["trauma_med-demo"]);
});

test("in-process gateway still fails when no case reader is configured", async () => {
  const gateway = makeGateway({});
  await assert.rejects(
    gateway.traumaGetCase({ projectKey: "trauma_med-demo", sessionKey: "web:s_1" }),
    /not configured/,
  );
});
