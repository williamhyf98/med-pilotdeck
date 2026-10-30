/**
 * Tests for Task 5 — prompt profile archive mechanism.
 *
 * Run: pnpm exec tsx --test tests/context/memory/promptProfile.spec.ts
 *
 * Verifies:
 *   - resolveMemoryPromptProfile returns the correct profile by type string
 *   - war_trauma profile has no user/project note-create prompts (hard gate)
 *   - both profiles hold a reference to the same shared fragments object
 *   - general_medicine allowedTypes covers all three kinds
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveMemoryPromptProfile,
  GENERAL_MEDICINE_PROFILE,
  WAR_TRAUMA_PROFILE,
  SHARED_FRAGMENTS,
} from "../../../src/context/memory/edgeclaw-memory-core/src/core/skills/prompts/index.js";

describe("resolveMemoryPromptProfile", () => {
  test('resolves "war_trauma" to the war_trauma profile', () => {
    const profile = resolveMemoryPromptProfile("war_trauma");
    assert.equal(profile.type, "war_trauma");
  });

  test('resolves "general_medicine" to the general_medicine profile', () => {
    const profile = resolveMemoryPromptProfile("general_medicine");
    assert.equal(profile.type, "general_medicine");
  });

  test("resolves unknown string to general_medicine (safe default)", () => {
    const profile = resolveMemoryPromptProfile("unknown_type");
    assert.equal(profile.type, "general_medicine");
  });

  test("resolves undefined to general_medicine", () => {
    const profile = resolveMemoryPromptProfile(undefined);
    assert.equal(profile.type, "general_medicine");
  });
});

describe("war_trauma profile — allowedTypes hard gate", () => {
  test("war_trauma allowedTypes contains only feedback", () => {
    assert.deepEqual([...WAR_TRAUMA_PROFILE.allowedTypes], ["feedback"]);
  });

  test("war_trauma noteCreate.user is undefined", () => {
    assert.equal(WAR_TRAUMA_PROFILE.noteCreate.user, undefined);
  });

  test("war_trauma noteCreate.project is undefined", () => {
    assert.equal(WAR_TRAUMA_PROFILE.noteCreate.project, undefined);
  });

  test("war_trauma noteCreate.feedback is a non-empty string", () => {
    assert.ok(
      typeof WAR_TRAUMA_PROFILE.noteCreate.feedback === "string"
        && WAR_TRAUMA_PROFILE.noteCreate.feedback.trim().length > 0,
      "war_trauma feedback prompt must be a non-empty string",
    );
  });
});

describe("general_medicine profile — coverage", () => {
  test("general_medicine allowedTypes covers all three kinds", () => {
    const allowed = new Set(GENERAL_MEDICINE_PROFILE.allowedTypes);
    assert.ok(allowed.has("user"), "user must be allowed");
    assert.ok(allowed.has("project"), "project must be allowed");
    assert.ok(allowed.has("feedback"), "feedback must be allowed");
  });

  test("all three noteCreate prompts are non-empty strings", () => {
    assert.ok(typeof GENERAL_MEDICINE_PROFILE.noteCreate.user === "string" && GENERAL_MEDICINE_PROFILE.noteCreate.user.trim().length > 0);
    assert.ok(typeof GENERAL_MEDICINE_PROFILE.noteCreate.project === "string" && GENERAL_MEDICINE_PROFILE.noteCreate.project.trim().length > 0);
    assert.ok(typeof GENERAL_MEDICINE_PROFILE.noteCreate.feedback === "string" && GENERAL_MEDICINE_PROFILE.noteCreate.feedback.trim().length > 0);
  });
});

describe("shared fragments — identity (===) assertion", () => {
  test("GENERAL_MEDICINE_PROFILE.shared is the same object as SHARED_FRAGMENTS", () => {
    assert.strictEqual(
      GENERAL_MEDICINE_PROFILE.shared,
      SHARED_FRAGMENTS,
      "general_medicine profile must hold a reference to the same SHARED_FRAGMENTS constant, not a copy",
    );
  });

  test("WAR_TRAUMA_PROFILE.shared is the same object as SHARED_FRAGMENTS", () => {
    assert.strictEqual(
      WAR_TRAUMA_PROFILE.shared,
      SHARED_FRAGMENTS,
      "war_trauma profile must hold a reference to the same SHARED_FRAGMENTS constant, not a copy",
    );
  });
});
