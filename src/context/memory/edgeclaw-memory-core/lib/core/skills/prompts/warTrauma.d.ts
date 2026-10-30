/**
 * War-trauma prompt profile.
 *
 * Captures only feedback-type collaboration rules from war-trauma sessions.
 * User and project note creation are intentionally absent — the hard gate in
 * LlmMemoryExtractor enforces this at the code level (allowedTypes), so even if
 * the classifier somehow returns a user/project label it is discarded.
 *
 * The classification prompt deliberately limits itself to the feedback/discard
 * binary: it does not attempt three-way classification. PHI categories listed
 * explicitly to make it clear that war-trauma session content must not leak into
 * long-term memory.
 */
import type { MemoryPromptProfile } from "./types.js";
export declare const WAR_TRAUMA_PROFILE: MemoryPromptProfile;
