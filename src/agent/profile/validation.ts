import { AgentRuntimeError } from "../protocol/errors.js";
import type {
  AgentModelControls,
  AgentProfile,
  AgentProfileResolver,
  AgentProfileSource,
  AgentToolPolicy,
  AgentTurnOverrides,
  ResolvedAgentTurnExecution,
} from "./types.js";

export const MAX_AGENT_PROFILE_SYSTEM_CONTEXT_CHARS = 32_768;
export const MAX_AGENT_TURN_METADATA_BYTES = 4_096;

const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_ARRAY_LENGTH = 32;
const MAX_METADATA_STRING_CHARS = 512;
const MAX_TOOL_POLICY_ENTRIES = 128;
const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const TOOL_NAME_PATTERN = /^[^\s]{1,128}$/u;
const THINKING_MODES = new Set([
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const TURN_OVERRIDE_KEYS = new Set([
  "provider",
  "model",
  "maxOutputTokens",
  "temperature",
  "topP",
  "topK",
  "minP",
  "presencePenalty",
  "frequencyPenalty",
  "repetitionPenalty",
  "seed",
  "thinking",
  "allowedTools",
  "deniedTools",
  "metadata",
]);
const FORBIDDEN_METADATA_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "apiKey",
  "api_key",
  "baseUrl",
  "baseURL",
  "apiBase",
  "headers",
  "explicitProvider",
  "explicitModel",
]);

export type ResolveAgentTurnExecutionInput = {
  base: AgentModelControls;
  profileId?: unknown;
  turnOverrides?: unknown;
  profiles?: AgentProfileResolver;
  availableToolNames: readonly string[];
  isModelAvailable?: (provider: string, model: string) => boolean;
  getModelMaxOutputTokens?: (provider: string, model: string) => number | undefined;
};

export function parseAgentTurnOverrides(value: unknown): AgentTurnOverrides {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    invalidProfile("turnOverrides must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (!TURN_OVERRIDE_KEYS.has(key)) {
      invalidProfile(`turnOverrides.${key} is not allowed.`);
    }
  }

  const output: AgentTurnOverrides = {};
  output.provider = optionalIdentifier(value.provider, "turnOverrides.provider");
  output.model = optionalIdentifier(value.model, "turnOverrides.model", 256);
  output.maxOutputTokens = optionalInteger(value.maxOutputTokens, "turnOverrides.maxOutputTokens", 1, 1_000_000);
  output.temperature = optionalNumber(value.temperature, "turnOverrides.temperature", 0, 2);
  output.topP = optionalNumber(value.topP, "turnOverrides.topP", 0, 1);
  output.topK = optionalInteger(value.topK, "turnOverrides.topK", 1, 1_000);
  output.minP = optionalNumber(value.minP, "turnOverrides.minP", 0, 1);
  output.presencePenalty = optionalNumber(value.presencePenalty, "turnOverrides.presencePenalty", -2, 2);
  output.frequencyPenalty = optionalNumber(value.frequencyPenalty, "turnOverrides.frequencyPenalty", -2, 2);
  output.repetitionPenalty = optionalNumber(value.repetitionPenalty, "turnOverrides.repetitionPenalty", 0.000_001, 2);
  output.seed = optionalInteger(value.seed, "turnOverrides.seed", -2_147_483_648, 2_147_483_647);
  output.thinking = parseThinking(value.thinking, "turnOverrides.thinking");
  output.allowedTools = parseToolNames(value.allowedTools, "turnOverrides.allowedTools");
  output.deniedTools = parseToolNames(value.deniedTools, "turnOverrides.deniedTools");
  output.metadata = value.metadata === undefined
    ? undefined
    : sanitizeAgentTurnMetadata(value.metadata, "turnOverrides.metadata");
  return compactUndefined(output);
}

export function parseMarkdownAgentProfile(
  frontmatter: unknown,
  systemContext: string,
  source?: AgentProfileSource,
): AgentProfile {
  if (!isRecord(frontmatter)) {
    invalidProfile("Agent profile frontmatter must be an object.");
  }
  for (const key of Object.keys(frontmatter)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) {
      invalidProfile(`Agent profile field ${key} is not allowed.`);
    }
  }

  const idValue = frontmatter.id ?? frontmatter.name;
  if (typeof idValue !== "string" || !PROFILE_ID_PATTERN.test(idValue.trim())) {
    invalidProfile("Agent profile requires a valid id or name.");
  }
  if (systemContext.length > MAX_AGENT_PROFILE_SYSTEM_CONTEXT_CHARS) {
    invalidProfile(
      `Agent profile system context exceeds ${MAX_AGENT_PROFILE_SYSTEM_CONTEXT_CHARS} characters.`,
    );
  }

  const rawControls: Record<string, unknown> = {};
  for (const key of TURN_OVERRIDE_KEYS) {
    if (key in frontmatter) rawControls[key] = frontmatter[key];
  }
  if (rawControls.allowedTools === undefined && frontmatter.tools !== undefined) {
    rawControls.allowedTools = normalizeProfileToolList(frontmatter.tools);
  }
  if (rawControls.maxOutputTokens === undefined && frontmatter.max_tokens !== undefined) {
    rawControls.maxOutputTokens = frontmatter.max_tokens;
  }
  if (typeof rawControls.thinking === "string" || typeof rawControls.thinking === "boolean") {
    rawControls.thinking = normalizeProfileThinking(rawControls.thinking);
  }

  let provider = rawControls.provider;
  let model = rawControls.model;
  if (provider === undefined && typeof model === "string") {
    const separator = model.indexOf("/");
    if (separator > 0 && separator < model.length - 1) {
      provider = model.slice(0, separator);
      model = model.slice(separator + 1);
    }
  }
  rawControls.provider = provider;
  rawControls.model = model;

  const controls = parseAgentTurnOverrides(rawControls);
  const displayName = optionalText(
    frontmatter.displayName ?? frontmatter.name ?? idValue,
    "Agent profile displayName",
    128,
  );
  const description = optionalText(frontmatter.description, "Agent profile description", 1_024);
  const trimmedContext = systemContext.trim();
  return compactUndefined({
    id: idValue.trim(),
    displayName,
    description,
    ...controls,
    systemContext: trimmedContext || undefined,
    source,
  });
}

export function resolveAgentTurnExecution(
  input: ResolveAgentTurnExecutionInput,
): ResolvedAgentTurnExecution {
  const profileId = parseProfileId(input.profileId);
  const profile = resolveProfile(profileId, input.profiles);
  const profileControls = profile ? controlsFromProfile(profile) : {};
  const turnOverrides = parseAgentTurnOverrides(input.turnOverrides);
  const provider = turnOverrides.provider ?? profileControls.provider ?? input.base.provider;
  const model = turnOverrides.model ?? profileControls.model ?? input.base.model;
  if (!provider || !model) {
    invalidProfile("A resolved agent turn must have both provider and model.");
  }

  const explicitModelSelection = Boolean(
    profileControls.provider
      || profileControls.model
      || turnOverrides.provider
      || turnOverrides.model,
  );
  if (
    explicitModelSelection
    && !(input.isModelAvailable?.(provider, model)
      ?? (provider === input.base.provider && model === input.base.model))
  ) {
    invalidProfile(`Unknown or unavailable model ${provider}/${model}.`);
  }

  const maxOutputTokens =
    turnOverrides.maxOutputTokens
    ?? profileControls.maxOutputTokens
    ?? input.base.maxOutputTokens;
  const modelMax = input.getModelMaxOutputTokens?.(provider, model);
  if (maxOutputTokens !== undefined && modelMax !== undefined && maxOutputTokens > modelMax) {
    invalidProfile(
      `maxOutputTokens ${maxOutputTokens} exceeds ${provider}/${model}'s server limit ${modelMax}.`,
    );
  }

  const availableTools = new Set(input.availableToolNames);
  assertKnownTools(profileControls, availableTools, "profile");
  assertKnownTools(turnOverrides, availableTools, "turnOverrides");
  const allowedTools = intersectOptionalLists(
    profileControls.allowedTools,
    turnOverrides.allowedTools,
  );
  const deniedTools = unionOptionalLists(
    profileControls.deniedTools,
    turnOverrides.deniedTools,
  );
  const denied = new Set(deniedTools);
  const effectiveAllowedTools = allowedTools?.filter((name) => !denied.has(name));

  return compactUndefined({
    profileId,
    provider,
    model,
    maxOutputTokens,
    temperature: turnOverrides.temperature ?? profileControls.temperature ?? input.base.temperature,
    topP: turnOverrides.topP ?? profileControls.topP ?? input.base.topP,
    topK: turnOverrides.topK ?? profileControls.topK ?? input.base.topK,
    minP: turnOverrides.minP ?? profileControls.minP ?? input.base.minP,
    presencePenalty:
      turnOverrides.presencePenalty
      ?? profileControls.presencePenalty
      ?? input.base.presencePenalty,
    frequencyPenalty:
      turnOverrides.frequencyPenalty
      ?? profileControls.frequencyPenalty
      ?? input.base.frequencyPenalty,
    repetitionPenalty:
      turnOverrides.repetitionPenalty
      ?? profileControls.repetitionPenalty
      ?? input.base.repetitionPenalty,
    seed: turnOverrides.seed ?? profileControls.seed ?? input.base.seed,
    thinking: turnOverrides.thinking ?? profileControls.thinking ?? input.base.thinking,
    systemContext: profile?.systemContext,
    allowedTools: effectiveAllowedTools,
    deniedTools: deniedTools.length > 0 ? deniedTools : undefined,
    metadata: mergeMetadata(profileControls.metadata, turnOverrides.metadata),
    explicitModelSelection,
  });
}

export function sanitizeAgentTurnMetadata(
  value: unknown,
  path = "metadata",
): Record<string, unknown> {
  if (!isRecord(value)) {
    invalidProfile(`${path} must be an object.`);
  }
  let entries = 0;
  const sanitized = sanitizeMetadataValue(value, path, 0, () => {
    entries += 1;
    if (entries > MAX_METADATA_ENTRIES) {
      invalidProfile(`${path} exceeds ${MAX_METADATA_ENTRIES} total entries.`);
    }
  }) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > MAX_AGENT_TURN_METADATA_BYTES) {
    invalidProfile(`${path} exceeds ${MAX_AGENT_TURN_METADATA_BYTES} bytes.`);
  }
  return sanitized;
}

function controlsFromProfile(profile: AgentProfile): AgentTurnOverrides {
  return parseAgentTurnOverrides({
    provider: profile.provider,
    model: profile.model,
    maxOutputTokens: profile.maxOutputTokens,
    temperature: profile.temperature,
    topP: profile.topP,
    topK: profile.topK,
    minP: profile.minP,
    presencePenalty: profile.presencePenalty,
    frequencyPenalty: profile.frequencyPenalty,
    repetitionPenalty: profile.repetitionPenalty,
    seed: profile.seed,
    thinking: profile.thinking,
    allowedTools: profile.allowedTools,
    deniedTools: profile.deniedTools,
    metadata: profile.metadata,
  });
}

function resolveProfile(
  profileId: string | undefined,
  profiles: AgentProfileResolver | undefined,
): AgentProfile | undefined {
  if (!profileId) return undefined;
  const profile = profiles?.get(profileId);
  if (!profile) {
    invalidProfile(`Unknown agent profile ${profileId}.`);
  }
  return profile;
}

function parseProfileId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value.trim())) {
    invalidProfile("profile must be a valid server-registered profile id.");
  }
  return value.trim();
}

function assertKnownTools(
  policy: AgentToolPolicy,
  available: Set<string>,
  path: string,
): void {
  // An allow-list can expand the model-visible surface and therefore must
  // reference a tool that is actually registered. A deny-list only narrows
  // capability, so retaining names for optional/disabled tools is safe and
  // lets one profile work across deployments with different tool sets.
  for (const name of policy.allowedTools ?? []) {
    if (!available.has(name)) {
      invalidProfile(`${path} references unavailable tool ${name}.`);
    }
  }
}

function intersectOptionalLists(
  left: string[] | undefined,
  right: string[] | undefined,
): string[] | undefined {
  if (!left) return right ? [...right] : undefined;
  if (!right) return [...left];
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function unionOptionalLists(left: string[] | undefined, right: string[] | undefined): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])])];
}

function mergeMetadata(
  profile: Record<string, unknown> | undefined,
  turn: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!profile && !turn) return undefined;
  const merged = { ...(profile ?? {}), ...(turn ?? {}) };
  // Privacy controls are monotonic: a server-owned profile can disable
  // memory, while an untrusted per-turn metadata object can never re-enable
  // retrieval or capture for that profile.
  if (profile?.memoryPolicy === "disabled") {
    merged.memoryPolicy = "disabled";
  }
  return sanitizeAgentTurnMetadata(merged);
}

function parseThinking(value: unknown, path: string): AgentTurnOverrides["thinking"] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    invalidProfile(`${path} must be an object with an enabled boolean.`);
  }
  const mode = value.mode;
  if (mode !== undefined && (typeof mode !== "string" || !THINKING_MODES.has(mode))) {
    invalidProfile(`${path}.mode is invalid.`);
  }
  const budgetTokens = optionalInteger(value.budgetTokens, `${path}.budgetTokens`, 0, 1_000_000);
  for (const key of Object.keys(value)) {
    if (!["enabled", "mode", "budgetTokens", "preserve", "splitReasoning"].includes(key)) {
      invalidProfile(`${path}.${key} is not allowed.`);
    }
  }
  if (value.preserve !== undefined && typeof value.preserve !== "boolean") {
    invalidProfile(`${path}.preserve must be a boolean.`);
  }
  if (value.splitReasoning !== undefined && typeof value.splitReasoning !== "boolean") {
    invalidProfile(`${path}.splitReasoning must be a boolean.`);
  }
  return compactUndefined({
    enabled: value.enabled,
    mode: mode as NonNullable<AgentTurnOverrides["thinking"]>["mode"],
    budgetTokens,
    preserve: value.preserve as boolean | undefined,
    splitReasoning: value.splitReasoning as boolean | undefined,
  });
}

function normalizeProfileThinking(value: string | boolean): Record<string, unknown> {
  if (typeof value === "boolean") return { enabled: value };
  const mode = value.trim();
  return { enabled: mode !== "off", mode };
}

function normalizeProfileToolList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseToolNames(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TOOL_POLICY_ENTRIES) {
    invalidProfile(`${path} must be a list of at most ${MAX_TOOL_POLICY_ENTRIES} tool names.`);
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !TOOL_NAME_PATTERN.test(item)) {
      invalidProfile(`${path} contains an invalid tool name.`);
    }
    if (!names.includes(item)) names.push(item);
  }
  return names;
}

function sanitizeMetadataValue(
  value: unknown,
  path: string,
  depth: number,
  onEntry: () => void,
): unknown {
  if (depth > MAX_METADATA_DEPTH) {
    invalidProfile(`${path} exceeds maximum depth ${MAX_METADATA_DEPTH}.`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidProfile(`${path} must contain finite numbers.`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_METADATA_STRING_CHARS) {
      invalidProfile(`${path} string exceeds ${MAX_METADATA_STRING_CHARS} characters.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ARRAY_LENGTH) {
      invalidProfile(`${path} arrays are limited to ${MAX_METADATA_ARRAY_LENGTH} items.`);
    }
    return value.map((item, index) => {
      onEntry();
      return sanitizeMetadataValue(item, `${path}[${index}]`, depth + 1, onEntry);
    });
  }
  if (!isRecord(value)) {
    invalidProfile(`${path} contains a non-JSON value.`);
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || key.length > 64 || FORBIDDEN_METADATA_KEYS.has(key)) {
      invalidProfile(`${path} contains forbidden or invalid key ${key}.`);
    }
    onEntry();
    output[key] = sanitizeMetadataValue(item, `${path}.${key}`, depth + 1, onEntry);
  }
  return output;
}

function optionalIdentifier(value: unknown, path: string, maxLength = 128): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    invalidProfile(`${path} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalText(value: unknown, path: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    invalidProfile(`${path} must be a string of at most ${maxLength} characters.`);
  }
  return value.trim() || undefined;
}

function optionalInteger(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number | undefined {
  const parsed = optionalNumber(value, path, min, max);
  if (parsed !== undefined && !Number.isInteger(parsed)) {
    invalidProfile(`${path} must be an integer.`);
  }
  return parsed;
}

function optionalNumber(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    invalidProfile(`${path} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidProfile(message: string): never {
  throw new AgentRuntimeError("agent_invalid_profile", message);
}
