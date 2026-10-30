import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalMessagesToMemoryMessages } from "../../src/context/memory/MemoryResolver.js";
import { normalizeMessages } from "../../src/context/memory/edgeclaw-memory-core/src/message-utils.js";
import type { CanonicalMessage } from "../../src/model/index.js";
import { LlmMemoryExtractor } from "../../src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.js";
import { EdgeClawMemoryService } from "../../src/context/memory/edgeclaw-memory-core/src/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WAR_TRAUMA_PROFILE } from "../../src/context/memory/edgeclaw-memory-core/src/core/skills/prompts/warTrauma.js";

const query: CanonicalMessage = { role: "user", content: [{ type: "text", text: "请分析病人情况" }] };
const exchange = (name: string, file: string, text: string, isError = false): CanonicalMessage[] => [
  { role: "assistant", content: [{ type: "tool_call", id: "read-1", name, input: { file_path: file, path: file } }] },
  { role: "user", content: [{ type: "tool_result", toolCallId: "read-1", content: [{ type: "text", text }], isError }] },
];

test("current registered attachment survives normalization independently of chat length", () => {
  const text = "入院记录：" + "患者事实。".repeat(2000) + "末尾：青霉素过敏";
  const result = canonicalMessagesToMemoryMessages([query, ...exchange("read_file", "/project/upload.xml", text)], {
    attachmentContext: { allowedReadFiles: ["/project/upload.xml"], cwd: "/project" },
  });
  const normalized = normalizeMessages(result, { includeAssistant: true, maxMessageChars: 100, captureStrategy: "last_turn" });
  const evidence = normalized[0]?.attachmentEvidence;
  assert.equal(evidence?.length, 1);
  assert.ok(evidence![0]!.chunks.join("").endsWith("末尾：青霉素过敏"));
  assert.ok(evidence![0]!.chunks.length > 1);
  assert.equal(evidence![0]!.sourceId.includes("/project"), false);
});

test("rejects old, unregistered, failed and unrelated tool evidence", () => {
  for (const [name, file, failed] of [["read_file", "/other.xml", false], ["read_file", "/project/upload.xml", true], ["bash", "/project/upload.xml", false]] as const) {
    const result = canonicalMessagesToMemoryMessages([query, ...exchange(name, file, "不可记忆", failed)], {
      attachmentContext: { allowedReadFiles: ["/project/upload.xml"], cwd: "/project" },
    });
    assert.equal(result[0]?.attachmentEvidence?.length ?? 0, 0);
  }
  const result = canonicalMessagesToMemoryMessages([query, ...exchange("read_file", "/project/upload.xml", "旧病例"), query], {
    attachmentContext: { allowedReadFiles: ["/project/upload.xml"], cwd: "/project" },
  });
  assert.ok(result.every((message) => !message.attachmentEvidence?.length));
});

test("medical parser uses matching successful source summaries, never generated report", () => {
  const payload = JSON.stringify({ status: "ready", report: "模型推测肿瘤", items: [
    { path: "/project/upload.xml", status: "ready", included: true, summary: "原文：既往高血压" },
    { path: "/project/other.xml", status: "ready", included: true, summary: "其他病人" },
  ] });
  const result = canonicalMessagesToMemoryMessages([query, ...exchange("mcp__med_tools__med_parse_medical", "/project", payload)], {
    attachmentContext: { allowedReadFiles: ["/project/upload.xml"], cwd: "/project" },
  });
  assert.deepEqual(result[0]?.attachmentEvidence?.[0]?.chunks, ["原文：既往高血压"]);
});

test("read_file unchanged notices do not become attachment facts", () => {
  const result = canonicalMessagesToMemoryMessages([query, ...exchange("read_file", "/project/upload.xml",
    "File unchanged since the last read. Refer to the earlier read_file result instead of re-reading it.")], {
    attachmentContext: { allowedReadFiles: ["/project/upload.xml"], cwd: "/project" },
  });
  assert.equal(result[0]?.attachmentEvidence?.length ?? 0, 0);
});

test("Index classification and Project creation receive the same evidence; later turns do not", async () => {
  const normalized = normalizeMessages(canonicalMessagesToMemoryMessages([query, ...exchange("read_file", "/project/upload.xml", "原始记录：青霉素过敏")], {
    attachmentContext: { allowedReadFiles: ["/project/upload.xml"], cwd: "/project" },
  }), { includeAssistant: true, maxMessageChars: 100, captureStrategy: "last_turn" });
  const extractor = new LlmMemoryExtractor({}, undefined);
  const requests: Record<string, any>[] = [];
  // Deliberately no model configured: the real extractor still reports its request
  // through the diagnostic callback, allowing inspection without external IO.
  const input = { timestamp: "2026-09-21T00:00:00Z", focusUserTurn: normalized[0]!, batchContextMessages: normalized,
    debugTrace: (trace: { userPrompt: string }) => { requests.push(JSON.parse(trace.userPrompt)); } };
  await extractor.classifyMemoryTurn(input);
  await extractor.createProjectMemoryNote({ ...input, classification: { type: "project", reason: "病例事实", evidence: "过敏史" } });
  assert.deepEqual(requests[0]?.focus_attachment_evidence?.[0]?.chunks, ["原始记录：青霉素过敏"]);
  assert.deepEqual(requests[1]?.context.focus_attachment_evidence, requests[0]?.focus_attachment_evidence);
  const later = { role: "user", content: "谢谢" };
  await extractor.classifyMemoryTurn({ ...input, focusUserTurn: later, batchContextMessages: [...normalized, later] });
  assert.equal(JSON.stringify(requests[2]).includes("原始记录：青霉素过敏"), false);
  await extractor.createFeedbackMemoryNote({ ...input, classification: { type: "feedback", reason: "偏好", evidence: "表格" } });
  assert.equal(JSON.stringify(requests[3]).includes("原始记录：青霉素过敏"), false);
  await new LlmMemoryExtractor({}, undefined, undefined, WAR_TRAUMA_PROFILE).classifyMemoryTurn(input);
  assert.equal(JSON.stringify(requests[4]).includes("原始记录：青霉素过敏"), false);
});

test("oversized evidence is bounded, keeps ending and exposes omissions; duplicate reads deduplicate", () => {
  const text = "开始" + "x".repeat(80_000) + "结尾";
  const result = canonicalMessagesToMemoryMessages([query, ...exchange("read_file", "/project/upload.xml", text), ...exchange("read_file", "/project/upload.xml", text)], {
    attachmentContext: { allowedReadFiles: ["/project/upload.xml"], cwd: "/project" },
  });
  const evidence = result[0]!.attachmentEvidence!;
  assert.equal(evidence.length, 1);
  assert.ok(evidence[0]!.chunks.join("").endsWith("结尾"));
  assert.ok(evidence[0]!.chunks.join("").length <= 64_000);
  assert.ok(evidence[0]!.omittedChars > 0);
  assert.equal(evidence[0]!.possiblyPartial, true);
});

test("attachment evidence survives persisted L0 reload for deferred Index", () => {
  const dir = mkdtempSync(join(tmpdir(), "attachment-memory-"));
  const options = { workspaceDir: dir, rootDir: dir, defaultIndexingSettings: { maintenanceMode: "manual" as const } };
  let service = new EdgeClawMemoryService(options);
  try {
    service.captureTurn(canonicalMessagesToMemoryMessages([query, ...exchange("read_file", "/project/upload.xml", "入院记录：过敏史")], {
      attachmentContext: { allowedReadFiles: ["/project/upload.xml"], cwd: "/project" },
    }), { sessionKey: "test-session", timestamp: "2026-09-21T00:00:00Z" });
    service.close();
    service = new EdgeClawMemoryService(options);
    const rows = service.repository.listUnindexedL0BySession("test-session");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.messages[0]?.attachmentEvidence?.[0]?.chunks, ["入院记录：过敏史"]);
    service.captureTurn(canonicalMessagesToMemoryMessages([query, ...exchange("read_file", "/project/upload.xml", "新记录：无过敏史")], {
      attachmentContext: { allowedReadFiles: ["/project/upload.xml"], cwd: "/project" },
    }), { sessionKey: "test-session", timestamp: "2026-09-21T00:01:00Z" });
    assert.equal(service.repository.listUnindexedL0BySession("test-session").length, 2,
      "same query with different attachment evidence is not a duplicate turn");
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});
