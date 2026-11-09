import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeToolArtifacts } from "../../src/session/artifacts/artifactContract.js";
import { FileArtifactCollector } from "../../src/session/artifacts/FileArtifactCollector.js";

function context(cwd: string): any {
  return {
    sessionId: "session",
    turnId: "turn",
    cwd,
    taskRoot: cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

test("normalizes final and intermediate artifacts to task-relative paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-contract-"));
  try {
    await mkdir(join(root, "exports"), { recursive: true });
    await mkdir(join(root, "scratch", "qa"), { recursive: true });
    await writeFile(join(root, "exports", "report.pdf"), "%PDF");
    await writeFile(join(root, "scratch", "qa", "audit.json"), "{}");

    const artifacts = await normalizeToolArtifacts([
      {
        path: "exports/report.pdf",
        role: "final",
        mimeType: "application/pdf",
        description: "最终报告",
      },
      {
        path: "scratch/qa/audit.json",
        role: "intermediate",
        mimeType: "application/json",
      },
    ], context(root));

    assert.deepEqual(artifacts, [
      {
        path: "exports/report.pdf",
        role: "final",
        mimeType: "application/pdf",
        description: "最终报告",
      },
      {
        path: "scratch/qa/audit.json",
        role: "intermediate",
        mimeType: "application/json",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects absolute, inbox, internal final, missing, and duplicate-conflict artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-contract-deny-"));
  try {
    await mkdir(join(root, "exports", ".pdf-qa"), { recursive: true });
    await mkdir(join(root, "inbox"), { recursive: true });
    await writeFile(join(root, "exports", "report.pdf"), "%PDF");
    await writeFile(join(root, "exports", ".pdf-qa", "audit.json"), "{}");
    await writeFile(join(root, "inbox", "input.csv"), "a,b");

    const cases: Array<[string, unknown]> = [
      ["absolute path", [{ path: join(root, "exports", "report.pdf"), role: "final" }]],
      ["inbox final", [{ path: "inbox/input.csv", role: "final" }]],
      ["internal final", [{ path: "exports/.pdf-qa/audit.json", role: "final" }]],
      ["missing file", [{ path: "exports/missing.pdf", role: "final" }]],
      ["duplicate role conflict", [
        { path: "exports/report.pdf", role: "final" },
        { path: "exports/report.pdf", role: "intermediate" },
      ]],
    ];

    for (const [label, value] of cases) {
      await assert.rejects(
        normalizeToolArtifacts(value, context(root)),
        /invalid artifact|relative task path|final artifact|intermediate artifact|does not exist|not available|duplicate/u,
        label,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deduplicates identical structured artifact declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-contract-dedupe-"));
  try {
    await mkdir(join(root, "exports"), { recursive: true });
    await writeFile(join(root, "exports", "report.pdf"), "%PDF");
    const artifacts = await normalizeToolArtifacts([
      { path: "exports/report.pdf", role: "final" },
      { path: "./exports/report.pdf", role: "final" },
    ], context(root));
    assert.deepEqual(artifacts, [{ path: "exports/report.pdf", role: "final" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collector uses explicit final artifacts and hides intermediate scratch files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-collector-contract-"));
  try {
    await mkdir(join(root, "exports"), { recursive: true });
    await mkdir(join(root, "scratch"), { recursive: true });
    await writeFile(join(root, "exports", "report.pdf"), "%PDF");
    await writeFile(join(root, "scratch", "audit.json"), "{}");

    const collector = await FileArtifactCollector.start({
      cwd: root,
      allowWorkspaceDiff: false,
    });
    collector.observeToolResult({
      type: "success",
      toolCallId: "call-1",
      toolName: "artifact_tool",
      content: [],
      artifacts: [
        {
          path: "exports/report.pdf",
          role: "final",
          description: "最终报告",
        },
        {
          path: "scratch/audit.json",
          role: "intermediate",
          description: "内部检查",
        },
      ],
      startedAt: "2026-11-06T00:00:00.000Z",
      completedAt: "2026-11-06T00:00:01.000Z",
    });

    const artifacts = await collector.finish("complete");
    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["exports/report.pdf"]);
    assert.equal(artifacts[0]?.description, "最终报告");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
