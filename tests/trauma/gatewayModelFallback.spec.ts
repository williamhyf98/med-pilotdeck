// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";

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

/**
 * The two tests below used to hand-copy the try/catch fallback block out of
 * `createTraumaRunner` into the test body and assert against that copy —
 * they would keep passing even if the real fallback were deleted from
 * production. These replacements instead drive the actual assembly seam:
 * `createLocalGateway({ __testModelFactory })` → `registry.createTraumaRunner()`,
 * with a spy wrapped around the *real* `createModelRuntime(...).getMultimodal`
 * (same production function exercised in the tests above). The spy's call
 * log proves which provider/model pair `createTraumaRunner` actually probed
 * and, by construction (the very next lines in production code consume
 * `interpretationSelection` with no further branching), which one the
 * interpreter's model client was built with.
 *
 * `createTraumaRunner` requires a `war_trauma`-typed project id (checked by
 * `resolveTraumaCaseDir`), so the fixture project directory is named
 * `trauma_med-<label>`.
 */

type GetMultimodalCall = [provider: string, model: string];

async function withTraumaRunnerGateway(
  label: string,
  configYaml: string,
  run: (ctx: { calls: GetMultimodalCall[]; projectRoot: string; registry: any }) => Promise<void>,
): Promise<void> {
  const pilotHome = await mkdtemp(join(tmpdir(), "trauma-fallback-home-"));
  const projectBase = await mkdtemp(join(tmpdir(), "trauma-fallback-proj-"));
  const projectRoot = join(projectBase, `trauma_med-${label}`);
  await mkdir(projectRoot, { recursive: true });
  const projectMarker = join(pilotHome, 'projects', 'trauma_med', `trauma_med-${label}`);
  await mkdir(projectMarker, { recursive: true });
  await writeFile(join(projectMarker, '.cwd'), projectRoot, 'utf8');
  await writeFile(join(pilotHome, "pilotdeck.yaml"), configYaml, "utf8");

  const calls: GetMultimodalCall[] = [];
  const result = createLocalGateway({
    projectRoot,
    pilotHome,
    env: { PILOT_HOME: pilotHome },
    __testModelFactory: (snapshot) => {
      const real = createModelRuntime(snapshot.config.model);
      return {
        ...real,
        getMultimodal: (providerId: string, modelId: string) => {
          calls.push([providerId, modelId]);
          return real.getMultimodal(providerId, modelId);
        },
      };
    },
  });

  try {
    await run({ calls, projectRoot, registry: result.registry });
  } finally {
    result.dispose();
    await rm(pilotHome, { recursive: true, force: true });
    await rm(projectBase, { recursive: true, force: true });
  }
}

const CONFIG_WITH_G9_V_MED = `schemaVersion: 1
agent:
  model: local/G9-V-Med
model:
  providers:
    local:
      protocol: openai
      url: http://127.0.0.1:1/v1
      apiKey: EMPTY
      models:
        G9-V-Med:
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsParallelToolCalls: true
            supportsJsonSchema: true
            supportsSystemPrompt: true
            maxContextTokens: 8192
            maxOutputTokens: 2048
          multimodal:
            input: [text, image]
            maxImagesPerRequest: 8
            supportedImageMimeTypes: [image/png]
telemetry:
  enabled: false
`;

const CONFIG_WITHOUT_G9_V_MED = `schemaVersion: 1
agent:
  model: openai/gpt-agent
model:
  providers:
    openai:
      protocol: openai
      url: http://127.0.0.1:1/v1
      apiKey: EMPTY
      models:
        gpt-agent:
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsParallelToolCalls: true
            supportsJsonSchema: true
            supportsSystemPrompt: true
            maxContextTokens: 8192
            maxOutputTokens: 2048
          multimodal:
            input: [text, image]
            maxImagesPerRequest: 8
            supportedImageMimeTypes: [image/png]
telemetry:
  enabled: false
`;

test("createTraumaRunner picks local/G9-V-Med when it is configured (real assembly, not a copy)", async () => {
  await withTraumaRunnerGateway("present", CONFIG_WITH_G9_V_MED, async ({ calls, projectRoot, registry }) => {
    const runner = await registry.createTraumaRunner(projectRoot, "sess-present");
    assert.equal(typeof runner.runTurn, "function");
    // Only the pinned provider/model was probed — it resolved, so no
    // fallback probe against the agent's model selection happened.
    assert.deepEqual(calls, [["local", "G9-V-Med"]]);
  });
});

test("createTraumaRunner falls back to the agent model when local/G9-V-Med is absent (real assembly, not a copy)", async () => {
  await withTraumaRunnerGateway("absent", CONFIG_WITHOUT_G9_V_MED, async ({ calls, projectRoot, registry }) => {
    const runner = await registry.createTraumaRunner(projectRoot, "sess-absent");
    assert.equal(typeof runner.runTurn, "function");
    // First probe (pinned local/G9-V-Med) fails, so createTraumaRunner
    // falls back to a second probe against the agent's configured model.
    assert.deepEqual(calls, [
      ["local", "G9-V-Med"],
      ["openai", "gpt-agent"],
    ]);
  });
});
