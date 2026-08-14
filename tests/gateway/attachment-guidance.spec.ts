// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";
test("registered plain-text attachments with non-whitelisted names are described as read_file inspectable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-guidance-"));
    try {
        const dockerfilePath = join(root, "Dockerfile");
        await writeFile(dockerfilePath, "FROM node:22\n");
        let capturedInput;
        const gateway = createGateway((input) => {
            capturedInput = input;
        });
        for await (const _event of gateway.submitTurn({
            sessionKey: "session-1",
            channelKey: "feishu",
            message: "inspect attachment",
            attachments: [{
                    type: "file",
                    path: dockerfilePath,
                    name: "Dockerfile",
                    metadata: { channelKey: "feishu" },
                }],
        })) {
            // Drain the stream so the fake session runs to completion.
        }
        const text = inputText(capturedInput);
        assert.match(text, /Dockerfile/);
        assert.match(text, /Use read_file with the exact path/);
        assert.doesNotMatch(text, /not directly inspectable with read_file/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("registered Office attachments are still described as not directly inspectable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-guidance-"));
    try {
        const docxPath = join(root, "sample.docx");
        await writeFile(docxPath, Buffer.from("PK".padEnd(128, "x")));
        let capturedInput;
        const gateway = createGateway((input) => {
            capturedInput = input;
        });
        for await (const _event of gateway.submitTurn({
            sessionKey: "session-1",
            channelKey: "feishu",
            message: "inspect attachment",
            attachments: [{
                    type: "file",
                    path: docxPath,
                    name: "sample.docx",
                    metadata: { channelKey: "feishu" },
                }],
        })) {
            // Drain the stream so the fake session runs to completion.
        }
        const text = inputText(capturedInput);
        assert.match(text, /sample\.docx/);
        assert.match(text, /not directly inspectable with read_file/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("inline web images retain their staged path in agent guidance", async () => {
    const imagePath = join(tmpdir(), "pilotdeck-inline-trauma.jpg");
    let capturedInput;
    const gateway = createGateway((input) => {
        capturedInput = input;
    });
    for await (const _event of gateway.submitTurn({
        sessionKey: "session-image",
        channelKey: "web",
        message: "generate a trauma care plan",
        attachments: [{
                type: "image",
                path: imagePath,
                name: "trauma.jpg",
                mimeType: "image/jpeg",
                content: Buffer.from("image-bytes").toString("base64"),
            }],
    })) {
        // Drain the stream so the fake session receives the canonical input.
    }
    const text = inputText(capturedInput);
    assert.match(text, /Registered attachment files in this session/);
    assert.match(text, /trauma\.jpg/);
    assert.match(text, new RegExp(imagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
function createGateway(onInput) {
    const router = new SessionRouter({
        idleSweepIntervalMs: 0,
        createSession: () => createFakeSession(onInput),
    });
    return new InProcessGateway(router, {
        uuid: () => "run-1",
        now: () => new Date("2026-07-20T00:00:00.000Z"),
    });
}
function createFakeSession(onInput) {
    return {
        async *submit(input, options = {}) {
            const turnId = options.turnId ?? "turn-1";
            onInput(input);
            yield { type: "turn_started", sessionId: "session-1", turnId };
            yield {
                type: "turn_completed",
                sessionId: "session-1",
                turnId,
                result: {
                    type: "success",
                    sessionId: "session-1",
                    turnId,
                    stopReason: "completed",
                    usage: {},
                    permissionDenials: [],
                    turns: 1,
                    startedAt: "2026-07-20T00:00:00.000Z",
                    completedAt: "2026-07-20T00:00:00.000Z",
                },
            };
        },
        abort() { },
        snapshot() {
            return {
                sessionId: "session-1",
                messages: [],
                usage: {},
                status: "idle",
                permissionDenials: [],
            };
        },
    };
}
function inputText(input) {
    assert.ok(input, "expected fake session to receive agent input");
    if (input.type === "text")
        return input.text;
    return input.content
        .map((block) => block.type === "text" ? block.text : "")
        .filter(Boolean)
        .join("\n");
}
