import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PermissionRuntime } from "../../src/permission/index.js";
import {
  getAutomationPolicyViolation,
  isExecutableSourcePath,
} from "../../src/tool/automationPolicyConstraints.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

test("automation policy classifies executable source paths", () => {
  for (const path of ["extract.py", "builder.mjs", "helper.sh", "Makefile", "analysis.ipynb", "helper.ps1"]) {
    assert.equal(isExecutableSourcePath(path), true, path);
  }
  for (const path of ["content.md", "workbook.json", "records.csv", "diagram.html", "image.svg"]) {
    assert.equal(isExecutableSourcePath(path), false, path);
  }
});

test("automation policy blocks source writes but permits declarative inputs", () => {
  assert.match(
    getAutomationPolicyViolation("write_file", { file_path: "exports/extract.py" }) ?? "",
    /blocks writing executable source/u,
  );
  assert.match(
    getAutomationPolicyViolation("edit_file", { file_path: "builder.ts" }) ?? "",
    /blocks writing executable source/u,
  );
  assert.equal(
    getAutomationPolicyViolation("write_file", { file_path: "scratch/qa/workbook.json" }),
    undefined,
  );
});

test("automation policy blocks interpreter and shell bypasses", () => {
  const blocked = [
    "python3 extract.py input.xml",
    "node -e \"console.log(1)\"",
    "env -i python3 extract.py",
    "printf '%s' files | xargs -0 python3",
    "awk '{ print $1 }' input.xml",
    "powershell -File helper.ps1",
    "python3 <<'PY'\nprint('x')\nPY",
    "printf 'print(1)' > helper.py",
    "bash helper.sh",
    "printf 'echo x' | sh",
    "chmod +x payload && ./payload",
    "make report",
    "bash \"$PDF_SKILL_ROOT/scripts/pdf.sh\" make --markdown a.md --out a.pdf; make clean",
    "bash \"$PDF_SKILL_ROOT/scripts/pdf.sh\" make --markdown a.md --out a.pdf && npm run build",
  ];
  for (const command of blocked) {
    assert.ok(
      getAutomationPolicyViolation("bash", { command }),
      `expected command to be blocked: ${command}`,
    );
  }
});

test("automation policy permits bundled document entrypoints and ordinary file operations", () => {
  const allowed = [
    "mkdir -p scratch/qa",
    "ls -la exports",
    "git status --short",
    "bash \"/opt/pilotdeck/skills/pdf/scripts/pdf.sh\" make --markdown scratch/qa/content.md --out exports/report.pdf",
    "bash \"$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh\" make --csv scratch/qa/data.csv --out exports/data.xlsx",
    "bash \"$PPTX_SKILL_ROOT/scripts/pptx.sh\" make --title \"Node service\" --out exports/node.pptx",
    "bash \"$DIAGRAM_SKILL_ROOT/scripts/diagram.sh\" make --markdown scratch/qa/flow.mmd --out exports/flow.svg",
    "DIAGRAM_SKILL_ROOT=\"$(dirname \"/opt/pilotdeck/skills/diagram-maker/SKILL.md\")\"; mkdir -p \"$PWD/scratch/qa\"; bash \"$DIAGRAM_SKILL_ROOT/scripts/diagram.sh\" make --markdown \"$PWD/scratch/qa/flow.mmd\" --out \"$PWD/exports/flow.svg\"",
    "mkdir -p exports && bash \"$PDF_SKILL_ROOT/scripts/pdf.sh\" make --markdown scratch/qa/content.md --out exports/report.pdf",
    "SPREADSHEET_SKILL_ROOT=\"/opt/pilotdeck/skills/spreadsheets\"\nbash \"$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh\" make --spec scratch/qa/book.json --out exports/book.xlsx",
  ];
  for (const command of allowed) {
    assert.equal(
      getAutomationPolicyViolation("bash", { command }),
      undefined,
      `expected command to be allowed: ${command}`,
    );
  }
});

test("all documented document-skill bash entrypoints pass the automation policy", () => {
  const structuredTools = {
    pdf: "pdf_make",
    docx: "docx_make",
    pptx: "pptx_make",
    spreadsheets: "spreadsheets_make",
    "diagram-maker": "diagram_make",
  } as const;
  for (const skill of Object.keys(structuredTools) as Array<keyof typeof structuredTools>) {
    const skillPath = resolve(`skills/${skill}/SKILL.md`);
    const content = readFileSync(skillPath, "utf8");
    assert.match(content, new RegExp(`\\b${structuredTools[skill]}\\b`, "u"));
    const commands = content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("bash "));
    for (const command of commands) {
      assert.equal(
        getAutomationPolicyViolation("bash", { command }),
        undefined,
        `${skillPath}: ${command}`,
      );
    }
  }
});

test("ToolRuntime hard-blocks automation before bypassPermissions can execute it", async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.register({
    name: "write_file",
    description: "test",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path"],
      properties: { file_path: { type: "string" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute() {
      executed = true;
      return { content: [{ type: "text", text: "executed" }] };
    },
  });
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const result = await runtime.execute(
    { id: "write-script", name: "write_file", input: { file_path: "extract.py" } },
    {
      sessionId: "session",
      turnId: "turn",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      permissionContext: {
        mode: "bypassPermissions",
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: true,
        bypassAvailable: true,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
  );

  assert.equal(result.type, "error");
  assert.equal(result.error.code, "automation_policy_violation");
  assert.equal(executed, false);
});

test("PermissionRequest updatedInput cannot turn a safe write into executable source", async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.register({
    name: "write_file",
    description: "test",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path"],
      properties: { file_path: { type: "string" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: async () => ({
      type: "ask",
      reason: { type: "tool", toolName: "write_file", message: "write" },
      request: { toolCallId: "", toolName: "write_file", inputSummary: "write",
        reason: { type: "tool", toolName: "write_file", message: "write" },
        options: [{ id: "allow_once", label: "Allow once" }] },
    }),
    async execute() {
      executed = true;
      return { content: [{ type: "text", text: "written" }] };
    },
  });
  const lifecycle = {
    async dispatch(input: { event: string }) {
      return {
        effects: input.event === "PermissionRequest"
          ? [{ type: "permission_request_result" as const,
            result: { behavior: "allow" as const, updatedInput: { file_path: "scratch/script.py" } } }]
          : [],
        messages: [], events: [], blockingErrors: [], nonBlockingErrors: [],
      };
    },
  };
  const runtime = new ToolRuntime(registry, new PermissionRuntime(), lifecycle as never);
  const cwd = process.cwd();
  const result = await runtime.execute({ id: "rewrite", name: "write_file",
    input: { file_path: "scratch/report.md" } }, {
    sessionId: "session", turnId: "turn", cwd, permissionMode: "default",
    permissionContext: {
      mode: "default", cwd, additionalWorkingDirectories: [], canPrompt: true,
      bypassAvailable: false, rules: { allow: [], deny: [], ask: [] },
    },
  });
  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "automation_policy_violation");
  assert.equal(executed, false);
});
