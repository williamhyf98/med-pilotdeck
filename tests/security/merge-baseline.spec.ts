import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeSecurityFixture } from "./fixtures.js";
import { listWebProjects } from "../../src/web/server/listProjects.js";
import { listProjectSessions } from "../../src/session/index.js";
import { resolveWorkspaceDataRoot } from "../../src/pilot/paths.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";

test("two homes retain same-ID projects, history, same-name files and distinct case/transcript slugs", async () => {
  const f = await makeSecurityFixture();
  try {
    for (const scope of [f.scopeA, f.scopeB]) {
      const listed = await listWebProjects({ pilotHome: scope.pilotHome });
      assert.equal(listed.projects.length, 2);
      for (const projectId of f.projects) {
        const workspace = resolveWorkspaceDataRoot(projectId, scope.pilotHome);
        const sessions = await listProjectSessions({ projectRoot: workspace, pilotHome: scope.pilotHome });
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0]?.summary, `${scope.username}的历史病例`);
        assert.equal(await readFile(join(workspace, "inbox", "同名记录.xml"), "utf8"), `<record>${scope.username}</record>`);
      }
      // Literal historical path: case slug replaces ':'; transcript keeps it
      // on Unix. The listing above exercises the transcript's real reader.
      assert.deepEqual(JSON.parse(await readFile(join(scope.pilotHome,
        "memory/trauma_med/trauma_med-shared/cases/web_s_shared/current.json"), "utf8")),
      { fixtureOwner: scope.username });
    }
  } finally { await f.dispose(); }
});

test("new same-ID sessions persist independently through the real transcript writer", async () => {
  const f = await makeSecurityFixture();
  try {
    for (const scope of [f.scopeA, f.scopeB]) {
      for (const projectId of f.projects) {
        const projectRoot = resolveWorkspaceDataRoot(projectId, scope.pilotHome);
        const storage = createAgentProjectSessionStorage({
          projectRoot, pilotHome: scope.pilotHome, sessionId: "web:s_new",
        });
        await storage.transcript.recordAcceptedInput("web:s_new", "turn-1", [
          { role: "user", content: [{ type: "text", text: `${scope.username}的新会话` }] },
        ]);
        const sessions = await listProjectSessions({ projectRoot, pilotHome: scope.pilotHome });
        assert.equal(sessions.length, 2);
        assert.equal(sessions.find((s) => s.sessionId === "web:s_new")?.summary, `${scope.username}的新会话`);
      }
    }
  } finally { await f.dispose(); }
});
