import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sanitizeSessionIdForTranscript,
  sanitizeSessionIdForCaseDir,
} from "../../src/pilot/paths.js";

// Batch A supplies storage fixtures only. Task 8 will attach the real
// CapabilityService; do not use a permissive fake as proof of authorization.
export async function makeSecurityFixture() {
  const root = await mkdtemp(join(tmpdir(), "pilot-security-"));
  const sessionId = "web:s_shared";
  const projects = ["general_med-shared", "trauma_med-shared"] as const;
  const scopeA = { userId: 1, username: "alice", role: "admin" as const, pilotHome: join(root, "users", "1"), impersonated: false };
  const scopeB = { userId: 2, username: "bob", role: "user" as const, pilotHome: join(root, "users", "2"), impersonated: false };
  try {
    for (const scope of [scopeA, scopeB]) {
      for (const projectId of projects) {
        const type = projectId.startsWith("trauma") ? "trauma_med" : "general_med";
        const project = join(scope.pilotHome, "projects", type, projectId);
        const workspace = join(scope.pilotHome, "workspaces", type, projectId);
        await mkdir(join(project, "chats"), { recursive: true });
        await mkdir(join(workspace, "inbox"), { recursive: true });
        await writeFile(join(project, ".cwd"), `workspaces/${type}/${projectId}`);
        await writeFile(join(workspace, "inbox", "同名记录.xml"), `<record>${scope.username}</record>`);
        await writeFile(join(project, "chats", `${sanitizeSessionIdForTranscript(sessionId)}.jsonl`),
          JSON.stringify({
            type: "durable_message",
            createdAt: "2026-09-23T00:00:00.000Z",
            message: { role: "user", content: [{ type: "text", text: `${scope.username}的历史病例` }] },
          }) + "\n");
        if (type === "trauma_med") {
          const caseDir = join(scope.pilotHome, "memory", type, projectId, "cases", sanitizeSessionIdForCaseDir(sessionId));
          await mkdir(caseDir, { recursive: true });
          await writeFile(join(caseDir, "current.json"), JSON.stringify({ fixtureOwner: scope.username }));
        }
      }
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root, scopeA, scopeB, sessionId, projects,
    async dispose() { await rm(root, { recursive: true, force: true }); },
  };
}
