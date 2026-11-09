import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sharedModuleUrl = pathToFileURL(resolve("skills/_shared/task-paths.mjs")).href;

test("registered Skill capability discovery does not require local runtimes", () => {
  for (const script of [
    "skills/docx/scripts/docx.sh",
    "skills/pdf/scripts/pdf.sh",
    "skills/pptx/scripts/pptx.sh",
    "skills/spreadsheets/scripts/spreadsheet.sh",
    "skills/diagram-maker/scripts/diagram.sh",
  ]) {
    const result = spawnSync("bash", [resolve(script), "capabilities"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${script}: ${result.stderr || result.stdout}`);
    const payload = JSON.parse(result.stdout) as { status?: string; pathContract?: { remoteResources?: boolean } };
    assert.equal(payload.status, "ok", script);
    assert.equal(payload.pathContract?.remoteResources, false, script);
  }
});

test("declarative Skill resources stay inside the current task roots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-skill-resource-"));
  const outside = mkdtempSync(join(tmpdir(), "pilotdeck-skill-resource-outside-"));
  const previousTaskRoot = process.env.PILOTDECK_WORKSPACE_DIR;
  const previousFallback = process.env.PILOTDECK_WORKSPACE_CWD;
  t.after(() => {
    if (previousTaskRoot === undefined) delete process.env.PILOTDECK_WORKSPACE_DIR;
    else process.env.PILOTDECK_WORKSPACE_DIR = previousTaskRoot;
    if (previousFallback === undefined) delete process.env.PILOTDECK_WORKSPACE_CWD;
    else process.env.PILOTDECK_WORKSPACE_CWD = previousFallback;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  for (const directory of ["inbox", "scratch", "exports"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  const image = join(root, "inbox", "image.png");
  writeFileSync(image, "fixture");
  const outsideImage = join(outside, "outside.png");
  writeFileSync(outsideImage, "fixture");
  symlinkSync(outsideImage, join(root, "inbox", "linked.png"));
  process.env.PILOTDECK_WORKSPACE_DIR = root;
  delete process.env.PILOTDECK_WORKSPACE_CWD;

  const taskPaths = await import(sharedModuleUrl) as {
    resolveTaskResource: (value: string, baseDir: string, label?: string) => string;
  };
  assert.equal(
    taskPaths.resolveTaskResource(image, root, "image"),
    realpathSync.native(image),
  );
  assert.throws(
    () => taskPaths.resolveTaskResource(outsideImage, root, "image"),
    /inside the current task/u,
  );
  assert.throws(
    () => taskPaths.resolveTaskResource(join(root, "inbox", "linked.png"), root, "image"),
    /symbolic-link/u,
  );
});
