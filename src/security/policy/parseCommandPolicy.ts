import { policyIds, policyList, policyRecord, policyRoots } from "./schema.js";
import { DOCUMENT_COMMAND_SPECS } from "./documentCommandSpecs.js";

export type TaskReadRoot = "inbox" | "scratch" | "exports";
export type TaskWriteRoot = "scratch" | "exports";

export type CommandRule = Readonly<{
  id: string;
  enabled: boolean;
  allowedOptions: readonly string[];
  inputRoots: readonly TaskReadRoot[];
  outputRoots: readonly TaskWriteRoot[];
  writable: boolean;
  networkRuleIds: readonly string[];
  timeoutMs: number;
}>;

export type CommandPolicy = Readonly<{
  version: 1;
  mode: "registered_only";
  commands: readonly CommandRule[];
}>;

type CommandCeiling = Readonly<{
  options: readonly string[];
  inputRoots: readonly TaskReadRoot[];
  outputRoots: readonly TaskWriteRoot[];
  maxTimeoutMs: number;
}>;

const READ_ROOTS = ["inbox", "scratch", "exports"] as const;
const WRITE_ROOTS = ["scratch", "exports"] as const;
const WORKSPACE_INSPECT: CommandCeiling = {
  options: [], inputRoots: READ_ROOTS,
  outputRoots: [], maxTimeoutMs: 10_000,
};

function freezeRegistry(entries: Record<string, CommandCeiling>): Readonly<Record<string, CommandCeiling>> {
  for (const entry of Object.values(entries)) {
    Object.freeze(entry.options);
    Object.freeze(entry.inputRoots);
    Object.freeze(entry.outputRoots);
    Object.freeze(entry);
  }
  return Object.freeze(entries);
}

/** IDs only: these descriptors cannot be replaced by administrator YAML. */
export const REGISTERED_COMMANDS: Readonly<Record<string, CommandCeiling>> = freezeRegistry({
  "workspace.pwd": { options: [], inputRoots: [], outputRoots: [], maxTimeoutMs: 10_000 },
  "workspace.list": WORKSPACE_INSPECT,
  "workspace.stat": WORKSPACE_INSPECT,
  "workspace.find": WORKSPACE_INSPECT,
  ...Object.fromEntries(Object.entries(DOCUMENT_COMMAND_SPECS).map(([id, options]) => [id, {
    options: Object.keys(options),
    inputRoots: READ_ROOTS,
    outputRoots: Object.values(options).includes("output") ? WRITE_ROOTS : [],
    maxTimeoutMs: 600_000,
  }])),
});

export function parseCommandPolicy(value: unknown): CommandPolicy {
  if (value === undefined) {
    return {
      version: 1, mode: "registered_only",
      commands: Object.entries(REGISTERED_COMMANDS).map(([id, ceiling]) => ({
        id, enabled: true, allowedOptions: [...ceiling.options],
        inputRoots: [...ceiling.inputRoots], outputRoots: [...ceiling.outputRoots],
        writable: ceiling.outputRoots.length > 0, networkRuleIds: [], timeoutMs: ceiling.maxTimeoutMs,
      })),
    };
  }
  const record = policyRecord(value, "commandPolicy", ["version", "mode", "commands"]);
  if (record.version !== 1 || record.mode !== "registered_only") {
    throw new Error("commandPolicy requires version 1 and mode registered_only.");
  }
  const seen = new Set<string>();
  const commands = policyList(record.commands, "commandPolicy.commands").map((raw, index): CommandRule => {
    const path = `commandPolicy.commands[${index}]`;
    const entry = policyRecord(raw, path, [
      "id", "enabled", "allowedOptions", "inputRoots", "outputRoots", "writable", "networkRuleIds", "timeoutMs",
    ]);
    const id = entry.id;
    if (typeof id !== "string" || !Object.hasOwn(REGISTERED_COMMANDS, id) || seen.has(id)) {
      throw new Error(`${path}.id is not a unique registered command.`);
    }
    seen.add(id);
    const ceiling = REGISTERED_COMMANDS[id]!;
    if (typeof entry.enabled !== "boolean" || typeof entry.writable !== "boolean") {
      throw new Error(`${path} requires boolean enabled and writable values.`);
    }
    const options = policyList(entry.allowedOptions, `${path}.allowedOptions`, 40);
    if (options.some((option) => typeof option !== "string" || !ceiling.options.includes(option))
      || new Set(options).size !== options.length) {
      throw new Error(`${path}.allowedOptions is wider than the system registry.`);
    }
    const inputRoots = policyRoots(entry.inputRoots, `${path}.inputRoots`, READ_ROOTS);
    const outputRoots = policyRoots(entry.outputRoots, `${path}.outputRoots`, WRITE_ROOTS);
    if (inputRoots.some((root) => !ceiling.inputRoots.includes(root))
      || outputRoots.some((root) => !ceiling.outputRoots.includes(root))
      || (entry.writable && outputRoots.length === 0)) {
      throw new Error(`${path} exceeds registered input/output permissions.`);
    }
    const networkRuleIds = policyIds(entry.networkRuleIds, `${path}.networkRuleIds`);
    if (networkRuleIds.length > 0) {
      throw new Error(`${path}.networkRuleIds cannot grant network to a command not registered for it.`);
    }
    if (!Number.isSafeInteger(entry.timeoutMs) || (entry.timeoutMs as number) < 1
      || (entry.timeoutMs as number) > ceiling.maxTimeoutMs) {
      throw new Error(`${path}.timeoutMs exceeds the registered time limit.`);
    }
    return {
      id, enabled: entry.enabled, allowedOptions: options as string[], inputRoots, outputRoots,
      writable: entry.writable, networkRuleIds, timeoutMs: entry.timeoutMs as number,
    };
  });
  return { version: 1, mode: "registered_only", commands };
}
