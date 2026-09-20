/**
 * General-medicine prompt profile.
 *
 * The 4 prompt strings here are verbatim copies of the constants that lived in
 * llm-extraction.ts before Task 5. They are the baselines; Task 11 will edit
 * them (medical specialisation). Do NOT change these strings in Task 5 — the
 * prompts.test.ts snapshot is the correctness gate.
 *
 * llm-extraction.ts re-exports the 4 constants by reading from this profile so
 * that the snapshot test still imports from the same path it always did.
 */
import type { MemoryPromptProfile } from "./types.js";
export declare const GENERAL_MEDICINE_PROFILE: MemoryPromptProfile;
