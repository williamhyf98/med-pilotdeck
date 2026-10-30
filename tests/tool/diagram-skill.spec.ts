import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const diagramScript = resolve("skills/diagram-maker/scripts/diagram.sh");

function runDiagram(args: string[]) {
  return spawnSync("bash", [diagramScript, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

test("diagram skill creates an audited SVG from declarative Mermaid", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-diagram-test-"));
  try {
    const markdown = join(root, "flow.mmd");
    const output = join(root, "救治流程.svg");
    await writeFile(markdown, [
      "flowchart LR",
      "  intake[分诊] --> assess[评估]",
      "  assess -->|危重| rescue[抢救]",
      "  assess -->|稳定| transfer[后送]",
    ].join("\n"));

    const result = runDiagram([
      "make",
      "--title", "救治流程",
      "--markdown", markdown,
      "--out", output,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "ok");
    assert.equal(payload.output, await realpath(output));
    assert.equal(payload.nodes, 4);
    assert.equal(payload.edges, 3);
    const svg = await readFile(output, "utf8");
    assert.match(svg, /<svg\b/u);
    assert.match(svg, />分诊</u);
    assert.match(svg, />危重</u);
    assert.doesNotMatch(svg, /<script\b|javascript:/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagram skill renders decision nodes, dash edge labels, and wrapped labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-diagram-decision-"));
  try {
    const markdown = join(root, "flow.mmd");
    const output = join(root, "止血流程.svg");
    await writeFile(markdown, [
      "flowchart TB",
      "  A[发现出血] --> B{是否为外出血?}",
      "  B -- 否 --> C[考虑内出血或其他损伤",
      "迅速评估并后送]",
      "  B -- 是 --> D[直接压迫止血]",
      "  D -.-> E[加压包扎<br/>持续观察]",
    ].join("\n"));

    const result = runDiagram(["make", "--markdown", markdown, "--out", output]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "ok");
    assert.equal(payload.nodes, 5);
    assert.equal(payload.edges, 4);

    const svg = await readFile(output, "utf8");
    // The decision node is a rhombus path rather than a rounded rect.
    assert.match(svg, /<path d="M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+ Z"/u);
    assert.match(svg, />是否为外出血\?</u);
    assert.match(svg, />否</u);
    assert.match(svg, />是</u);
    assert.match(svg, /stroke-dasharray/u);
    assert.doesNotMatch(svg, /&lt;br/u);

    // Labels split across physical lines or by <br/> stay one node; wrapping is layout-only.
    const renderedText = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/gu)]
      .map((match) => match[1])
      .join("");
    assert.ok(
      renderedText.includes("考虑内出血或其他损伤 迅速评估并后送"),
      `expected the joined label in: ${renderedText}`,
    );
    assert.ok(renderedText.includes("加压包扎 持续观察"), renderedText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagram skill rejects unsupported Mermaid instead of emitting fallback code", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-diagram-invalid-"));
  try {
    const markdown = join(root, "sequence.mmd");
    const output = join(root, "sequence.svg");
    await writeFile(markdown, "sequenceDiagram\n  A->>B: hello\n");
    const result = runDiagram(["make", "--markdown", markdown, "--out", output]);
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "error");
    assert.equal(payload.code, "invalid-diagram-input");
    assert.match(payload.error, /flowchart/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagram skill refuses to overwrite an existing output without force", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-diagram-overwrite-"));
  try {
    const output = join(root, "flow.svg");
    await writeFile(output, "original");
    const result = runDiagram(["make", "--body", "输入 → 输出", "--out", output]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /--force/u);
    assert.equal(await readFile(output, "utf8"), "original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
