import { readFile, stat } from "node:fs/promises";
import type { AgentTranscriptDiagnostic, AgentTranscriptEntry } from "./TranscriptEntry.js";

export const DEFAULT_MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024;

export type AgentTranscriptReadResult = {
  entries: AgentTranscriptEntry[];
  diagnostics: AgentTranscriptDiagnostic[];
};

export type ReadTranscriptOptions = {
  maxBytes?: number;
};

export async function readTranscript(path: string, options: ReadTranscriptOptions = {}): Promise<AgentTranscriptReadResult> {
  let content: string;
  try {
    const fileStat = await stat(path);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_READ_BYTES;
    if (fileStat.size > maxBytes) {
      return {
        entries: [],
        diagnostics: [
          {
            code: "transcript_too_large",
            severity: "error",
            message: `Transcript ${path} is larger than ${maxBytes} bytes.`,
          },
        ],
      };
    }
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        entries: [],
        diagnostics: [
          {
            code: "transcript_missing",
            severity: "warning",
            message: `Transcript ${path} does not exist.`,
          },
        ],
      };
    }
    throw error;
  }

  const entries: AgentTranscriptEntry[] = [];
  const diagnostics: AgentTranscriptDiagnostic[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (isTranscriptEntry(parsed)) {
        entries.push(parsed);
      } else {
        diagnostics.push({
          code: "transcript_entry_invalid",
          severity: "error",
          message: "Transcript entry has an invalid shape.",
          line: index + 1,
        });
      }
    } catch (error) {
      diagnostics.push({
        code: "transcript_line_invalid",
        severity: "error",
        message: error instanceof Error ? error.message : "Transcript line is not valid JSON.",
        line: index + 1,
      });
    }
  }

  // Older trauma turns opened a fresh transcript writer for every turn, so
  // sequence restarted at 1 and sorting globally by sequence interleaved the
  // conversation as user,user,assistant,assistant. Detect that legacy shape
  // and use the append timestamps as the primary order. Normal transcripts
  // retain the stronger monotonic-sequence ordering.
  const sequenceOwners = new Map<number, string>();
  const hasCrossTurnDuplicateSequence = entries.some((entry) => {
    const owner = sequenceOwners.get(entry.sequence);
    if (owner !== undefined && owner !== entry.turnId) return true;
    sequenceOwners.set(entry.sequence, entry.turnId);
    return false;
  });
  entries.sort((left, right) => {
    if (hasCrossTurnDuplicateSequence) {
      const byTime = left.createdAt.localeCompare(right.createdAt);
      if (byTime !== 0) return byTime;
    }
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return left.createdAt.localeCompare(right.createdAt);
  });
  return { entries, diagnostics };
}

function isTranscriptEntry(value: unknown): value is AgentTranscriptEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.type === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.sequence === "number" &&
    typeof value.createdAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
