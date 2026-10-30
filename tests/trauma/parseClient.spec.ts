import assert from "node:assert/strict";
import test from "node:test";

import {
  TRAUMA_PARSE_TOOL_NAME,
  createMcpTraumaParseClient,
  normalizeParsePayload,
} from "../../src/trauma/attachments/parseClient.js";

const attachment = { path: "/inbox/b1/ct.dcm", name: "ct.dcm" };

test("normalizeParsePayload keeps summary and png paths", () => {
  const parsed = normalizeParsePayload(attachment, {
    ok: true,
    summary: "胸部 CT，层厚 5mm。",
    png_paths: ["/inbox/b1/ct-0.png", "/inbox/b1/ct-1.png"],
    warnings: [],
  });
  assert.deepEqual(parsed, {
    name: "ct.dcm",
    path: "/inbox/b1/ct.dcm",
    summary: "胸部 CT，层厚 5mm。",
    pngPaths: ["/inbox/b1/ct-0.png", "/inbox/b1/ct-1.png"],
    ok: true,
    warnings: [],
  });
});

test("normalizeParsePayload falls back to report when summary is absent", () => {
  const parsed = normalizeParsePayload(attachment, { ok: true, report: "报告正文" });
  assert.equal(parsed.summary, "报告正文");
  assert.deepEqual(parsed.pngPaths, []);
});

test("normalizeParsePayload marks a non-object payload as failed instead of throwing", () => {
  const parsed = normalizeParsePayload(attachment, "not-json-object");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.summary, "");
  assert.ok(parsed.warnings[0]?.includes("ct.dcm"));
});

test("normalizeParsePayload drops non-string png paths and warnings", () => {
  const parsed = normalizeParsePayload(attachment, {
    ok: true,
    summary: "s",
    png_paths: ["/a.png", 42, null],
    warnings: ["w1", 7],
  });
  assert.deepEqual(parsed.pngPaths, ["/a.png"]);
  assert.deepEqual(parsed.warnings, ["w1"]);
});

test("createMcpTraumaParseClient pins skip_vlm and continuation_mode", async () => {
  const calls: Array<{ name: string; input: any }> = [];
  const client = createMcpTraumaParseClient(async (name, input) => {
    calls.push({ name, input });
    return JSON.stringify({ ok: true, summary: "s", png_paths: [] });
  });
  const parsed = await client.parse({ attachment });
  assert.equal(calls[0]?.name, TRAUMA_PARSE_TOOL_NAME);
  assert.equal(calls[0]?.input.path, "/inbox/b1/ct.dcm");
  assert.equal(calls[0]?.input.skip_vlm, true);
  assert.equal(calls[0]?.input.continuation_mode, "material");
  assert.equal(parsed.summary, "s");
});

test("parse surfaces a tool failure as a non-ok attachment instead of throwing", async () => {
  const client = createMcpTraumaParseClient(async () => {
    throw new Error("tool exploded");
  });
  const parsed = await client.parse({ attachment });
  assert.equal(parsed.ok, false);
  assert.ok(parsed.warnings.some((item) => item.includes("tool exploded")));
});
