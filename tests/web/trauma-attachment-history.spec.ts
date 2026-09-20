// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTraumaUserTranscriptContent } from "../../src/cli/createLocalGateway.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

test("history replay restores trauma user input attachments through common image blocks and path note", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-trauma-attachment-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pilotdeck-trauma-attachment-workspace-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-trauma-attachment-home-"));
  try {
    const sessionKey = "web:s_trauma_attachment_restore";
    const inboxDir = join(workspaceRoot, "inbox", "web_s_trauma_attachment_restore");
    await mkdir(inboxDir, { recursive: true });
    const imagePath = join(inboxDir, "伤情照片.png");
    const pdfPath = join(workspaceRoot, "inbox", "web_s_trauma_attachment_restore", "检查报告.pdf");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    await writeFile(pdfPath, Buffer.from("%PDF-1.4\n"));

    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-09-16T10:00:00.000Z"),
    });
    const content = await buildTraumaUserTranscriptContent(
      "左大腿爆炸伤，上传影像和检查报告。",
      [
        { name: "伤情照片.png", path: imagePath },
        { name: "检查报告.pdf", path: pdfPath },
      ],
      workspaceRoot,
    );
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
      role: "user",
      content,
      metadata: { purpose: "trauma_user_input" },
    });
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "已生成处置建议。" }],
    });

    const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    const userMessage = replay.messages.find((item) => item.kind === "text" && item.role === "user");

    assert.ok(userMessage, "expected replayed user message");
    assert.match(userMessage.text ?? "", /^左大腿爆炸伤，上传影像和检查报告。/);
    assert.match(userMessage.text ?? "", /\[Files attached by user and available for reading in the project:\]/);
    assert.match(userMessage.text ?? "", /检查报告\.pdf/);
    assert.equal(userMessage.images?.length, 1);
    assert.match(userMessage.images?.[0]?.data ?? "", /^data:image\/png;base64,/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
