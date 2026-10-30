import type { CanonicalThinkingConfig } from "../../model/index.js";

export type AgentModelControls = {
  provider?: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
  seed?: number;
  thinking?: CanonicalThinkingConfig;
};

export type AgentToolPolicy = {
  /** Optional allow-list. When present, tools outside the list are unavailable. */
  allowedTools?: string[];
  /** Deny-list always wins over an allow-list. */
  deniedTools?: string[];
};

/**
 * Client-visible, per-turn execution controls. This deliberately has no
 * endpoint, credential, header, or system-prompt fields.
 */
export type AgentTurnOverrides = AgentModelControls & AgentToolPolicy & {
  metadata?: Record<string, unknown>;
};

export type AgentProfileSource = {
  pluginName: string;
  pluginSource: "builtin" | "global" | "project";
  path: string;
};

/**
 * A server-loaded profile. `systemContext` is trusted because it can only
 * originate from a local plugin file, never from GatewaySubmitTurnInput.
 */
export type AgentProfile = AgentTurnOverrides & {
  id: string;
  displayName?: string;
  description?: string;
  systemContext?: string;
  source?: AgentProfileSource;
};

export type AgentProfileResolver = {
  get(id: string): AgentProfile | undefined;
};

export type ResolvedAgentTurnExecution = AgentModelControls & AgentToolPolicy & {
  profileId?: string;
  systemContext?: string;
  metadata?: Record<string, unknown>;
  /** Forces the router to honor the resolved provider/model for this turn. */
  explicitModelSelection: boolean;
};
