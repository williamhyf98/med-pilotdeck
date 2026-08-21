import type { PilotDeckToolDefinition } from "./protocol/types.js";

export function requiresPromptCapability(
  tool: PilotDeckToolDefinition,
  input: unknown,
): boolean {
  try {
    return tool.requiresUserInteraction?.(input as never) === true;
  } catch {
    return false;
  }
}
