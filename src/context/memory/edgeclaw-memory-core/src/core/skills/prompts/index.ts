/**
 * Public entry point for the prompt profile archive.
 *
 * Consumers should import from here, not from individual profile files, so that
 * internal module boundaries remain stable across future Task 11 changes.
 */

export type { MemoryNoteKind, MemoryPromptProfile, SharedPromptFragments } from "./types.js";
export {
  SHARED_FRAGMENTS,
  JSON_ONLY_RULE,
  OVERRIDE_TEST,
  LANGUAGE_FOLLOW_RULES,
  buildNoteCreateJsonContract,
} from "./shared.js";
export { GENERAL_MEDICINE_PROFILE } from "./generalMedicine.js";
export { WAR_TRAUMA_PROFILE } from "./warTrauma.js";

import type { MemoryPromptProfile } from "./types.js";
import { GENERAL_MEDICINE_PROFILE } from "./generalMedicine.js";
import { WAR_TRAUMA_PROFILE } from "./warTrauma.js";

/**
 * Resolve a MemoryPromptProfile by project type string.
 * Unknown types fall back to general_medicine — callers with a validated
 * `projectType` should pass it directly; this function is for runtime use
 * where the value originates from config.
 */
export function resolveMemoryPromptProfile(
  type: string | undefined,
): MemoryPromptProfile {
  if (type === "war_trauma") return WAR_TRAUMA_PROFILE;
  return GENERAL_MEDICINE_PROFILE;
}
