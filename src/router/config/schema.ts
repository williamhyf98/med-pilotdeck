import type { ModelConfig } from "../../model/index.js";
import type { RouterScenarioType } from "../protocol/decision.js";
import type { RouterModelPricingMap } from "../utils/modelPricing.js";

export type RouterModelRef = {
  /** Original "provider/model" string. */
  id: string;
  provider: string;
  model: string;
};

export type RouterScenariosConfig = {
  default: RouterModelRef;
};

export type RouterTierConfig = {
  model: RouterModelRef;
  description?: string;
};

export type RouterTokenSaverSubagentPolicy = "skip" | "judge";

export const DEFAULT_SUBAGENT_POLICY: RouterTokenSaverSubagentPolicy = "judge";

export type RouterTokenSaverConfig = {
  enabled: boolean;
  judge: RouterModelRef;
  defaultTier: string;
  tiers: Record<string, RouterTierConfig>;
  rules?: string[];
  subagent?: {
    policy: RouterTokenSaverSubagentPolicy;
  };
  judgeTimeoutMs: number;
  /**
   * Preserve the session's current model when its cache-read input cost is
   * cheaper than switching models and re-prefilling the full prompt.
   */
  cacheAwareSwitching?: { enabled: boolean; minSavingsRatio: number };
};

export type RouterAutoOrchestrateConfig = {
  enabled: boolean;
  skillExtensionId?: string;
  /** Inline orchestration prompt injected when skillExtensionId is absent. */
  orchestrationPrompt?: string;
  triggerTiers: string[];
  /** Whitelist — only these tools are kept for the orchestrator. Takes precedence over blockedTools. */
  allowedTools?: string[];
  /** Blacklist — these tools are removed. Ignored when allowedTools is set. */
  blockedTools?: string[];
  slimSystemPrompt: boolean;
  subagentMaxTokens?: number;
};

export type RouterStatsConfig = {
  enabled: boolean;
  modelPricing?: RouterModelPricingMap;
  /** Override the default ~/.pilotdeck/router/stats.json path (useful for tests). */
  filePath?: string;
  /** Provider/model ref used as the "no-router" baseline for savedCost calculation. */
  baselineModel?: { provider: string; model: string };
};

export type RouterFallbackConfig = Partial<Record<RouterScenarioType, RouterModelRef[]>> & {
  /** LiteLLM-compatible max fallback model groups to try after the primary model. Default 5. */
  maxFallbacks?: number;
};

export const LITELLM_ROUTER_MAX_FALLBACKS = 5;

export type RouterCustomRouterConfig = {
  extensionId: string;
};

export type RouterConfig = {
  /**
   * Master switch for all router behavior. When false, router-specific
   * model refs are ignored and requests pass through to agent.model.
   */
  enabled?: boolean;
  /**
   * Resolved scenario→model map.
   *
   * Optional at the *parse* boundary so a yaml that lists e.g. only
   * `router.tokenSaver.*` doesn't trip a fatal. `ensureRouterConfig` in
   * `src/cli/createLocalGateway.ts` always fills `scenarios.default` from
   * `agent.model` before the runtime sees the value, so callers downstream
   * of the gateway can keep treating it as required.
   */
  scenarios?: RouterScenariosConfig;
  fallback?: RouterFallbackConfig;
  zeroUsageRetry?: { enabled: boolean; maxAttempts: number };
  transientRetry?: { enabled: boolean; maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  tokenSaver?: RouterTokenSaverConfig;
  autoOrchestrate?: RouterAutoOrchestrateConfig;
  stats?: RouterStatsConfig;
  customRouter?: RouterCustomRouterConfig;
};

export const DEFAULT_JUDGE_TIMEOUT_MS = 15_000;
export const DEFAULT_ZERO_USAGE_MAX_ATTEMPTS = 2;
export const DEFAULT_TRIGGER_TIERS = ["complex"];

/**
 * Default 4-tier classification descriptions. COMPLEX is reserved for
 * coordinated multi-workstream tasks; ordinary multi-step work goes to REASONING.
 */
export const DEFAULT_TIER_DESCRIPTIONS: Record<string, string> = {
  simple: "Simple greetings, confirmations, single-step Q&A, trivial file writes, remembering rules",
  medium: "Single tool call, short text generation, 1-2 file read/write, code generation",
  complex: "Needs coordinated work across independent workstreams that can proceed in parallel",
  reasoning: "Deep single-agent work: multi-file operations, data analysis, multi-step workflows, structured reports from many sources",
};

export const DEFAULT_TIER_RULES: string[] = [
  "complex is ONLY for tasks that need coordinated parallel workstreams — do NOT use it for ordinary multi-step work",
  "Multi-file operations, data analysis, and multi-step workflows without orchestration should be reasoning",
  "Simple file creation (1-2 files) or single code generation is medium",
  "Trivial greetings, confirmations, remembering rules, or reading one file and answering a short question is simple",
];

export const DEFAULT_TIER_NAME = "medium";
export const DEFAULT_ALLOWED_TOOLS = [
  "read_file", "grep", "glob", "read_skill",
];
export const DEFAULT_BLOCKED_TOOLS: string[] = [];

export const DEFAULT_ORCHESTRATION_PROMPT = `# Orchestrator mode — plan and coordinate

You are an **orchestrator**, not an executor. This runtime does not register an
\`agent\` spawn tool. Plan in this conversation and execute with the local tools
you were given.

## Hard rules (tool whitelist enforced by router)

You may ONLY call:

- \`read_file\`  — read protocol / config / spec files for planning
- \`read_skill\` — read a skill definition by name (returns the full SKILL.md content)
- \`grep\`       — search for patterns across the codebase
- \`glob\`       — find files by name pattern

Everything else (\`bash\`, \`write_file\`, \`edit_file\`, …) is **blocked** for you
in orchestrator mode. Do the work yourself with those allowed tools, or explain
what is missing. Do not invent tool names such as \`agent\`, \`web_search\`, or
\`web_fetch\`.

## Workflow

1. **Check for relevant skills first.** If the system prompt contains \`<available-skills>\`,
   use \`read_skill\` to read the most relevant skill.
2. **Plan in 1-4 atomic steps** using local files and skills only.
3. **Execute** with the allowed tools in this same conversation.
4. **Final reply**: short summary pointing to deliverable file paths.

## Working directory

Always pass absolute paths.`;

export type ResolveProviderRefIssue = {
  code: string;
  path: string;
  message: string;
};

/**
 * Parse "provider/model" string into a structured ref and verify it exists in
 * the supplied ModelConfig. Returns either a valid ref or a list of issues
 * (caller is responsible for emitting them as PilotConfigDiagnostic).
 */
export function resolveProviderRef(
  raw: unknown,
  path: string,
  modelConfig: ModelConfig,
): { ref?: RouterModelRef; issues: ResolveProviderRefIssue[] } {
  const issues: ResolveProviderRefIssue[] = [];
  if (typeof raw !== "string" || raw.length === 0) {
    issues.push({
      code: "ROUTER_REF_INVALID",
      path,
      message: `${path} must be a non-empty provider/model string.`,
    });
    return { issues };
  }

  const separator = raw.indexOf("/");
  const provider = separator >= 0 ? raw.slice(0, separator) : "";
  const model = separator >= 0 ? raw.slice(separator + 1) : "";
  if (!provider || !model) {
    issues.push({
      code: "ROUTER_REF_FORMAT",
      path,
      message: `${path} must use provider/model format; got ${raw}.`,
    });
    return { issues };
  }

  const providerEntry = modelConfig.providers[provider];
  if (!providerEntry) {
    issues.push({
      code: "ROUTER_REF_PROVIDER_NOT_FOUND",
      path,
      message: `${path} references unknown provider ${provider}.`,
    });
    return { issues };
  }
  if (!providerEntry.models[model]) {
    issues.push({
      code: "ROUTER_REF_MODEL_NOT_FOUND",
      path,
      message: `${path} references unknown model ${model} for provider ${provider}.`,
    });
    return { issues };
  }

  return { ref: { id: raw, provider, model }, issues };
}
