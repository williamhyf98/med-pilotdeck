/**
 * Rewind a web session transcript by removing its LAST user turn in place.
 *
 * Unlike forking (which branches into a new session), rewinding truncates the
 * source transcript so the session itself continues without the removed turn.
 * The caller is expected to evict any in-memory session state afterwards so
 * the next resume replays the truncated transcript from disk.
 */

import { randomUUID } from "node:crypto";
import { copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanonicalContentBlock } from "../../model/index.js";
import { getPilotProjectChatDir, resolveGatewayProjectKey } from "../../pilot/index.js";
import { readTranscript } from "../../session/transcript/TranscriptReader.js";
import {
  sanitizeSessionIdForPath,
} from "../../session/storage/ProjectSessionStorage.js";
import type {
  AgentAcceptedInputTranscriptEntry,
  AgentSessionMetadataTranscriptEntry,
  AgentTranscriptEntry,
} from "../../session/transcript/TranscriptEntry.js";
import type { WebRewindSessionInput, WebRewindSessionResult } from "../client/protocol.js";

export type RewindWebSessionOptions = {
  projectRoot: string;
  pilotHome: string;
  now?: () => Date;
};

export class RewindSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RewindSessionError";
  }
}

function extractAcceptedInputText(entry: AgentAcceptedInputTranscriptEntry): string {
  const chunks: string[] = [];
  for (const message of entry.messages) {
    for (const block of message.content as CanonicalContentBlock[]) {
      if (block.type === "text" && block.text.trim()) {
        chunks.push(block.text.trim());
      }
    }
  }
  return chunks.join("\n\n").trim();
}

function hasUnsupportedRewindContent(entry: AgentAcceptedInputTranscriptEntry): boolean {
  return entry.messages.some((message) =>
    (message.content as CanonicalContentBlock[]).some((block) => block.type !== "text"),
  );
}

function lastSessionMetadata(
  entries: AgentTranscriptEntry[],
): AgentSessionMetadataTranscriptEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "session_metadata") {
      return entry;
    }
  }
  return undefined;
}

export async function rewindWebSession(
  input: WebRewindSessionInput,
  options: RewindWebSessionOptions,
): Promise<WebRewindSessionResult> {
  const effectiveProjectRoot = resolveGatewayProjectKey(
    input.projectKey ?? options.projectRoot,
    options.pilotHome,
  );
  const chatDir = getPilotProjectChatDir(effectiveProjectRoot, options.pilotHome);
  const safeId = sanitizeSessionIdForPath(input.sessionKey);
  const transcriptPath = resolve(chatDir, `${safeId}.jsonl`);

  const { entries } = await readTranscript(transcriptPath);
  if (entries.length === 0) {
    throw new RewindSessionError("rewind_empty_transcript", "Cannot rewind an empty session transcript.");
  }

  const target = entries.find((entry) => entry.entryId === input.fromEntryId);
  if (!target) {
    throw new RewindSessionError("rewind_entry_not_found", `Transcript entry not found: ${input.fromEntryId}`);
  }
  if (target.type !== "accepted_input") {
    throw new RewindSessionError(
      "rewind_not_accepted_input",
      "Rewind target must be a user turn (accepted_input entry).",
    );
  }

  // Only the LAST user turn may be rewound: removing an earlier turn would
  // orphan the turns that already responded to it.
  const lastAcceptedInput = [...entries]
    .reverse()
    .find((entry): entry is AgentAcceptedInputTranscriptEntry => entry.type === "accepted_input");
  if (!lastAcceptedInput || lastAcceptedInput.entryId !== target.entryId) {
    throw new RewindSessionError(
      "rewind_not_last_turn",
      "Only the last user turn of a session can be rewound.",
    );
  }

  if (hasUnsupportedRewindContent(target)) {
    throw new RewindSessionError(
      "rewind_unsupported_content",
      "Rewinding messages with attachments or non-text input is not supported yet.",
    );
  }

  const removedText = extractAcceptedInputText(target);
  const preserved = entries.filter((entry) => entry.sequence < target.sequence);
  const removedEntryCount = entries.length - preserved.length;

  // Keep the newest session metadata (title, timestamps) even when it was
  // written after the rewound turn — losing it would rename the session.
  const newestMetadata = lastSessionMetadata(entries);
  const preservedHasNewestMetadata =
    !newestMetadata || preserved.some((entry) => entry.entryId === newestMetadata.entryId);

  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const maxPreservedSequence = preserved.reduce((max, entry) => Math.max(max, entry.sequence), 0);
  const lastPreservedEntryId = preserved[preserved.length - 1]?.entryId ?? null;

  const finalEntries: AgentTranscriptEntry[] = [...preserved];
  if (newestMetadata && !preservedHasNewestMetadata) {
    const carriedMetadata: AgentSessionMetadataTranscriptEntry = {
      ...newestMetadata,
      turnId: `rewind-${randomUUID()}`,
      sequence: maxPreservedSequence + 1,
      createdAt: nowIso,
      entryId: randomUUID(),
      parentEntryId: lastPreservedEntryId,
      metadata: {
        ...newestMetadata.metadata,
        updatedAt: nowIso,
      },
    };
    finalEntries.push(carriedMetadata);
  }

  // Safety copy so a mistaken rewind is recoverable by hand.
  await copyFile(transcriptPath, resolve(chatDir, `${safeId}.pre-rewind.jsonl`));

  const body = finalEntries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  await writeFile(transcriptPath, body, { encoding: "utf8", mode: 0o600 });

  return {
    removedTurnId: target.turnId,
    removedFromSequence: target.sequence,
    removedAtIso: nowIso,
    removedText,
    removedEntryCount,
  };
}
