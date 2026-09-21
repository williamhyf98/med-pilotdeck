import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

test("server preload reads site settings and preserves shell overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-preload-"));
  try {
    const envFile = join(dir, "deploy.env");
    writeFileSync(envFile, "MED_RADAR_API_BASE=https://radar.test:18120\nMED_RADAR_TIMEOUT_SECONDS=900\n");
    const output = execFileSync(process.execPath, ["--import", resolve("scripts/register-deploy-env.mjs"), "-e",
      "console.log(JSON.stringify([process.env.MED_RADAR_API_BASE,process.env.MED_RADAR_TIMEOUT_SECONDS,process.env.NO_PROXY]))"], {
      env: { ...process.env, PILOTDECK_DEPLOY_ENV: envFile, MED_RADAR_API_BASE: "", MED_RADAR_TIMEOUT_SECONDS: "840" }, encoding: "utf8",
    });
    const [url, timeout, noProxy] = JSON.parse(output);
    assert.equal(url, "https://radar.test:18120");
    assert.equal(timeout, "840");
    assert.ok(noProxy.split(",").includes("radar.test"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
