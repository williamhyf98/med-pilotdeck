/**
 * Build an `EdgeClawMemoryProvider` from `PilotMemoryConfig` + project root.
 * The factory is intentionally small — it just constructs the underlying
 * `EdgeClawMemoryService` with a sensible default rootDir and forwards the
 * relevant config fields.
 *
 * Returns `undefined` when the config is missing or `enabled === false`.
 *
 * Behavior parity goals:
 *   - The provider lives at the per-project scope (one DB per project root).
 *   - Typed system projects store data under
 *     `$PILOT_HOME/memory/<typeKey>/<projectId>/` (not path-hash workspaces/).
 *   - When `config.rootDir` is set we pin the memory root there; otherwise
 *     we use `$PILOT_HOME/memory`.
 *   - `apiKey` for the LLM extractor is **lazily forwarded** — the user is
 *     expected to set it through env or pilotdeck.yaml; we never default
 *     credentials to anything other than what the user supplied.
 */

import { join } from "node:path";
import { EdgeClawMemoryService, type EdgeClawMemoryLlmOptions } from "edgeclaw-memory-core";
import { EdgeClawMemoryProvider } from "./EdgeClawMemoryProvider.js";
import type { ModelConfig, ModelProtocol } from "../../model/protocol/canonical.js";
import type { PilotMemoryConfig } from "../../pilot/config/types.js";
import {
  getPilotMemoryRootDir,
  resolvePilotHome,
  resolveProjectMemoryDataDir,
} from "../../pilot/paths.js";
import type { TelemetryClient } from "../../telemetry/index.js";

export type CreateEdgeClawMemoryProviderOptions = {
  config: PilotMemoryConfig | undefined;
  modelConfig?: ModelConfig;
  /** Fallback model ref ("provider/model") when memory.model is not set. */
  agentModel?: string;
  projectRoot: string;
  /** Optional Pilot home; defaults to `resolvePilotHome(process.env)`. */
  pilotHome?: string;
  /** Optional logger forwarded to the underlying service. */
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  /** Optional `now` for deterministic tests. */
  now?: () => Date;
  telemetry?: TelemetryClient;
};

export function createEdgeClawMemoryProviderFromConfig(
  options: CreateEdgeClawMemoryProviderOptions,
): { provider: EdgeClawMemoryProvider; service: EdgeClawMemoryService } | undefined {
  const cfg = options.config;
  if (!cfg || cfg.enabled !== true) return undefined;
  if (cfg.provider !== "edgeclaw") return undefined;

  const pilotHome = options.pilotHome ?? resolvePilotHome(process.env);
  const memoryRoot = cfg.rootDir ?? getPilotMemoryRootDir(pilotHome);
  const workspaceDir = options.projectRoot;
  const dataDir = resolveProjectMemoryDataDir(workspaceDir, pilotHome);

  const llm = resolveMemoryLlm(cfg, options.modelConfig, options.agentModel);

  const service = new EdgeClawMemoryService({
    workspaceDir,
    rootDir: memoryRoot,
    dbPath: join(dataDir, "control.sqlite"),
    memoryDir: join(dataDir, "memory"),
    captureStrategy: cfg.captureStrategy,
    includeAssistant: cfg.includeAssistant,
    maxMessageChars: cfg.maxMessageChars,
    heartbeatBatchSize: cfg.heartbeatBatchSize,
    defaultIndexingSettings: cfg.schedule,
    source: "pilotdeck",
    logger: options.logger,
    llm,
    runtime: options.telemetry ? { telemetry: options.telemetry } : undefined,
  });

  const provider = new EdgeClawMemoryProvider({
    service,
    source: "pilotdeck",
    now: options.now,
    telemetry: options.telemetry,
  });

  return { provider, service };
}

function resolveMemoryLlm(
  cfg: PilotMemoryConfig,
  modelConfig?: ModelConfig,
  agentModel?: string,
): EdgeClawMemoryLlmOptions | undefined {
  const modelRef = cfg.model || agentModel;
  if (!modelRef) return undefined;

  const sep = modelRef.indexOf("/");
  if (sep < 0) return undefined;

  const providerId = modelRef.slice(0, sep);
  const modelId = modelRef.slice(sep + 1);
  const providerEntry = modelConfig?.providers[providerId];

  const llm: EdgeClawMemoryLlmOptions = {
    provider: providerId,
    model: modelId,
    baseUrl: providerEntry?.url,
    apiKey: providerEntry?.apiKey,
  };
  const apiType = cfg.apiType ?? memoryApiTypeForProtocol(providerEntry?.protocol);
  if (apiType !== undefined) {
    llm.apiType = apiType as EdgeClawMemoryLlmOptions["apiType"];
  }
  return llm;
}

function memoryApiTypeForProtocol(protocol: ModelProtocol | undefined): PilotMemoryConfig["apiType"] | "openai-completions" | undefined {
  if (protocol === "anthropic" || protocol === "google") return protocol;
  if (protocol === "openai-responses") return "openai-responses";
  if (protocol === "openai") return "openai-completions";
  return undefined;
}
