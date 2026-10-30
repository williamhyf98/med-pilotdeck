// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";
test("history replay restores structured agent file artifacts", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-history-project-"));
    const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-history-home-"));
    try {
        const sessionKey = "web:s_file_artifacts";
        const storage = createAgentProjectSessionStorage({
            projectRoot,
            pilotHome,
            sessionId: sessionKey,
            now: () => new Date("2026-07-21T10:00:00.000Z"),
        });
        await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
            role: "user",
            content: [{
                    type: "tool_result",
                    toolCallId: "bash-1",
                    content: [{ type: "text", text: "wrote report.xlsx" }],
                    raw: { toolName: "bash" },
                }],
        });
        await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
            role: "assistant",
            content: [{ type: "text", text: "Finished." }],
        });
        await storage.transcript.recordFileArtifacts(sessionKey, "turn-1", [{
                id: "artifact-1",
                name: "report.xlsx",
                path: "report.xlsx",
                operation: "created",
                source: "workspace_diff",
                status: "complete",
                size: 42,
                sha256: "a".repeat(64),
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                createdAt: "2026-07-21T10:00:00.000Z",
            }]);
        const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
        const message = replay.messages.find((item) => item.kind === "file_artifacts");
        const assistantMessage = replay.messages.find((item) => item.kind === "text" && item.role === "assistant");
        assert.ok(message);
        assert.ok(assistantMessage);
        assert.equal(message.role, "assistant");
        assert.equal(message.turnId, "turn-1");
        assert.equal(assistantMessage.turnId, "turn-1");
        assert.equal(message.artifacts?.[0]?.path, "report.xlsx");
        assert.equal(message.artifacts?.[0]?.operation, "created");
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(pilotHome, { recursive: true, force: true });
    }
});
test("history replay hides stale workspace-diff artifacts from turns with no tool results", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-stale-artifact-history-project-"));
    const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-stale-artifact-history-home-"));
    try {
        const sessionKey = "web:s_stale_workspace_artifact";
        const storage = createAgentProjectSessionStorage({
            projectRoot,
            pilotHome,
            sessionId: sessionKey,
            now: () => new Date("2026-08-02T10:00:00.000Z"),
        });
        await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
                role: "user",
                content: [{ type: "text", text: "hello" }],
            }]);
        await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
            role: "assistant",
            content: [{ type: "text", text: "Hello." }],
        });
        await storage.transcript.recordFileArtifacts(sessionKey, "turn-1", [{
                id: "artifact-1",
                name: "unrelated.ts",
                path: "src/unrelated.ts",
                operation: "updated",
                source: "workspace_diff",
                status: "complete",
                size: 42,
                sha256: "c".repeat(64),
                mimeType: "text/plain",
                createdAt: "2026-08-02T10:00:00.000Z",
            }]);
        const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
        assert.equal(replay.messages.some((item) => item.kind === "file_artifacts"), false);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(pilotHome, { recursive: true, force: true });
    }
});
test("history replay hides Agent file artifacts in general conversations", async () => {
    const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-general-artifact-history-"));
    try {
        const sessionKey = "web:s_general_file_artifacts";
        const storage = createAgentProjectSessionStorage({
            projectRoot: pilotHome,
            pilotHome,
            sessionId: sessionKey,
            now: () => new Date("2026-07-22T10:00:00.000Z"),
        });
        await storage.transcript.recordFileArtifacts(sessionKey, "turn-1", [{
                id: "artifact-1",
                name: "stale-general-artifact.jsonl",
                path: "stale-general-artifact.jsonl",
                operation: "updated",
                source: "workspace_diff",
                status: "complete",
                size: 42,
                sha256: "b".repeat(64),
                mimeType: "application/x-ndjson",
                createdAt: "2026-07-22T10:00:00.000Z",
            }]);
        const replay = await readWebSessionMessages({ sessionKey, projectKey: pilotHome }, { projectRoot: pilotHome, pilotHome });
        assert.equal(replay.messages.some((item) => item.kind === "file_artifacts"), false);
    }
    finally {
        await rm(pilotHome, { recursive: true, force: true });
    }
});
test("history replay shows document and SVG artifacts in general conversations", async () => {
    const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-general-pdf-artifact-history-"));
    try {
        const sessionKey = "web:s_general_pdf_file_artifacts";
        const storage = createAgentProjectSessionStorage({
            projectRoot: pilotHome,
            pilotHome,
            sessionId: sessionKey,
            now: () => new Date("2026-08-21T10:00:00.000Z"),
        });
        await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
            role: "user",
            content: [{
                type: "tool_result",
                toolCallId: "bash-1",
                content: [{ type: "text", text: "wrote pdf" }],
                raw: { toolName: "bash" },
            }],
        });
        await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
            role: "assistant",
            content: [{ type: "text", text: "PDF ready." }],
        });
        await storage.transcript.recordFileArtifacts(sessionKey, "turn-1", [{
            id: "artifact-pdf",
            name: "战创伤救治方案.pdf",
            path: "exports/战创伤救治方案.pdf",
            operation: "created",
            source: "tool",
            status: "complete",
            size: 2048,
            sha256: "c".repeat(64),
            mimeType: "application/pdf",
            createdAt: "2026-08-21T10:00:00.000Z",
        }, {
            id: "artifact-docx",
            name: "战创伤救治方案.docx",
            path: "exports/战创伤救治方案.docx",
            operation: "created",
            source: "tool",
            status: "complete",
            size: 4096,
            sha256: "e".repeat(64),
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            createdAt: "2026-08-21T10:00:00.000Z",
        }, {
            id: "artifact-pptx",
            name: "战创伤救治教学.pptx",
            path: "exports/战创伤救治教学.pptx",
            operation: "created",
            source: "tool",
            status: "complete",
            size: 8192,
            sha256: "f".repeat(64),
            mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            createdAt: "2026-08-21T10:00:00.000Z",
        }, {
            id: "artifact-xlsx",
            name: "战创伤救治统计.xlsx",
            path: "exports/战创伤救治统计.xlsx",
            operation: "created",
            source: "tool",
            status: "complete",
            size: 16384,
            sha256: "a".repeat(64),
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            createdAt: "2026-08-21T10:00:00.000Z",
        }, {
            id: "artifact-svg",
            name: "战创伤救治流程.svg",
            path: "exports/战创伤救治流程.svg",
            operation: "created",
            source: "tool",
            status: "complete",
            size: 4096,
            sha256: "b".repeat(64),
            mimeType: "image/svg+xml",
            createdAt: "2026-08-21T10:00:00.000Z",
        }, {
            id: "artifact-html",
            name: "病例展示.html",
            path: "exports/病例展示.html",
            operation: "created",
            source: "tool",
            status: "complete",
            size: 2048,
            sha256: "c1".repeat(32),
            mimeType: "text/html",
            createdAt: "2026-08-21T10:00:00.000Z",
        }, {
            id: "artifact-json",
            name: "trauma_care_plan_spec.json",
            path: "exports/trauma_care_plan_spec.json",
            operation: "created",
            source: "tool",
            status: "complete",
            size: 12,
            sha256: "d".repeat(64),
            mimeType: "application/json",
            createdAt: "2026-08-21T10:00:00.000Z",
        }]);
        const replay = await readWebSessionMessages({ sessionKey, projectKey: pilotHome }, { projectRoot: pilotHome, pilotHome });
        const message = replay.messages.find((item) => item.kind === "file_artifacts");
        assert.ok(message);
        assert.deepEqual(message.artifacts?.map((artifact) => artifact.path), [
            "exports/战创伤救治方案.pdf",
            "exports/战创伤救治方案.docx",
            "exports/战创伤救治教学.pptx",
            "exports/战创伤救治统计.xlsx",
            "exports/战创伤救治流程.svg",
            "exports/病例展示.html",
        ]);
    }
    finally {
        await rm(pilotHome, { recursive: true, force: true });
    }
});
