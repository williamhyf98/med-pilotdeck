import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { PermissionResult } from "../../permission/index.js";
import { createSecurityPolicyStore } from "../../security/policy/PolicyStore.js";
import { resolveAppRoot } from "./bash/sandbox/bwrap.js";
import {
  evaluateStructuredCommand,
  type RegisteredBashCommand,
  type StructuredCommandValue,
} from "./bash/registeredCommands.js";
import {
  executeRegisteredCommand,
  type RegisteredExecutorOptions,
} from "./bash/registeredExecutor.js";
import {
  extractRegisteredArtifacts,
  normalizeRegisteredOutput,
} from "./bash/registeredArtifacts.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";
import type {
  PilotDeckToolInputSchema,
  PilotDeckToolValidationResult,
} from "../protocol/schema.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";

export type RegisteredDocumentMakeInput = {
  title?: string;
  body?: string;
  body_file_path?: string;
  markdown_path?: string;
  spec_path?: string;
  output_path: string;
  force?: boolean;
  timeout_ms?: number;
};

export type RegisteredDocumentMakeOutput = Readonly<Record<string, unknown>>;

type DocumentMakeConfig<Input extends RegisteredDocumentMakeInput> = Readonly<{
  name: string;
  alias: string;
  title: string;
  description: string;
  capability: string;
  inputSchema: PilotDeckToolInputSchema;
  outputSchema: Record<string, unknown>;
  outputMimeTypes: Readonly<Record<string, string>>;
  buildOptions(input: Input): Readonly<Record<string, StructuredCommandValue>>;
  validateExtra?(input: Input): Array<{
    path: string;
    code: "invalid_schema";
    message: string;
  }>;
  successStatuses?: readonly string[];
}>;

export type CreateRegisteredDocumentMakeToolOptions = RegisteredExecutorOptions;

const MAX_DOCUMENT_TIMEOUT_MS = 600_000;

/**
 * Creates the model-facing side of a registered document Skill.
 *
 * The model submits typed values. This adapter is the only layer that turns
 * them into the legacy Skill argv, so the shell-shaped compatibility surface
 * does not become part of the Agent contract.
 */
export function createRegisteredDocumentMakeTool<
  Input extends RegisteredDocumentMakeInput,
>(
  config: DocumentMakeConfig<Input>,
  options: CreateRegisteredDocumentMakeToolOptions = {},
): PilotDeckToolDefinition<Input, RegisteredDocumentMakeOutput> {
  return {
    name: config.name,
    aliases: [config.alias],
    title: config.title,
    description: config.description,
    kind: "custom",
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    maxResultBytes: 200_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: (input) => input.force === true,
    isOpenWorld: () => false,
    validateInput: async (input) => validateDocumentMakeInput(input, config),
    checkPermissions: async (input, context) => checkDocumentMakePermissions(input, context, config),
    execute: async (input, context) => executeDocumentMake(input, context, config, options),
  };
}

async function validateDocumentMakeInput<Input extends RegisteredDocumentMakeInput>(
  input: Input,
  config: DocumentMakeConfig<Input>,
): Promise<PilotDeckToolValidationResult> {
  const issues: Array<{ path: string; code: "invalid_schema"; message: string }> = [];
  const extension = extname(input.output_path).toLowerCase();
  if (!config.outputMimeTypes[extension]) {
    issues.push({
      path: "output_path",
      code: "invalid_schema",
      message: `output_path must end with one of ${Object.keys(config.outputMimeTypes).join(", ")}.`,
    });
  }
  if (
    input.timeout_ms !== undefined
    && (!Number.isSafeInteger(input.timeout_ms)
      || input.timeout_ms < 1
      || input.timeout_ms > MAX_DOCUMENT_TIMEOUT_MS)
  ) {
    issues.push({
      path: "timeout_ms",
      code: "invalid_schema",
      message: `timeout_ms must be between 1 and ${MAX_DOCUMENT_TIMEOUT_MS}.`,
    });
  }

  const contentSources = [
    input.body,
    input.body_file_path,
    input.markdown_path,
    input.spec_path,
  ].filter((value) => value !== undefined);
  if (contentSources.length > 1) {
    issues.push({
      path: "body",
      code: "invalid_schema",
      message: "body, body_file_path, markdown_path, and spec_path are mutually exclusive.",
    });
  }
  issues.push(...(config.validateExtra?.(input) ?? []));
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, input };
}

function checkDocumentMakePermissions<Input extends RegisteredDocumentMakeInput>(
  input: Input,
  context: PilotDeckToolRuntimeContext,
  config: DocumentMakeConfig<Input>,
): PermissionResult {
  try {
    resolveDocumentMakeCommand(input, context, config);
    return {
      type: "allow",
      reason: {
        type: "safety",
        message: `Registered ${config.capability} capability is enabled.`,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "deny", reason: { type: "safety", message }, message };
  }
}

async function executeDocumentMake<Input extends RegisteredDocumentMakeInput>(
  input: Input,
  context: PilotDeckToolRuntimeContext,
  config: DocumentMakeConfig<Input>,
  options: CreateRegisteredDocumentMakeToolOptions,
): Promise<PilotDeckToolExecutionOutput<RegisteredDocumentMakeOutput>> {
  const registered = resolveDocumentMakeCommand(input, context, config);
  if (registered.kind !== "script") {
    throw new PilotDeckToolRuntimeError(
      "automation_policy_violation",
      `${config.capability} did not resolve to a registered Skill script.`,
    );
  }

  const result = await executeRegisteredCommand(
    registered.file,
    registered.args,
    registered.timeoutMs,
    context,
    {
      ...options,
      timeoutMs: input.timeout_ms,
      toolName: config.name,
    },
  );
  if (result.outputLimitExceeded) {
    throw new PilotDeckToolRuntimeError(
      "result_too_large",
      `${config.title} Skill output exceeded the configured limit.`,
    );
  }
  if (result.timedOut) {
    throw new PilotDeckToolRuntimeError(
      "tool_timeout",
      `${config.title} timed out after ${input.timeout_ms ?? 30_000}ms.`,
    );
  }
  if (result.exitCode !== 0) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `${config.title} Skill failed with exit code ${result.exitCode ?? "null"}: ${result.stderr || result.stdout}`,
      { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
    );
  }

  const normalized = normalizeRegisteredOutput(result.stdout, context.cwd);
  const payload = parseJsonPayload(normalized);
  const successStatuses = config.successStatuses ?? ["ok"];
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || typeof (payload as Record<string, unknown>).output !== "string"
    || !successStatuses.includes(String((payload as Record<string, unknown>).status))
  ) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `${config.title} Skill returned an invalid success payload.`,
      { stdout: normalized, stderr: result.stderr },
    );
  }

  const output = resolvePilotDeckWorkspacePath(input.output_path, context, {
    forWrite: true,
    mustExist: true,
  });
  if (!output.ok) {
    throw new PilotDeckToolRuntimeError(output.error.code, output.error.message, output.error.details);
  }
  const outputStat = await stat(output.absolutePath).catch(() => undefined);
  if (!outputStat?.isFile()) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `${config.title} Skill did not create the requested output: ${output.relativePath}`,
    );
  }

  const artifacts = extractRegisteredArtifacts(result.stdout, context.cwd);
  if (!artifacts.some((artifact) => artifact.path === output.relativePath && artifact.role === "final")) {
    artifacts.unshift({
      path: output.relativePath,
      role: "final",
      mimeType: config.outputMimeTypes[extname(output.relativePath).toLowerCase()],
      description: config.title,
    });
  }
  return {
    content: [
      {
        type: "file",
        path: output.relativePath,
        mimeType: config.outputMimeTypes[extname(output.relativePath).toLowerCase()],
        description: config.title,
      },
      { type: "json", value: payload },
    ],
    artifacts,
    data: payload as RegisteredDocumentMakeOutput,
    metadata: {
      capability: config.capability,
      durationMs: result.durationMs,
      ...(result.stderr ? { stderr: result.stderr } : {}),
    },
  };
}

function resolveDocumentMakeCommand<Input extends RegisteredDocumentMakeInput>(
  input: Input,
  context: PilotDeckToolRuntimeContext,
  config: DocumentMakeConfig<Input>,
): Extract<RegisteredBashCommand, { kind: "script" }> {
  const values: Record<string, StructuredCommandValue> = {
    ...config.buildOptions(input),
    "--out": input.output_path,
    ...(input.force ? { "--force": true } : {}),
  };
  const policy = createSecurityPolicyStore({ env: context.env }).getSnapshot().commands;
  const registered = evaluateStructuredCommand(config.capability, values, {
    cwd: context.cwd,
    appRoot: resolveAppRoot(),
    policy,
    workDir: context.env?.PILOTDECK_WORK_DIR,
  });
  if (registered.kind !== "script") {
    throw new Error(`${config.capability} did not resolve to a registered Skill script.`);
  }
  return registered;
}

function parseJsonPayload(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    for (const line of trimmed.split(/\r?\n/u).reverse()) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isRecord(parsed)) return parsed;
      } catch {
        // Keep looking for the final machine-readable line.
      }
    }
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

