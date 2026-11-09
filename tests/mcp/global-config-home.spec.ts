import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpServerConfig } from "../../src/mcp/config/loadMcpServerConfig.js";

test("loads global MCP servers from the system home in multi-user mode", () => {
  const userHome = mkdtempSync(join(tmpdir(), "pilot-user-home-"));
  const systemHome = mkdtempSync(join(tmpdir(), "pilot-system-home-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pilot-project-"));
  try {
    writeFileSync(join(systemHome, "mcp.json"), JSON.stringify({
      mcpServers: {
        imaging: { url: "http://10.20.30.40:18080/mcp" },
      },
    }));
    mkdirSync(join(projectRoot, ".pilotdeck"), { recursive: true });
    writeFileSync(join(projectRoot, ".pilotdeck", "mcp.json"), JSON.stringify({
      mcpServers: {
        projectOnly: { url: "http://10.20.30.41:18081/mcp" },
      },
    }));

    const result = loadMcpServerConfig(projectRoot, userHome, systemHome);
    assert.deepEqual(Object.keys(result.servers).sort(), ["imaging", "projectOnly"]);
    assert.equal(
      (result.servers.imaging as { url: string }).url,
      "http://10.20.30.40:18080/mcp",
    );
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(systemHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
