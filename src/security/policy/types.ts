/** The three data directories of one task. Service-managed paths are not Agent capabilities. */
export type PilotDeckTaskRoots = Readonly<{
  workspace: string;
  inbox: string;
  scratch: string;
  exports: string;
}>;

export type PilotDeckCapability =
  | { kind: "task.read"; root: "inbox" | "scratch" | "exports" }
  | { kind: "task.write"; root: "scratch" | "exports" }
  | { kind: "command"; id: string }
  | { kind: "network"; id: string };

export type PilotDeckToolArtifact = Readonly<{
  /** Relative to the current task's workspace; checked at the artifact boundary. */
  path: string;
  role: "final" | "intermediate";
  mimeType?: string;
  description?: string;
}>;

export type PilotDeckPolicyDecision =
  | { type: "allow" }
  | { type: "deny"; message: string };

const CAPABILITY_ID = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u;

function capabilityKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["kind", "root", "id"].includes(key))) return undefined;
  switch (record.kind) {
    case "task.read":
      return !("id" in record) && typeof record.root === "string" && ["inbox", "scratch", "exports"].includes(record.root)
        ? `task.read:${record.root}` : undefined;
    case "task.write":
      return !("id" in record) && typeof record.root === "string" && ["scratch", "exports"].includes(record.root)
        ? `task.write:${record.root}` : undefined;
    case "command":
    case "network":
      return !("root" in record) && typeof record.id === "string" && CAPABILITY_ID.test(record.id)
        ? `${record.kind}:${record.id}` : undefined;
    default:
      return undefined;
  }
}

/**
 * Mandatory grant check for opted-in tools. `registered` comes only from the
 * system policy, never from permissions.json or model-controlled tool input.
 */
export function evaluateCapabilityPolicy(
  requested: readonly unknown[],
  declared: readonly unknown[],
  registered: readonly unknown[] = [],
): PilotDeckPolicyDecision {
  if (!Array.isArray(requested) || !Array.isArray(declared) || !Array.isArray(registered)) {
    return { type: "deny", message: "Invalid capability declaration." };
  }
  const declarationKeys = declared.map(capabilityKey);
  const registrationKeys = registered.map(capabilityKey);
  if (declarationKeys.includes(undefined) || registrationKeys.includes(undefined)) {
    return { type: "deny", message: "Invalid capability declaration or system registration." };
  }
  const declarations = new Set(declarationKeys);
  const registrations = new Set(registrationKeys);
  for (const capability of requested) {
    const key = capabilityKey(capability);
    if (!key) return { type: "deny", message: "Invalid requested capability." };
    if (!declarations.has(key)) return { type: "deny", message: `Undeclared capability: ${key}.` };
    if ((key.startsWith("command:") || key.startsWith("network:")) && !registrations.has(key)) {
      return { type: "deny", message: `Capability is not registered by the system: ${key}.` };
    }
  }
  return { type: "allow" };
}
