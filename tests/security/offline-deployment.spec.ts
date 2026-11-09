import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NetworkAccessController, NetworkServiceRegistry, type NetworkService } from "../../src/network/serviceRegistry.js";
import { parseCommandPolicy } from "../../src/security/policy/parseCommandPolicy.js";
import { resolvePilotDeckWorkspacePath } from "../../src/tool/builtin/filesystem/pathSafety.js";
import { evaluateBashCommand } from "../../src/tool/builtin/bash/registeredCommands.js";
import { normalizeToolArtifacts } from "../../src/session/artifacts/artifactContract.js";

function service(overrides: Partial<NetworkService> = {}): NetworkService {
  return {
    id: "service.model",
    name: "本地模型",
    purpose: "模型服务",
    protocol: "http",
    host: "127.0.0.1",
    port: 19000,
    baseUrl: "http://127.0.0.1:19000",
    source: "test",
    enabled: true,
    ...overrides,
  };
}

function taskContext(taskRoot: string): any {
  return {
    cwd: taskRoot,
    taskRoot,
    permissionMode: "bypassPermissions",
    permissionContext: {
      cwd: taskRoot,
      mode: "bypassPermissions",
      additionalWorkingDirectories: [],
    },
  };
}

test("offline policy allows registered private services and denies public targets", async () => {
  const registry = new NetworkServiceRegistry([
    service(),
    service({
      id: "service.rag",
      name: "RAG",
      purpose: "医学检索",
      host: "rag.internal",
      port: 19080,
      baseUrl: "http://rag.internal:19080",
    }),
  ]);
  const access = new NetworkAccessController({
    registry,
    getPolicy: () => ({ version: 1, mode: "deny", rules: [] }),
    lookup: async (host) => host === "rag.internal"
      ? [{ address: "10.20.0.12", family: 4 }]
      : [],
  });

  await access.assertAllowed("http://127.0.0.1:19000/v1");
  await access.assertAllowed("http://rag.internal:19080/retrieve");
  await assert.rejects(access.assertAllowed("https://example.com/"), {
    code: "network_policy_denied",
  });
});

test("registered command policy rejects interpreters and shell composition", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilot-offline-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["inbox", "scratch", "exports"]) mkdirSync(join(root, directory));
  const policy = parseCommandPolicy(undefined);

  assert.equal(
    evaluateBashCommand("ls exports", { cwd: root, appRoot: process.cwd(), policy }).id,
    "workspace.list",
  );
  for (const command of [
    "python3 -c print(1)",
    "node -e console.log(1)",
    "bash -c id",
    "ls exports; id",
    "ls exports | cat",
  ]) {
    assert.throws(
      () => evaluateBashCommand(command, { cwd: root, appRoot: process.cwd(), policy }),
      command,
    );
  }
});

test("two application users cannot cross task boundaries, even in bypass mode", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilot-offline-users-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userA = join(root, "users", "a", "workspaces", "case");
  const userB = join(root, "users", "b", "workspaces", "case");
  for (const task of [userA, userB]) {
    for (const directory of ["inbox", "scratch", "exports"]) mkdirSync(join(task, directory), { recursive: true });
  }
  writeFileSync(join(userB, "inbox", "secret.txt"), "user-b");

  const result = resolvePilotDeckWorkspacePath(
    join(userB, "inbox", "secret.txt"),
    taskContext(userA),
    { mustExist: true, allowOutsideWorkspace: true },
  );
  assert.equal(result.ok, false);
  assert.equal(
    resolvePilotDeckWorkspacePath("inbox/secret.txt", taskContext(userA), { mustExist: true }).ok,
    false,
  );
});

test("final artifacts are restricted to exports and intermediate artifacts to scratch", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilot-offline-artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["inbox", "scratch", "exports"]) mkdirSync(join(root, directory));
  writeFileSync(join(root, "exports", "report.csv"), "id,value\n1,ok\n");
  writeFileSync(join(root, "scratch", "audit.json"), "{}");

  const context = taskContext(root);
  assert.deepEqual(
    await normalizeToolArtifacts([
      { path: "exports/report.csv", role: "final" },
      { path: "scratch/audit.json", role: "intermediate" },
    ], context),
    [
      { path: "exports/report.csv", role: "final" },
      { path: "scratch/audit.json", role: "intermediate" },
    ],
  );
  await assert.rejects(
    normalizeToolArtifacts([{ path: "scratch/audit.json", role: "final" }], context),
    /exports/u,
  );
});

test("offline deployment documentation records the enforced operational contract", () => {
  const contract = readFileSync("docs/security-policy-and-artifact-contract.md", "utf8");
  assert.match(contract, /不允许外网|不开放外网|外网/u);
  assert.match(contract, /备份|恢复/u);
  assert.match(contract, /bubblewrap/u);
  assert.match(contract, /sandbox-exec/u);
  assert.match(contract, /exports/u);
  assert.match(contract, /scratch/u);
});
