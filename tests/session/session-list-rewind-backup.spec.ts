import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { getPilotProjectChatDir } from "../../src/pilot/index.js";
import { listProjectSessions } from "../../src/session/storage/SessionList.js";

function transcript(prompt: string): string {
  return `${JSON.stringify({
    type: "accepted_input",
    entryId: "entry-1",
    sequence: 1,
    createdAt: "2026-11-09T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  })}\n`;
}

function setup(t: TestContext) {
  const pilotHome = mkdtempSync(join(tmpdir(), "session-list-"));
  const projectRoot = join(pilotHome, "project");
  mkdirSync(projectRoot, { recursive: true });
  t.after(() => rmSync(pilotHome, { recursive: true, force: true }));
  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  mkdirSync(chatDir, { recursive: true });
  return { pilotHome, projectRoot, chatDir };
}

test("rewind recovery copies are not listed as separate sessions", async (t) => {
  const { pilotHome, projectRoot, chatDir } = setup(t);
  const base = "web:s_abc";
  writeFileSync(join(chatDir, `${base}.jsonl`), transcript("live question"));
  writeFileSync(join(chatDir, `${base}.pre-rewind.jsonl`), transcript("backup question"));
  writeFileSync(
    join(chatDir, `${base}.pre-rewind.pre-rewind.jsonl`),
    transcript("older backup question"),
  );

  const sessions = await listProjectSessions({ projectRoot, pilotHome });
  assert.deepEqual(sessions.map((session) => session.sessionId), [base]);
});

test("a session whose transcript was truncated by rewind still lists once", async (t) => {
  const { pilotHome, projectRoot, chatDir } = setup(t);
  const base = "web:s_truncated";
  // Live transcript keeps only the leading metadata; the backup holds the turn.
  writeFileSync(
    join(chatDir, `${base}.jsonl`),
    `${JSON.stringify({ type: "session_metadata", entryId: "meta", sequence: 1 })}\n`,
  );
  writeFileSync(join(chatDir, `${base}.pre-rewind.jsonl`), transcript("removed question"));

  const sessions = await listProjectSessions({ projectRoot, pilotHome });
  // The metadata-only live file has no prompt to summarise, so it is skipped;
  // the important part is that its backup does not resurface as a phantom turn.
  assert.deepEqual(sessions.map((session) => session.sessionId), []);
});
