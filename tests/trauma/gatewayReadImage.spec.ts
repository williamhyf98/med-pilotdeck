// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTraumaAttachmentPreviewImage } from "../../src/cli/createLocalGateway.js";

/**
 * Task 9 fix F5: `readImage` must honour the contract declared at
 * `InterpretationStationDeps.readImage` in src/trauma/stations/interpreter.ts
 * ("读取预览 PNG 并转成 base64；读不到时返回 null", typed `Promise<TraumaImageInput | null>")
 * — return null on a missing/unreadable file instead of throwing. It was
 * previously only harmless because `collectImages` wrapped the call in
 * `.catch(() => null)`.
 */

test("readTraumaAttachmentPreviewImage returns bare base64 (no data: prefix) for an existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trauma-read-image-"));
  const filePath = join(dir, "preview.png");
  try {
    await writeFile(filePath, Buffer.from("fake-png-bytes"));

    const result = await readTraumaAttachmentPreviewImage(filePath);

    assert.ok(result);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.data, Buffer.from("fake-png-bytes").toString("base64"));
    assert.equal(result.data.startsWith("data:"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTraumaAttachmentPreviewImage returns null instead of throwing for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trauma-read-image-"));
  const missingPath = join(dir, "does-not-exist.png");
  try {
    const result = await readTraumaAttachmentPreviewImage(missingPath);
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
