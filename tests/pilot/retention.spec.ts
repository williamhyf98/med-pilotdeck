// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRetention, assertInsideHome } from "../../src/pilot/retention.js";
import { DEFAULT_RETENTION } from "../../src/pilot/config/parseMultiUserConfig.js";

const DAY = 86_400_000;
function home() {
  const h = mkdtempSync(join(tmpdir(), "pd-ret-"));
  for (const d of ["logs", ".tmp/chat-attachments/old", ".tmp/chat-attachments/new", "archives/projects"]) mkdirSync(join(h, d), { recursive: true });
  return h;
}
const old = (p, days) => { const t = (Date.now() - days * DAY) / 1000; utimesSync(p, t, t); };

test("rotates oversized logs and keeps logKeep generations", async () => {
  const h = home();
  writeFileSync(join(h, "logs/trauma-agent.jsonl"), "x".repeat(2048));
  for (let i = 1; i <= 5; i += 1) writeFileSync(join(h, `logs/trauma-agent.jsonl.${i}`), `gen${i}`);
  const r = await runRetention({ pilotHome: h, config: { ...DEFAULT_RETENTION, logMaxBytes: 1024, logKeep: 5 } });
  assert.deepEqual(r.rotatedLogs, ["trauma-agent.jsonl"]);
  assert.ok(!existsSync(join(h, "logs/trauma-agent.jsonl")) || readdirSync(join(h, "logs")).length <= 6);
  assert.ok(existsSync(join(h, "logs/trauma-agent.jsonl.1")));
  assert.ok(!existsSync(join(h, "logs/trauma-agent.jsonl.6")));
  rmSync(h, { recursive: true, force: true });
});

test("removes attachments older than attachmentMaxAgeDays and prunes empty dirs", async () => {
  const h = home();
  writeFileSync(join(h, ".tmp/chat-attachments/old/a.png"), "a"); old(join(h, ".tmp/chat-attachments/old/a.png"), 8);
  writeFileSync(join(h, ".tmp/chat-attachments/new/b.png"), "b");
  const r = await runRetention({ pilotHome: h, config: DEFAULT_RETENTION });
  assert.equal(r.removedAttachments, 1);
  assert.ok(!existsSync(join(h, ".tmp/chat-attachments/old")));
  assert.ok(existsSync(join(h, ".tmp/chat-attachments/new/b.png")));
  rmSync(h, { recursive: true, force: true });
});

test("removes project archives older than archiveMaxAgeDays by their name timestamp", async () => {
  const h = home();
  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const oldDir = join(h, "archives/projects", `general_med-x-${fmt(new Date(Date.now() - 40 * DAY))}`);
  const newDir = join(h, "archives/projects", `general_med-y-${fmt(new Date(Date.now() - 2 * DAY))}`);
  mkdirSync(oldDir); mkdirSync(newDir); mkdirSync(join(h, "archives/projects/not-a-timestamp"));
  const r = await runRetention({ pilotHome: h, config: DEFAULT_RETENTION });
  assert.equal(r.removedArchives.length, 1);
  assert.ok(!existsSync(oldDir)); assert.ok(existsSync(newDir)); assert.ok(existsSync(join(h, "archives/projects/not-a-timestamp")));
  rmSync(h, { recursive: true, force: true });
});

test("never deletes through a symlink that escapes the home", async () => {
  const h = home(); const outside = mkdtempSync(join(tmpdir(), "pd-out-"));
  writeFileSync(join(outside, "secret.txt"), "s"); old(join(outside, "secret.txt"), 30);
  symlinkSync(outside, join(h, ".tmp/chat-attachments/escape"));
  await runRetention({ pilotHome: h, config: DEFAULT_RETENTION });
  assert.ok(existsSync(join(outside, "secret.txt")));
  assert.throws(() => assertInsideHome(join(h, ".tmp/chat-attachments/escape/secret.txt"), h), /outside/);
  rmSync(h, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
});
