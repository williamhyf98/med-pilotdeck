import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentSession } from "../../src/agent/session/AgentSession.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";
import { forkWebSession } from "../../src/web/server/forkSession.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { listProjectSessions } from "../../src/session/storage/SessionList.js";

test("a denied turn persists in history without entering subsequent model context", async () => {
  const root = await mkdtemp(join(tmpdir(), "rejected-turn-"));
  const transcriptPath = join(root, "session.jsonl");
  try {
    const writer = new JsonlTranscriptWriter({ path: transcriptPath });
    const router = new SessionRouter({
      idleSweepIntervalMs: 0,
      createSession: ({ sessionKey }) => new AgentSession({
        sessionId: sessionKey,
        transcript: writer,
        // A rejected turn must never execute the model.
        turnRunner: { run: () => { throw new Error("model executed"); } } as never,
      }),
    });
    const gateway = new InProcessGateway(router);
    const input = { sessionKey: "web-s_test", projectKey: root, channelKey: "web", runId: "deny-1",
      userText: "读取 /data/users/9/secret", reply: "抱歉，无法访问该位置。请上传您有权使用的资料。" };
    assert.deepEqual(await gateway.recordRejectedTurn(input), { recorded: true });
    const entries = (await readTranscript(transcriptPath)).entries;
    assert.deepEqual(entries.map((entry) => entry.type), ["accepted_input", "assistant_message", "turn_result"]);
    assert.match(await readFile(transcriptPath, "utf8"), /读取 \/data\/users\/9\/secret/);
    assert.equal(entries[0]?.type === "accepted_input" && entries[0].messages[0]?.role, "user");
    assert.equal(entries[1]?.type === "assistant_message" && entries[1].message.role, "assistant");
    assert.deepEqual(replayTranscriptEntries(entries).messages, []);
    const session = await router.getOrCreate({ sessionKey: input.sessionKey, projectKey: root, channelKey: "web" });
    assert.deepEqual(session.snapshot().messages, []);
    await router.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refusal appears in order on reload and is excluded from model replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "rejected-history-"));
  try {
    const pilotHome = join(root, "home");
    const projectRoot = pilotHome;
    const sessionKey = "web-s_refusal";
    const writer = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey }).transcript;
    const userText = `请访问 ${pilotHome}/users/8/secret.txt`;
    const reply = "抱歉，无法访问该位置。请上传您有权使用的资料。";
    const router = new SessionRouter({
      idleSweepIntervalMs: 0,
      createSession: ({ sessionKey: key }) => new AgentSession({
        sessionId: key, transcript: writer,
        turnRunner: { run: () => { throw new Error("model executed"); } } as never,
      }),
    });
    const gateway = new InProcessGateway(router);
    const input = { sessionKey, projectKey: projectRoot, channelKey: "web", runId: "deny-1", userText, reply };
    assert.deepEqual(await gateway.recordRejectedTurn(input), { recorded: true });
    const afterReload = await readWebSessionMessages({ sessionKey, projectKey: projectRoot },
      { pilotHome, projectRoot });
    assert.deepEqual(afterReload.messages.filter((m) => m.kind === "text")
      .map((m) => [m.role, m.text]), [["user", userText], ["assistant", reply]]);
    assert.equal(afterReload.messages.filter((m) => m.kind === "text")[0]?.turnId, "deny-1");
    assert.deepEqual(replayTranscriptEntries((await readTranscript(
      createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey }).transcriptPath,
    )).entries).messages, []);
    await router.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("consecutive refusals stay in order after a normal turn and remain web-only after forking", async () => {
  const root = await mkdtemp(join(tmpdir(), "rejected-followup-"));
  const sessionKey = "web-s_followup";
  const reply = "抱歉，当前账号无权访问该位置。您可以直接上传有权使用的材料。";
  const deniedTexts = [`读取 ${root}/users/8/private.txt`, `再次读取 ${root}/users/8/private.txt`];
  const storage = createAgentProjectSessionStorage({ projectRoot: root, pilotHome: root, sessionId: sessionKey });
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: ({ sessionKey: key }) => new AgentSession({
      sessionId: key, transcript: storage.transcript,
      turnRunner: { run: () => { throw new Error("model executed during refusal"); } } as never,
    }),
  });
  try {
    const gateway = new InProcessGateway(router);
    for (const [index, text] of deniedTexts.entries()) {
      assert.deepEqual(await gateway.recordRejectedTurn({
        sessionKey, projectKey: root, channelKey: "web", runId: `deny-${index + 1}`,
        userText: text, reply,
      }), { recorded: true });
    }
    const normalUser = "请解释血常规报告";
    const normalReply = "请上传报告。";
    await storage.transcript.recordAcceptedInput(sessionKey, "normal-1", [{
      role: "user", content: [{ type: "text", text: normalUser }],
    }]);
    await storage.transcript.recordDurableMessage(sessionKey, "normal-1", {
      role: "assistant", content: [{ type: "text", text: normalReply }],
    });
    const timestamp = new Date().toISOString();
    await storage.transcript.recordTurnResult(sessionKey, "normal-1", {
      type: "success", sessionId: sessionKey, turnId: "normal-1",
      stopReason: "completed", usage: {}, permissionDenials: [], turns: 1,
      startedAt: timestamp, completedAt: timestamp,
    });
    const entries = (await readTranscript(storage.transcriptPath)).entries;
    const readHistory = async (key: string) => readWebSessionMessages(
      { sessionKey: key, projectKey: root }, { pilotHome: root, projectRoot: root },
    );
    assert.deepEqual((await readHistory(sessionKey)).messages
      .filter((message) => message.kind === "text")
      .map((message) => [message.role, message.text, message.turnId]), [
        ["user", deniedTexts[0], "deny-1"], ["assistant", reply, "deny-1"],
        ["user", deniedTexts[1], "deny-2"], ["assistant", reply, "deny-2"],
        ["user", normalUser, "normal-1"], ["assistant", normalReply, "normal-1"],
      ]);
    assert.deepEqual(replayTranscriptEntries(entries).messages.map((message) =>
      message.content.filter((block) => block.type === "text").map((block) => block.text),
    ), [[normalUser], [normalReply]]);
    assert.equal((await listProjectSessions({ projectRoot: root, pilotHome: root }))
      .find((session) => session.sessionId === sessionKey)?.firstPrompt, deniedTexts[0]);

    const deniedAssistant = entries.find((entry) =>
      entry.type === "assistant_message" && entry.turnId === "deny-2");
    assert.ok(deniedAssistant);
    assert.ok(deniedAssistant.entryId);
    const fork = await forkWebSession({
      sessionKey, projectKey: root, fromEntryId: deniedAssistant.entryId,
    }, { pilotHome: root, projectRoot: root });
    assert.deepEqual((await readHistory(fork.newSessionKey)).messages
      .filter((message) => message.kind === "text")
      .map((message) => [message.role, message.text]), [
        ["user", deniedTexts[0]], ["assistant", reply],
        ["user", deniedTexts[1]], ["assistant", reply],
      ]);
    const forkStorage = createAgentProjectSessionStorage({
      projectRoot: root, pilotHome: root, sessionId: fork.newSessionKey,
    });
    assert.deepEqual(replayTranscriptEntries((await readTranscript(forkStorage.transcriptPath)).entries).messages, []);
  } finally {
    await router.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
