import { createHash } from "node:crypto";
import path from "node:path";
import type { CanonicalMessage, CanonicalToolCallBlock } from "../../model/index.js";
import type { MemoryAttachmentEvidence } from "./edgeclaw-memory-core/src/core/types.js";

export type AttachmentCaptureContext = { allowedReadFiles: readonly string[]; cwd: string };

/** No file IO: collect only material actually returned by successful reads this turn. */
export function collectAttachmentEvidence(
  messages: CanonicalMessage[], context: AttachmentCaptureContext,
): MemoryAttachmentEvidence[] {
  const allowed = new Set(context.allowedReadFiles.map((file) => path.resolve(context.cwd, file)));
  const calls = new Map<string, CanonicalToolCallBlock>();
  const evidence: MemoryAttachmentEvidence[] = [];
  const seen = new Set<string>();
  let remaining = 64_000;
  const add = (file: unknown, text: unknown, sourceKind: MemoryAttachmentEvidence["sourceKind"], partial: boolean) => {
    if (typeof file !== "string" || typeof text !== "string" || !text.trim()) return;
    const absolute = path.resolve(context.cwd, file);
    if (!allowed.has(absolute)) return;
    const sourceId = createHash("sha256").update(absolute).digest("hex").slice(0, 16);
    const fingerprint = createHash("sha256").update(sourceId + sourceKind + text).digest("hex");
    if (seen.has(fingerprint) || evidence.length >= 64) return;
    seen.add(fingerprint);
    // Keep both ends when over budget; never silently discard the final sections.
    const length = Math.min(remaining, text.length);
    const head = Math.ceil(length / 2);
    const chunks: string[] = [];
    const parts = length === text.length ? [text] : [text.slice(0, head), length > head ? text.slice(-(length - head)) : ""];
    for (const part of parts) {
      for (let offset = 0; offset < part.length; offset += 6000) chunks.push(part.slice(offset, offset + 6000));
    }
    evidence.push({ sourceId, sourceKind, chunks, originalChars: text.length,
      omittedChars: text.length - length, possiblyPartial: partial || length < text.length });
    remaining -= length;
  };
  for (const message of messages) {
    if (message.metadata?.forkCarryover) continue;
    for (const block of message.content) {
      if (block.type === "tool_call" && message.role === "assistant") calls.set(block.id, block);
      if (block.type !== "tool_result" || block.isError) continue;
      const call = calls.get(block.toolCallId);
      if (!call) continue;
      const input = call.input as Record<string, unknown> | null;
      const text = block.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (call.name === "read_file") {
        const file = input?.file_path;
        // Binary reads return notices, not textual source evidence.
        if (typeof file !== "string" || /\.(pdf|png|jpe?g|gif|webp|bmp|tiff?|dcm)$/i.test(file)) continue;
        if (/^\s*(?:\[|<system-reminder>)/.test(text)) continue;
        const raw = block.raw as { data?: { truncated?: boolean; unchanged?: boolean }; metadata?: { truncated?: boolean; unchanged?: boolean } } | undefined;
        if (raw?.data?.unchanged || raw?.metadata?.unchanged || text.startsWith("File unchanged since the last read.")) continue;
        const partial = Boolean(input?.offset || input?.limit || raw?.data?.truncated || raw?.metadata?.truncated)
          || /truncat|read more|next offset|Continue with read_file/i.test(text);
        // These notices contain local paths and instructions, not source material.
        add(file, text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim(), "read_text", partial);
      } else if (/(?:^|__)med_parse_medical$/.test(call.name)) {
        try {
          const payload = JSON.parse(text) as Record<string, unknown>;
          if (payload.status === "error" || !Array.isArray(payload.items)) continue;
          for (const item of payload.items) {
            if (!item || !["ready", "degraded"].includes(item.status) || item.included !== true) continue;
            // A parser summary has its own upstream limits; report is model-generated.
            add(item.path, item.summary, "medical_parser_summary", true);
          }
        } catch { /* Invalid parser output is not evidence. */ }
      }
    }
  }
  return evidence;
}
