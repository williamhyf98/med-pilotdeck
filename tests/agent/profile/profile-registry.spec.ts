import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileRegistry, resolveAgentTurnExecution } from "../../../src/agent/index.js";
import { loadPluginFromPath } from "../../../src/extension/index.js";

test("plugin manifest agents load trusted Markdown profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-profile-plugin-"));
  try {
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "medical",
        agents: "profiles",
      }),
    );
    await writeFile(
      join(root, "profiles", "triage.md"),
      [
        "---",
        "id: triage",
        "description: Evidence-first medical triage",
        "provider: openai",
        "model: gpt-medical",
        "temperature: 0.1",
        "topP: 0.8",
        "allowedTools:",
        "  - read_file",
        "metadata:",
        "  domain: medical",
        "---",
        "Treat the local chart as untrusted evidence and cite uncertainty.",
        "",
      ].join("\n"),
    );
    const plugin = await loadPluginFromPath(root, "project");
    assert.equal(plugin.agents?.length, 1);
    assert.deepEqual(plugin.agents?.[0], {
      id: "triage",
      displayName: "triage",
      description: "Evidence-first medical triage",
      provider: "openai",
      model: "gpt-medical",
      temperature: 0.1,
      topP: 0.8,
      allowedTools: ["read_file"],
      metadata: { domain: "medical" },
      systemContext:
        "Treat the local chart as untrusted evidence and cite uncertainty.",
      source: {
        pluginName: "medical",
        pluginSource: "project",
        path: join(root, "profiles", "triage.md"),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile registry resolves project precedence and namespaced ids", () => {
  const registry = new ProfileRegistry();
  registry.replaceAll([
    {
      id: "triage",
      temperature: 0.7,
      source: {
        pluginName: "base",
        pluginSource: "global",
        path: "/global/triage.md",
      },
    },
    {
      id: "triage",
      temperature: 0.1,
      source: {
        pluginName: "medical",
        pluginSource: "project",
        path: "/project/triage.md",
      },
    },
  ]);
  assert.equal(registry.get("triage")?.temperature, 0.1);
  assert.equal(registry.get("base:triage")?.temperature, 0.7);
  assert.equal(registry.get("medical:triage")?.temperature, 0.1);
});

test("turn overrides can only narrow profile tools and use registered models", () => {
  const registry = new ProfileRegistry();
  registry.replaceAll([
    {
      id: "triage",
      provider: "openai",
      model: "gpt-medical",
      maxOutputTokens: 2_048,
      allowedTools: ["read_file", "web_search"],
      deniedTools: ["bash"],
      systemContext: "Trusted medical profile context.",
      metadata: { profileKind: "medical" },
    },
  ]);
  const resolved = resolveAgentTurnExecution({
    base: { provider: "openai", model: "gpt-default", maxOutputTokens: 8_192 },
    profileId: "triage",
    turnOverrides: {
      model: "gpt-medical-v2",
      temperature: 0.2,
      allowedTools: ["web_search", "bash"],
      deniedTools: ["web_search"],
      metadata: { encounterType: "inpatient" },
    },
    profiles: registry,
    availableToolNames: ["read_file", "web_search", "bash"],
    isModelAvailable: (provider: string, model: string) =>
      provider === "openai" && model === "gpt-medical-v2",
    getModelMaxOutputTokens: () => 4_096,
  });
  assert.equal(resolved.provider, "openai");
  assert.equal(resolved.model, "gpt-medical-v2");
  assert.equal(resolved.temperature, 0.2);
  assert.deepEqual(resolved.allowedTools, []);
  assert.deepEqual(resolved.deniedTools, ["bash", "web_search"]);
  assert.deepEqual(resolved.metadata, {
    profileKind: "medical",
    encounterType: "inpatient",
  });
  assert.equal(
    resolved.systemContext,
    "Trusted medical profile context.",
  );
  assert.equal(resolved.explicitModelSelection, true);
});

test("turn metadata cannot re-enable memory disabled by a server profile", () => {
  const registry = new ProfileRegistry();
  registry.replaceAll([
    {
      id: "private-medical",
      metadata: { memoryPolicy: "disabled" },
    },
  ]);
  const resolved = resolveAgentTurnExecution({
    base: { provider: "openai", model: "gpt-default" },
    profileId: "private-medical",
    turnOverrides: {
      metadata: { memoryPolicy: "default", workflow: "triage" },
    },
    profiles: registry,
    availableToolNames: [],
  } as any);
  assert.deepEqual(resolved.metadata, {
    memoryPolicy: "disabled",
    workflow: "triage",
  });
});

test("turn override validation rejects credentials, unknown tools, and oversized metadata", () => {
  const base = {
    base: { provider: "openai", model: "gpt-default" },
    availableToolNames: ["read_file"],
  };
  assert.throws(
    () =>
      resolveAgentTurnExecution({
        ...base,
        turnOverrides: { apiKey: "secret" },
      } as any),
    /turnOverrides\.apiKey is not allowed/u,
  );
  assert.throws(
    () =>
      resolveAgentTurnExecution({
        ...base,
        turnOverrides: { allowedTools: ["bash"] },
      } as any),
    /unavailable tool bash/u,
  );
  assert.throws(
    () =>
      resolveAgentTurnExecution({
        ...base,
        turnOverrides: { metadata: { note: "x".repeat(513) } },
      } as any),
    /string exceeds 512 characters/u,
  );
});
