// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
    createAgentProjectSessionStorage,
    sanitizeSessionIdForPath,
} from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

function buildRagPayload() {
    const chunkText = "束带止血：在肢体大出血且直接压迫无效时，应立即使用旋压式止血带。".repeat(40);
    return JSON.stringify({
        status: "ok",
        query: "止血带 使用时机",
        generation_owner: "pilotdeck",
        chunks: [
            {
                citation_index: 1,
                display_label: "战术战伤救治手册 · 止血章节",
                chunk_id: "chunk-0001",
                rank: 1,
                score: 0.92,
                text: chunkText,
            },
            {
                citation_index: 2,
                display_label: "68W 高级战场急救技能训练手册",
                chunk_id: "chunk-0002",
                rank: 2,
                score: 0.88,
                text: chunkText,
            },
        ],
    });
}

async function recordRagReferenceSession(input) {
    const { storage, sessionKey, projectRoot, toolName, persistedPath } = input;
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "rag-1",
            name: toolName,
            input: { query: "止血带 使用时机" },
        }],
    });
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
        role: "user",
        content: [{
            type: "tool_result_reference",
            toolCallId: "rag-1",
            path: persistedPath,
            originalBytes: 123456,
            preview: '{"status": "ok", "chunks": [ ... [preview truncated] ...',
            hasMore: true,
            mimeType: "application/json",
            reason: "tool_result_too_large",
        }],
    });
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
        role: "assistant",
        content: [{ type: "text", text: "使用旋压式止血带 [1]。" }],
    });
    return readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome: input.pilotHome });
}

test("history replay inlines persisted RAG payloads so citations keep chunk bodies", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-rag-citation-project-"));
    const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-rag-citation-home-"));
    try {
        const sessionKey = "web:s_rag_citation_history";
        const storage = createAgentProjectSessionStorage({
            projectRoot,
            pilotHome,
            sessionId: sessionKey,
            now: () => new Date("2026-09-20T10:00:00.000Z"),
        });
        const toolResultsDir = resolve(
            projectRoot,
            ".pilotdeck",
            "tool-results",
            sanitizeSessionIdForPath(sessionKey),
        );
        await mkdir(toolResultsDir, { recursive: true });
        const persistedPath = join(toolResultsDir, "turn-1-rag-1.json");
        const fullPayload = buildRagPayload();
        await writeFile(persistedPath, fullPayload, "utf8");

        const replay = await recordRagReferenceSession({
            storage,
            sessionKey,
            projectRoot,
            pilotHome,
            toolName: "med_trauma_rag_query",
            persistedPath,
        });
        const result = replay.messages.find(
            (item) => item.kind === "tool_result" && item.toolCallId === "rag-1",
        );
        assert.ok(result, "expected the RAG tool_result message in history replay");
        assert.equal(result.text, fullPayload);
        assert.equal(result.toolName, "med_trauma_rag_query");
        assert.equal(result.payload?.hasMore, false);
        assert.equal(result.payload?.inlinedFullResult, true);
        assert.equal(result.resultPath, persistedPath);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(pilotHome, { recursive: true, force: true });
    }
});

test("history replay leaves non-citation tool references as previews", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-rag-citation-neg-project-"));
    const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-rag-citation-neg-home-"));
    try {
        const sessionKey = "web:s_rag_citation_negative";
        const storage = createAgentProjectSessionStorage({
            projectRoot,
            pilotHome,
            sessionId: sessionKey,
            now: () => new Date("2026-09-20T10:00:00.000Z"),
        });
        const toolResultsDir = resolve(
            projectRoot,
            ".pilotdeck",
            "tool-results",
            sanitizeSessionIdForPath(sessionKey),
        );
        await mkdir(toolResultsDir, { recursive: true });
        const persistedPath = join(toolResultsDir, "turn-1-rag-1.txt");
        await writeFile(persistedPath, "full bash output ".repeat(2000), "utf8");

        const replay = await recordRagReferenceSession({
            storage,
            sessionKey,
            projectRoot,
            pilotHome,
            toolName: "bash",
            persistedPath,
        });
        const result = replay.messages.find(
            (item) => item.kind === "tool_result" && item.toolCallId === "rag-1",
        );
        assert.ok(result);
        assert.equal(result.text, '{"status": "ok", "chunks": [ ... [preview truncated] ...');
        assert.equal(result.payload?.hasMore, true);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(pilotHome, { recursive: true, force: true });
    }
});

test("history replay refuses to inline RAG references outside the persisted tool-results dirs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-rag-citation-escape-project-"));
    const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-rag-citation-escape-home-"));
    try {
        const sessionKey = "web:s_rag_citation_escape";
        const storage = createAgentProjectSessionStorage({
            projectRoot,
            pilotHome,
            sessionId: sessionKey,
            now: () => new Date("2026-09-20T10:00:00.000Z"),
        });
        // A doctored transcript pointing at an arbitrary file must not be served back.
        const persistedPath = join(projectRoot, "secrets.json");
        await writeFile(persistedPath, '{"secret":"do-not-serve"}', "utf8");

        const replay = await recordRagReferenceSession({
            storage,
            sessionKey,
            projectRoot,
            pilotHome,
            toolName: "med_trauma_rag_query",
            persistedPath,
        });
        const result = replay.messages.find(
            (item) => item.kind === "tool_result" && item.toolCallId === "rag-1",
        );
        assert.ok(result);
        assert.equal(result.text, '{"status": "ok", "chunks": [ ... [preview truncated] ...');
        assert.equal(result.payload?.hasMore, true);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(pilotHome, { recursive: true, force: true });
    }
});
