// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpClient } from "../../../src/mcp/client/McpClient.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTaskProcessLimitsForTests } from "../../../src/security/policy/resourceLimits.js";
test("McpClient keeps stdio clients idle before connection", () => {
    const client = new McpClient({ id: "stdio-test", transport: "stdio", command: "node" });
    assert.equal(client.getStatus(), "idle");
});
test("McpClient constructs streamable_http transport without requiring stdio fields", () => {
    const client = new McpClient({ id: "http-test", transport: "streamable_http", url: "https://mcp.example.test/mcp" });
    assert.equal(client.getStatus(), "idle");
});
test("McpClient routes streamable_http fetches with bounded timeouts", async () => {
    const calls = [];
    const fetchImpl = async (input, init, options) => {
        calls.push({ input, init, timeoutMs: options?.timeoutMs });
        return new Response("{}");
    };
    const client = new McpClient({ id: "http-test", transport: "streamable_http", url: "https://mcp.example.test/mcp" }, { callTimeoutMs: 12_345, handshakeTimeoutMs: 2_345, fetch: fetchImpl });
    const transport = client.buildTransport();
    assert.ok(transport instanceof StreamableHTTPClientTransport);
    const transportFetch = transport._fetch;
    assert.equal(typeof transportFetch, "function");
    await transportFetch?.("https://mcp.example.test/mcp", { method: "GET" });
    assert.equal(calls.at(-1)?.timeoutMs, 2_345);
    await transportFetch?.("https://mcp.example.test/mcp", { method: "POST" });
    assert.equal(calls.at(-1)?.timeoutMs, 12_345);
});

test("McpClient caps configured foreground calls at the shared resource limit", async () => {
    const calls = [];
    const fetchImpl = async (input, init, options) => {
        calls.push({ input, init, timeoutMs: options?.timeoutMs });
        return new Response("{}");
    };
    const client = new McpClient(
        { id: "http-limit-test", transport: "streamable_http", url: "https://mcp.example.test/mcp" },
        { callTimeoutMs: 999_999, fetch: fetchImpl },
    );
    const transport = client.buildTransport();
    const transportFetch = transport._fetch;
    await transportFetch?.("https://mcp.example.test/mcp", { method: "POST" });
    assert.equal(calls.at(-1)?.timeoutMs, 600_000);
});

test("McpClient allows only one task-scoped stdio call at a time", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-resource-"));
    await mkdir(join(root, "scratch"), { recursive: true });
    try {
        const client = new McpClient(
            { id: "stdio-resource-test", transport: "stdio", command: "node" },
            { resourceLimits: { maxChildProcesses: 1 } },
        );
        let started = false;
        let releaseFirst;
        client.start = async () => {
            client.client = client.client ?? {
                callTool: async () => {
                    started = true;
                    await new Promise((resolve) => { releaseFirst = resolve; });
                    return { content: [{ type: "text", text: "ok" }] };
                },
            };
        };

        const first = client.callTool("work", {}, { taskRoot: root });
        while (!started) await new Promise((resolve) => setImmediate(resolve));
        await assert.rejects(
            client.callTool("work", {}, { taskRoot: root }),
            /active registered child process/u,
        );
        releaseFirst();
        await first;
    } finally {
        resetTaskProcessLimitsForTests();
        await rm(root, { recursive: true, force: true });
    }
});
