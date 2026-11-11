// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOfficeToPdfTool } from "../../src/tool/builtin/officeToPdf.js";

/**
 * spec §4.2 #6 / §6.1：office_to_pdf 覆盖已存在的产物必须先确认。
 * write_file / edit_file 由"写前必读 + 内容哈希"拦住，不在这里重复弹窗。
 */

function context({ workspace, pilotHome }) {
  return {
    cwd: workspace,
    permissionMode: "bypassPermissions",
    permissionContext: { additionalWorkingDirectories: [] },
    env: { PILOT_HOME: pilotHome },
    allowedReadFiles: [],
  };
}

async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-pdf-overwrite-"));
  const pilotHome = join(root, "users", "1");
  const workspace = join(pilotHome, "workspaces", "general", "ws1");
  try {
    await mkdir(join(workspace, "exports"), { recursive: true });
    await writeFile(join(workspace, "exports", "报告.docx"), "docx-bytes");
    await fn({ workspace, pilotHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("office_to_pdf asks before overwriting an existing output file", async () => {
  await withWorkspace(async ({ workspace, pilotHome }) => {
    const tool = createOfficeToPdfTool();
    const ctx = context({ workspace, pilotHome });
    await writeFile(join(workspace, "exports", "报告.pdf"), "old-pdf");

    const result = await tool.checkPermissions({ input_file: "exports/报告.docx", output_file: "exports/报告.pdf" }, ctx);
    assert.equal(result.type, "ask");
    assert.match(result.request.reason.message, /已存在/);
    assert.equal(result.request.metadata.overwriteTarget, join("exports", "报告.pdf"));
    assert.deepEqual(result.request.options.map((option) => option.id), ["allow_session", "allow_once", "deny", "cancel"]);

    const auditDir = join(pilotHome, "system", "audit");
    const names = (await readdir(auditDir)).filter((name) => name.endsWith(".jsonl"));
    assert.equal(names.length, 1);
    const [record] = (await readFile(join(auditDir, names[0]), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(record.action, "file.overwrite_ask");
    assert.equal(record.target, join("exports", "报告.pdf"));
  });
});

test("office_to_pdf passes through when the output file does not exist yet", async () => {
  await withWorkspace(async ({ workspace, pilotHome }) => {
    const tool = createOfficeToPdfTool();
    const result = await tool.checkPermissions(
      { input_file: "exports/报告.docx", output_file: "exports/新报告.pdf" },
      context({ workspace, pilotHome }),
    );
    assert.equal(result.type, "passthrough");
  });
});

test("office_to_pdf still denies writes into inbox (read-only root)", async () => {
  await withWorkspace(async ({ workspace, pilotHome }) => {
    await mkdir(join(workspace, "inbox"), { recursive: true });
    const tool = createOfficeToPdfTool();
    const result = await tool.checkPermissions(
      { input_file: "exports/报告.docx", output_file: "inbox/报告.pdf" },
      context({ workspace, pilotHome }),
    );
    assert.equal(result.type, "deny");
    assert.match(result.message, /read-only/);
  });
});
