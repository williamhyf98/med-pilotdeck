import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { evaluateBashCommand } from "../../../../src/tool/builtin/bash/registeredCommands.js";
import { parseCommandPolicy } from "../../../../src/security/policy/parseCommandPolicy.js";

const appRoot = resolve(".");

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bash-policy-"));
  for (const name of ["inbox", "scratch", "exports"]) mkdirSync(join(root, name));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("built-in workspace inspection and document generation are registered capabilities", (t) => {
  const cwd = fixture(t);
  const policy = parseCommandPolicy(undefined);
  const pwd = evaluateBashCommand("pwd", { cwd, appRoot, policy });
  assert.equal(pwd.id, "workspace.pwd");
  assert.equal(pwd.kind, "workspace");
  const list = evaluateBashCommand("ls -la inbox", { cwd, appRoot, policy });
  assert.equal(list.id, "workspace.list");
  assert.equal(list.kind, "workspace");
  const pdf = evaluateBashCommand('bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --body "病历; 病人状况" --out "$PWD/exports/报告.pdf"', {
    cwd, appRoot, policy,
  });
  assert.equal(pdf.id, "pdf.make");
  assert.equal(pdf.kind, "script");
  if (pdf.kind === "script") {
    assert.equal(pdf.file, "/bin/bash");
    assert.equal(pdf.args[0], join(appRoot, "skills/pdf/scripts/pdf.sh"));
    assert.deepEqual(pdf.args.slice(1), ["make", "--body", "病历; 病人状况", "--out", join(cwd, "exports/报告.pdf")]);
  }
});

test("DOCX capability discovery is registered without opening arbitrary help", (t) => {
  const cwd = fixture(t);
  const policy = parseCommandPolicy(undefined);
  const capabilities = evaluateBashCommand('bash "$DOCX_SKILL_ROOT/scripts/docx.sh" capabilities', {
    cwd, appRoot, policy,
  });
  assert.equal(capabilities.id, "docx.capabilities");
  assert.throws(() => evaluateBashCommand('bash "$DOCX_SKILL_ROOT/scripts/docx.sh" --help', {
    cwd, appRoot, policy,
  }), /Unregistered capability/u);

  const schema = evaluateBashCommand(
    'bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command edit',
    { cwd, appRoot, policy },
  );
  assert.equal(schema.id, "docx.schema");
});

test("all document Skill capability discovery commands are registered", (t) => {
  const cwd = fixture(t);
  const policy = parseCommandPolicy(undefined);
  for (const [skill, variable] of [
    ["pdf", "PDF_SKILL_ROOT"],
    ["pptx", "PPTX_SKILL_ROOT"],
    ["spreadsheets", "SPREADSHEET_SKILL_ROOT"],
    ["diagram", "DIAGRAM_SKILL_ROOT"],
  ] as const) {
    const command = evaluateBashCommand(
      `bash "$${variable}/scripts/${skill === "spreadsheets" ? "spreadsheet.sh" : skill === "diagram" ? "diagram.sh" : `${skill}.sh`}" capabilities`,
      { cwd, appRoot, policy },
    );
    assert.equal(command.id, `${skill}.capabilities`);
  }
});

test("registered DOCX commands can address the turn work directory through its controlled alias", (t) => {
  const cwd = fixture(t);
  const workDir = join(cwd, "scratch", "work", "session", "turn");
  mkdirSync(join(workDir, "docx", "qa"), { recursive: true });
  const policy = parseCommandPolicy(undefined);
  const command = evaluateBashCommand(
    'bash "$DOCX_SKILL_ROOT/scripts/docx.sh" inspect --input inbox/source.docx --out "$PILOTDECK_WORK_DIR/docx/qa/inspection.json"',
    { cwd, appRoot, policy, workDir } as never,
  );
  assert.equal(command.id, "docx.inspect");
  if (command.kind === "script") {
    assert.deepEqual(command.args.slice(1), [
      "inspect",
      "--input",
      join(cwd, "inbox", "source.docx"),
      "--out",
      join(workDir, "docx", "qa", "inspection.json"),
    ]);
  }

  assert.throws(() => evaluateBashCommand(
    'bash "$DOCX_SKILL_ROOT/scripts/docx.sh" inspect --input inbox/source.docx --out "$PILOTDECK_WORK_DIR/../../outside.json"',
    { cwd, appRoot, policy, workDir } as never,
  ), /Task path traversal is not allowed/u);
});

test("arbitrary executables, maintenance operations and shell composition are denied", (t) => {
  const cwd = fixture(t);
  const policy = parseCommandPolicy(undefined);
  for (const command of [
    "python3 -c 'print(1)'", "node -e '1'", "Rscript analysis.R", "env pwd",
    "source config.sh", "bash -c pwd", "/bin/ls inbox", "./pdf.sh make",
    "bash pdf.sh make --out exports/a.pdf",
    "bash \"$PDF_SKILL_ROOT/scripts/pdf.sh\" self-test",
    "bash \"$PDF_SKILL_ROOT/scripts/pdf.sh\" bootstrap-runtime",
    "bash \"$PDF_SKILL_ROOT/scripts/pdf.sh\" make --out exports/a.pdf; id",
    "bash \"$PDF_SKILL_ROOT/scripts/pdf.sh\" make --out exports/a.pdf && id",
    "ls inbox | cat", "pwd > scratch/a", "pwd &", "pwd\nid",
    "pwd $(id)", "pwd `id`", "pwd <<EOF", "pwd ${HOME}",
    "find inbox -exec sh -c id {} ;", "ls --color=always inbox",
  ]) {
    assert.throws(() => evaluateBashCommand(command, { cwd, appRoot, policy }), { message: /.+/u }, command);
  }
});

test("bundled script identity cannot be spoofed by a workspace file or a foreign absolute path", (t) => {
  const cwd = fixture(t);
  for (const command of [
    'bash "/opt/pilotdeck/skills/pdf/scripts/pdf.sh" make --out exports/a.pdf',
    'bash "./skills/pdf/scripts/pdf.sh" make --out exports/a.pdf',
    'bash "scratch/pdf.sh" make --out exports/a.pdf',
    'bash "$PDF_SKILL_ROOT/scripts/docx.sh" make --out exports/a.docx',
  ]) {
    assert.throws(() => evaluateBashCommand(command, { cwd, appRoot, policy: parseCommandPolicy(undefined) }), { message: /.+/u }, command);
  }
});

test("task roots and symbolic links bound inputs and outputs", (t) => {
  const cwd = fixture(t);
  symlinkSync(tmpdir(), join(cwd, "exports", "escape"));
  const policy = parseCommandPolicy(undefined);
  for (const command of [
    "ls ..", "ls /etc", "ls skills", "stat exports/escape/x",
    `stat ${join(cwd, "inbox", "record.txt")}`,
    'bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --out /tmp/leak.pdf',
    'bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --out exports/../secret.pdf',
    'bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --out exports/escape/leak.pdf',
    'bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --markdown /etc/passwd --out exports/a.pdf',
  ]) {
    assert.throws(() => evaluateBashCommand(command, { cwd, appRoot, policy }), { message: /.+/u }, command);
  }
});

test("the administrator may disable or narrow a registered command, not enable unknown flags", (t) => {
  const cwd = fixture(t);
  const defaultPolicy = parseCommandPolicy(undefined);
  const make = defaultPolicy.commands.find((entry) => entry.id === "pdf.make");
  assert.ok(make);
  const policy = parseCommandPolicy({
    version: 1, mode: "registered_only",
    commands: [{ ...make, allowedOptions: ["--out"], enabled: true }],
  });
  assert.throws(() => evaluateBashCommand('bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --title x --out exports/a.pdf', { cwd, appRoot, policy }));
  assert.equal(evaluateBashCommand('bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --out exports/a.pdf', { cwd, appRoot, policy }).id, "pdf.make");
  assert.throws(() => evaluateBashCommand("pwd", { cwd, appRoot, policy }), /workspace.pwd/);
  assert.throws(() => evaluateBashCommand('bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --builder scratch/code.js --out exports/a.pdf',
    { cwd, appRoot, policy }));
});

test("a narrowed workspace list cannot reveal disabled task roots", (t) => {
  const cwd = fixture(t);
  const list = parseCommandPolicy(undefined).commands.find((entry) => entry.id === "workspace.list");
  assert.ok(list);
  const policy = parseCommandPolicy({ version: 1, mode: "registered_only",
    commands: [{ ...list, inputRoots: ["inbox"] }] });
  const root = evaluateBashCommand("ls", { cwd, appRoot, policy });
  assert.equal(root.kind, "workspace");
  if (root.kind === "workspace") assert.deepEqual(root.visibleRoots, ["inbox"]);
  assert.throws(() => evaluateBashCommand("ls exports", { cwd, appRoot, policy }));
});
