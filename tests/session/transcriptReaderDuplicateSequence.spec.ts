import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";

test("legacy trauma transcripts with reset sequences retain chronological turn order", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-transcript-order-"));
  try {
    const path = join(root, "session.jsonl");
    const entries = [
      { type: "durable_message", sessionId: "s", turnId: "t1", sequence: 1, createdAt: "2026-09-04T02:20:17.112Z", message: { role: "user", content: [] } },
      { type: "assistant_message", sessionId: "s", turnId: "t1", sequence: 2, createdAt: "2026-09-04T02:20:17.114Z", message: { role: "assistant", content: [] } },
      { type: "durable_message", sessionId: "s", turnId: "t2", sequence: 1, createdAt: "2026-09-04T02:23:42.075Z", message: { role: "user", content: [] } },
      { type: "assistant_message", sessionId: "s", turnId: "t2", sequence: 2, createdAt: "2026-09-04T02:23:42.076Z", message: { role: "assistant", content: [] } },
    ];
    await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const result = await readTranscript(path);

    assert.deepEqual(result.entries.map((entry) => entry.turnId), ["t1", "t1", "t2", "t2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
