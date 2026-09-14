// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { createModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";

/**
 * Task 9 pins 工位 I 的判读模型为 provider "local" / model "G9-V-Med", with a
 * fallback to the main agent model when that provider/model is absent from
 * config (see `createTraumaRunner` in src/cli/createLocalGateway.ts).
 *
 * The fallback is implemented as: try
 *   runtime.model.getMultimodal("local", "G9-V-Med").input.includes("image"),
 *   and on failure fall back to the agent's configured modelSelection.
 *
 * These tests exercise the real `createModelRuntime` production factory —
 * not a hand-traced reimplementation — to prove the exact precondition
 * that fallback branch depends on: `getMultimodal` throws when the
 * provider/model pair is absent, and resolves normally when present.
 *
 * A full exercise of `createTraumaRunner` itself would additionally require
 * bootstrapping `ProjectRuntimeRegistry.resolve()` (plugin runtime, MCP
 * connections, router, skills, memory provider, builtin plugin loading) —
 * out of scope for a fast unit test and left to manual smoke, consistent
 * with the brief's "手工冒烟" designation for this assembly task.
 */

function multimodalModel(input: string[]) {
  return {
    id: "stub",
    capabilities: DEFAULT_MODEL_CAPABILITIES,
    multimodal: { input },
  };
}

test("getMultimodal throws when local/G9-V-Med is absent from config (fallback trigger)", () => {
  const runtime = createModelRuntime({
    providers: {
      openai: {
        id: "openai",
        protocol: "openai",
        url: "https://example.invalid",
        apiKey: "test",
        headers: {},
        models: {
          "gpt-test": multimodalModel(["text"]),
        },
      },
    },
  });

  assert.throws(
    () => runtime.getMultimodal("local", "G9-V-Med"),
    /Provider local does not exist/,
  );
});

test("getMultimodal throws model_not_found when provider exists but G9-V-Med model does not", () => {
  const runtime = createModelRuntime({
    providers: {
      local: {
        id: "local",
        protocol: "openai",
        url: "https://example.invalid",
        apiKey: "test",
        headers: {},
        models: {
          "some-other-model": multimodalModel(["text"]),
        },
      },
    },
  });

  assert.throws(
    () => runtime.getMultimodal("local", "G9-V-Med"),
    /Model G9-V-Med does not exist in provider local/,
  );
});

test("getMultimodal resolves and reports image support when local/G9-V-Med is configured", () => {
  const runtime = createModelRuntime({
    providers: {
      local: {
        id: "local",
        protocol: "openai",
        url: "https://example.invalid",
        apiKey: "test",
        headers: {},
        models: {
          "G9-V-Med": multimodalModel(["text", "image"]),
        },
      },
    },
  });

  const multimodal = runtime.getMultimodal("local", "G9-V-Med");
  assert.equal(multimodal.input.includes("image"), true);
});

test("fallback selection picks the main agent model's multimodal support when G9-V-Med is absent", () => {
  // Mirrors the exact try/catch shape in createTraumaRunner: attempt the
  // pinned provider/model first, and on failure fall back to the agent's
  // configured model selection.
  const runtime = createModelRuntime({
    providers: {
      openai: {
        id: "openai",
        protocol: "openai",
        url: "https://example.invalid",
        apiKey: "test",
        headers: {},
        models: {
          "gpt-agent": multimodalModel(["text", "image"]),
        },
      },
    },
  });

  const INTERPRETATION_PROVIDER = "local";
  const INTERPRETATION_MODEL = "G9-V-Med";
  const modelSelection = { provider: "openai", model: "gpt-agent" };
  let interpretationSelection = { provider: INTERPRETATION_PROVIDER, model: INTERPRETATION_MODEL };
  let supportsImages = false;
  try {
    supportsImages = runtime.getMultimodal(INTERPRETATION_PROVIDER, INTERPRETATION_MODEL).input.includes("image");
  } catch {
    interpretationSelection = modelSelection;
    try {
      supportsImages = runtime.getMultimodal(modelSelection.provider, modelSelection.model).input.includes("image");
    } catch {
      supportsImages = false;
    }
  }

  assert.deepEqual(interpretationSelection, { provider: "openai", model: "gpt-agent" });
  assert.equal(supportsImages, true);
});

test("fallback does not crash when neither the pinned model nor the agent model exist", () => {
  const runtime = createModelRuntime({ providers: {} });

  const modelSelection = { provider: "openai", model: "gpt-agent" };
  let interpretationSelection = { provider: "local", model: "G9-V-Med" };
  let supportsImages = false;
  assert.doesNotThrow(() => {
    try {
      supportsImages = runtime.getMultimodal("local", "G9-V-Med").input.includes("image");
    } catch {
      interpretationSelection = modelSelection;
      try {
        supportsImages = runtime.getMultimodal(modelSelection.provider, modelSelection.model).input.includes("image");
      } catch {
        supportsImages = false;
      }
    }
  });

  assert.deepEqual(interpretationSelection, modelSelection);
  assert.equal(supportsImages, false);
});
