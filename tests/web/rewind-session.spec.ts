// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { rewindWebSession, RewindSessionError } from "../../src/web/server/rewindSession.js";

const FIXED_NOW = () => new Date("2026-09-21T08:00:00.000Z");

async function makeFixture(prefix) {
    const projectRoot = await mkdtemp(join(tmpdir(), `${prefix}-project-`));
    const pilotHome = await mkdtemp(join(tmpdir(), `${prefix}-home-`));
    return { projectRoot, pilotHome };
}

async function writeTwoTurns(storage, sessionKey) {
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [
        { role: "user", content: [{ type: "text", text: "第一问" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
        role: "assistant",
        content: [{ type: "text", text: "第一答" }],
    });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-2", [
        { role: "user", content: [{ type: "text", text: "第二问" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-2", {
        role: "assistant",
        content: [{ type: "text", text: "第二答" }],
    });
}

function findAcceptedInput(entries, turnId) {
    return entries.find((entry) => entry.type === "accepted_input" && entry.turnId === turnId);
}

test("rewind removes the last user turn in place and writes a backup", async () => {
    const { projectRoot, pilotHome } = await makeFixture("pilotdeck-rewind-happy");
    try {
        const sessionKey = "web:s_rewind_happy";
        const storage = createAgentProjectSessionStorage({
            projectRoot,
            pilotHome,
            sessionId: sessionKey,
            now: FIXED_NOW,
        });
        await writeTwoTurns(storage, sessionKey);

        const before = await readTranscript(storage.transcriptPath);
        const target = findAcceptedInput(before.entries, "turn-2");
        assert.ok(target);

        const result = await rewindWebSession(
            { sessionKey, fromEntryId: target.entryId },
            { projectRoot, pilotHome, now: FIXED_NOW },
        );
        assert.equal(result.removedTurnId, "turn-2");
        assert.equal(result.removedText, "第二问");
        assert.equal(result.removedEntryCount, 2);
        assert.equal(result.removedFromSequence, target.sequence);
        assert.equal(result.removedAtIso, "2026-09-21T08:00:00.000Z");

        const after = await readTranscript(storage.transcriptPath);
        assert.equal(after.entries.length, before.entries.length - 2);
        assert.ok(after.entries.every((entry) => entry.sequence < target.sequence));
        assert.equal(findAcceptedInput(after.entries, "turn-2"), undefined);
        assert.ok(findAcceptedInput(after.entries, "turn-1"));

        // The pre-rewind safety copy preserves the full original transcript.
        const backupPath = storage.transcriptPath.replace(/\.jsonl$/, ".pre-rewind.jsonl");
        await access(backupPath);
        const backup = await readTranscript(backupPath);
        assert.equal(backup.entries.length, before.entries.length);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(pilotHome, { recursive: true, force: true });
    }
});

test("rewind rejects a turn that is not the last user turn", async () => {
    const { projectRoot, pilotHome } = await makeFixture("pilotdeck-rewind-notlast");
    try {
        const sessionKey = "web:s_rewind_notlast";
        const storage = createAgentProjectSessionStorage({
            projectRoot,
            pilotHome,
            sessionId: sessionKey,
            now: FIXED_NOW,
        });
        await writeTwoTurns(storage, sessionKey);

        const { entries } = await readTranscript(storage.transcriptPath);
        const earlier = findAcceptedInput(entries, "turn-1");
        assert.ok(earlier);

        await assert.rejects(
            rewindWebSession(
                { sessionKey, fromEntryId: earlier.entryId },
                { projectRoot, pilotHome, now: FIXED_NOW },
            ),
            (error) => error instanceof RewindSessionError && error.code === "rewind_not_last_turn",
        );

        // The transcript must be untouched after a refused rewind.
        const after = await readTranscript(storage.transcriptPath);
        assert.equal(after.entries.length, entries.length);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(pilotHome, { recursive: true, force: true });
    }
});

test("rewind rejects unknown entry ids and non-user entries", async () => {
    const { projectRoot, pilotHome } = await makeFixture("pilotdeck-rewind-target");
    try {
        const sessionKey = "web:s_rewind_target";
        const storage = createAgentProjectSessionStorage({
            projectRoot,
            pilotHome,
            sessionId: sessionKey,
            now: FIXED_NOW,
        });
        await writeTwoTurns(storage, sessionKey);

        await assert.rejects(
            rewindWebSession(
                { sessionKey, fromEntryId: "no-such-entry" },
                { projectRoot, pilotHome, now: FIXED_NOW },
            ),
            (error) => error instanceof RewindSessionError && error.code === "rewind_entry_not_found",
        );

        const { entries } = await readTranscript(storage.transcriptPath);
        const assistantEntry = entries.find((entry) => entry.type === "assistant_message" || entry.type === "durable_message");
        assert.ok(assistantEntry);
        await assert.rejects(
            rewindWebSession(
                { sessionKey, fromEntryId: assistantEntry.entryId },
                { projectRoot, pilotHome, now: FIXED_NOW },
            ),
            (error) => error instanceof RewindSessionError && error.code === "rewind_not_accepted_input",
        );
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(pilotHome, { recursive: true, force: true });
    }
});

test("rewind rejects turns with non-text input content", async () => {
    const { projectRoot, pilotHome } = await makeFixture("pilotdeck-rewind-media");
    try {
        const sessionKey = "web:s_rewind_media";
        const storage = createAgentProjectSessionStorage({
            projectRoot,
            pilotHome,
            sessionId: sessionKey,
            now: FIXED_NOW,
        });
        await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [
            {
                role: "user",
                content: [
                    { type: "text", text: "看看这张图" },
                    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
                ],
            },
        ]);

        const { entries } = await readTranscript(storage.transcriptPath);
        const target = findAcceptedInput(entries, "turn-1");
        assert.ok(target);

        await assert.rejects(
            rewindWebSession(
                { sessionKey, fromEntryId: target.entryId },
                { projectRoot, pilotHome, now: FIXED_NOW },
            ),
            (error) => error instanceof RewindSessionError && error.code === "rewind_unsupported_content",
        );
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(pilotHome, { recursive: true, force: true });
    }
});

test("rewind carries the newest session metadata past the truncation", async () => {
    const { projectRoot, pilotHome } = await makeFixture("pilotdeck-rewind-meta");
    try {
        const sessionKey = "web:s_rewind_meta";
        const storage = createAgentProjectSessionStorage({
            projectRoot,
            pilotHome,
            sessionId: sessionKey,
            now: FIXED_NOW,
        });
        await writeTwoTurns(storage, sessionKey);
        // Title written AFTER the last user turn — a naive truncation would
        // drop it and silently rename the session.
        await storage.transcript.recordSessionMetadata(sessionKey, "turn-2", {
            title: "腹痛鉴别诊断",
            lastPrompt: "第二问",
        });

        const before = await readTranscript(storage.transcriptPath);
        const target = findAcceptedInput(before.entries, "turn-2");
        assert.ok(target);

        await rewindWebSession(
            { sessionKey, fromEntryId: target.entryId },
            { projectRoot, pilotHome, now: FIXED_NOW },
        );

        const after = await readTranscript(storage.transcriptPath);
        const lastEntry = after.entries[after.entries.length - 1];
        assert.equal(lastEntry.type, "session_metadata");
        assert.equal(lastEntry.metadata.title, "腹痛鉴别诊断");
        assert.equal(lastEntry.metadata.updatedAt, "2026-09-21T08:00:00.000Z");
        const preserved = after.entries.slice(0, -1);
        const maxPreservedSequence = preserved.reduce((max, entry) => Math.max(max, entry.sequence), 0);
        assert.equal(lastEntry.sequence, maxPreservedSequence + 1);
        assert.ok(lastEntry.sequence < target.sequence + 2);
        assert.equal(findAcceptedInput(after.entries, "turn-2"), undefined);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(pilotHome, { recursive: true, force: true });
    }
});
