import assert from "node:assert/strict";
import test from "node:test";
import { isAlwaysOnDisabled } from "../../src/cli/serverFeatureFlags.js";

test("isAlwaysOnDisabled is off unless the env var is explicitly truthy", () => {
  assert.equal(isAlwaysOnDisabled({}), false);
  assert.equal(isAlwaysOnDisabled({ PILOTDECK_DISABLE_ALWAYS_ON: "" }), false);
  assert.equal(isAlwaysOnDisabled({ PILOTDECK_DISABLE_ALWAYS_ON: "0" }), false);
  assert.equal(isAlwaysOnDisabled({ PILOTDECK_DISABLE_ALWAYS_ON: "false" }), false);
  // Anything that is not 1/true stays enabled rather than silently disabling
  // every background subsystem on a typo.
  assert.equal(isAlwaysOnDisabled({ PILOTDECK_DISABLE_ALWAYS_ON: "yes" }), false);
  assert.equal(isAlwaysOnDisabled({ PILOTDECK_DISABLE_ALWAYS_ON: "no" }), false);
});

test("isAlwaysOnDisabled accepts 1/true in any case, with surrounding spaces", () => {
  assert.equal(isAlwaysOnDisabled({ PILOTDECK_DISABLE_ALWAYS_ON: "1" }), true);
  assert.equal(isAlwaysOnDisabled({ PILOTDECK_DISABLE_ALWAYS_ON: "true" }), true);
  assert.equal(isAlwaysOnDisabled({ PILOTDECK_DISABLE_ALWAYS_ON: "TRUE" }), true);
  assert.equal(isAlwaysOnDisabled({ PILOTDECK_DISABLE_ALWAYS_ON: " 1 " }), true);
});

test("isAlwaysOnDisabled reads process.env when no env is passed", () => {
  const previous = process.env.PILOTDECK_DISABLE_ALWAYS_ON;
  try {
    delete process.env.PILOTDECK_DISABLE_ALWAYS_ON;
    assert.equal(isAlwaysOnDisabled(), false);
    process.env.PILOTDECK_DISABLE_ALWAYS_ON = "1";
    assert.equal(isAlwaysOnDisabled(), true);
  } finally {
    if (previous === undefined) delete process.env.PILOTDECK_DISABLE_ALWAYS_ON;
    else process.env.PILOTDECK_DISABLE_ALWAYS_ON = previous;
  }
});

// The pool sets exactly this value (gatewayPool.js defaultSpawnGateway); if the
// pool and the engine ever disagree on the spelling, pooled gateways would each
// start their own cron daemon and IM bots again.
test("the value the gateway pool sets is recognised", () => {
  assert.equal(isAlwaysOnDisabled({ PILOTDECK_DISABLE_ALWAYS_ON: "1" }), true);
});
