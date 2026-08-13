// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { CRON_SCHEDULE_SCHEMA } from "../../../src/cron/tool/CronSchemas.js";
import { buildModelRequest } from "../../../src/model/index.js";
import { normalizeOpenAISchema } from "../../../src/model/providers/openai/schema.js";
test("openai schema normalization adds explicit types to cron literal variants", () => {
    const normalized = normalizeOpenAISchema({
        type: "object",
        required: ["schedule"],
        additionalProperties: false,
        properties: {
            schedule: CRON_SCHEDULE_SCHEMA,
        },
    });
    const properties = normalized.properties;
    const schedule = properties.schedule;
    const variants = schedule.anyOf;
    const onceProperties = variants[0]?.properties;
    assert.equal(onceProperties.type.type, "string");
    assert.equal(onceProperties.type.const, "once");
    const cronProperties = variants[1]?.properties;
    assert.equal(cronProperties.type.type, "string");
    assert.equal(cronProperties.type.const, "cron");
    const delayProperties = variants[2]?.properties;
    assert.equal(delayProperties.type.type, "string");
    assert.equal(delayProperties.type.const, "delay");
    assert.equal(delayProperties.unit.type, "string");
    assert.deepEqual(delayProperties.unit.enum, ["second", "minute", "hour", "day"]);
});
test("openai schema normalization preserves array item fallback", () => {
    const normalized = normalizeOpenAISchema({
        type: "object",
        additionalProperties: false,
        properties: {
            value: {
                type: ["string", "array"],
            },
        },
    });
    const properties = normalized.properties;
    assert.deepEqual(properties.value.items, {});
});
test("openai response_format schemas get literal types normalized", () => {
    const body = buildModelRequest(outputSchemaRequest("openai"), modelConfig("openai"));
    const schema = body.response_format?.json_schema.schema;
    assert.ok(schema);
    assertLiteralTypes(schema);
});
test("openai responses output schemas get literal types normalized", () => {
    const body = buildModelRequest(outputSchemaRequest("openai-responses"), modelConfig("openai-responses"));
    const schema = body.text?.format.schema;
    assert.ok(schema);
    assertLiteralTypes(schema);
});
function outputSchemaRequest(provider) {
    return {
        provider,
        model: "test-model",
        stream: true,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        outputSchema: {
            name: "result",
            schema: {
                type: "object",
                additionalProperties: false,
                required: ["status", "kind"],
                properties: {
                    status: { enum: ["ok", "failed"] },
                    kind: { const: "report" },
                },
            },
        },
    };
}
function assertLiteralTypes(schema) {
    const properties = schema.properties;
    assert.equal(properties.status.type, "string");
    assert.deepEqual(properties.status.enum, ["ok", "failed"]);
    assert.equal(properties.kind.type, "string");
    assert.equal(properties.kind.const, "report");
}
function modelConfig(protocol) {
    const capabilities = {
        supportsToolUse: true,
        supportsStreaming: true,
        supportsParallelToolCalls: true,
        supportsThinking: false,
        supportsJsonSchema: true,
        supportsSystemPrompt: true,
        supportsPromptCache: false,
        maxContextTokens: 128_000,
        maxOutputTokens: 4_096,
    };
    const models = {
        "test-model": {
            id: "test-model",
            capabilities,
            multimodal: { input: ["text"] },
        },
    };
    const provider = {
        id: protocol,
        protocol,
        url: "https://example.invalid/v1",
        apiKey: "test",
        headers: {},
        models,
    };
    return { providers: { [protocol]: provider } };
}
