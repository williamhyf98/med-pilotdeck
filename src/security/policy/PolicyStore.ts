import { randomUUID, createHash } from "node:crypto";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseDocument, stringify } from "yaml";
import { parseCommandPolicy, type CommandPolicy } from "./parseCommandPolicy.js";
import { parseNetworkPolicy, type NetworkPolicy } from "./parseNetworkPolicy.js";
import { resolveSecurityPolicyPaths, type SecurityPolicyPaths } from "./paths.js";
import type { PilotPathEnv } from "../../pilot/paths.js";

export type SecurityPolicySnapshot = Readonly<{
  commands: CommandPolicy;
  network: NetworkPolicy;
  commandRevision: string;
  networkRevision: string;
}>;

export class PolicyConflictError extends Error {
  constructor() {
    super("Security policy revision conflict; reload before saving.");
    this.name = "PolicyConflictError";
  }
}

const MAX_POLICY_BYTES = 128 * 1024;
type PolicyKind = "command" | "network";
const absentRevision = (kind: PolicyKind) => hash(`absent:${kind}`);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathInfo(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function checkPath(path: string): void {
  for (const candidate of [dirname(dirname(path)), dirname(path), path]) {
    if (pathInfo(candidate)?.isSymbolicLink()) {
      throw new Error(`Symlink is not permitted for security policy paths: ${candidate}`);
    }
  }
}

function readPolicy<T>(path: string, kind: PolicyKind, parse: (value: unknown) => T): { value: T; revision: string } {
  checkPath(path);
  const info = pathInfo(path);
  if (!info) return { value: parse(undefined), revision: absentRevision(kind) };
  if (!info.isFile() || info.size > MAX_POLICY_BYTES) throw new Error(`Invalid ${kind} policy file.`);
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw) > MAX_POLICY_BYTES) throw new Error(`${kind} policy file is too large.`);
  const document = parseDocument(raw, { prettyErrors: false, uniqueKeys: true, merge: false });
  if (document.errors.length > 0) {
    throw new Error(`Invalid ${kind} policy YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  return { value: parse(document.toJS({ maxAliasCount: 0 })), revision: hash(raw) };
}

function readSnapshot(paths: SecurityPolicyPaths): SecurityPolicySnapshot {
  const command = readPolicy(paths.command, "command", parseCommandPolicy);
  const network = readPolicy(paths.network, "network", parseNetworkPolicy);
  return freezeSnapshot({
    commands: command.value, network: network.value,
    commandRevision: command.revision, networkRevision: network.revision,
  });
}

function freezeSnapshot(snapshot: SecurityPolicySnapshot): SecurityPolicySnapshot {
  for (const policy of [snapshot.commands, snapshot.network] as const) {
    const entries = policy === snapshot.commands ? policy.commands : snapshot.network.rules;
    for (const entry of entries) {
      for (const value of Object.values(entry)) if (Array.isArray(value)) Object.freeze(value);
      Object.freeze(entry);
    }
    Object.freeze(entries);
    Object.freeze(policy);
  }
  return Object.freeze(snapshot);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > MAX_POLICY_BYTES) throw new Error("Security policy file is too large.");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  checkPath(path);
  const temporary = resolve(directory, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    // Directory fsync is unavailable on some platforms; the atomic rename remains valid.
    try {
      const dir = await open(directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { /* best effort */ }
  } finally {
    await rm(temporary, { force: true });
  }
}

export class SecurityPolicyStore {
  private snapshot: SecurityPolicySnapshot;
  private diagnostics: string | null = null;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly paths: SecurityPolicyPaths) {
    this.snapshot = readSnapshot(paths);
  }

  getSnapshot(): SecurityPolicySnapshot {
    return this.snapshot;
  }

  getDiagnostics(): string | null {
    return this.diagnostics;
  }

  reload(): Promise<SecurityPolicySnapshot> {
    return this.enqueue(() => {
      try {
        const next = readSnapshot(this.paths);
        this.snapshot = next;
        this.diagnostics = null;
        return next;
      } catch (error) {
        this.diagnostics = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
  }

  updateCommands(value: unknown, expectedRevision: string): Promise<SecurityPolicySnapshot> {
    return this.update("command", value, expectedRevision);
  }

  updateNetwork(value: unknown, expectedRevision: string): Promise<SecurityPolicySnapshot> {
    return this.update("network", value, expectedRevision);
  }

  private update(kind: PolicyKind, value: unknown, expectedRevision: string): Promise<SecurityPolicySnapshot> {
    return this.enqueue(async () => {
      const parsed = kind === "command" ? parseCommandPolicy(value) : parseNetworkPolicy(value);
      const current = readSnapshot(this.paths);
      if (typeof expectedRevision !== "string"
        || current.commandRevision !== this.snapshot.commandRevision
        || current.networkRevision !== this.snapshot.networkRevision
        || expectedRevision !== (kind === "command" ? current.commandRevision : current.networkRevision)) {
        throw new PolicyConflictError();
      }
      const path = this.paths[kind];
      await writeAtomic(path, stringify(parsed));
      const next = readSnapshot(this.paths);
      this.snapshot = next;
      this.diagnostics = null;
      return next;
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => {});
    return next;
  }
}

export function createSecurityPolicyStore(options: { env?: PilotPathEnv } = {}): SecurityPolicyStore {
  return new SecurityPolicyStore(resolveSecurityPolicyPaths(options.env));
}
