import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import {
  createOfficeToPdfTool,
  getOfficeRendererUrl,
} from "../../../src/tool/index.js";

function toolContext(cwd: string, env: NodeJS.ProcessEnv = {}): any {
  return {
    sessionId: "session",
    turnId: "turn",
    cwd,
    env,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
}

test("office_to_pdf resolves the node12 renderer for server deployments", () => {
  assert.equal(
    getOfficeRendererUrl({
      PILOTDECK_OFFICE_RENDERER_ROLE: "server",
      PILOTDECK_OFFICE_RENDERER_PORT: "19400",
    }),
    "http://127.0.0.1:19400",
  );
});

test("office_to_pdf sends the Office file to the Renderer and writes an artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-office-to-pdf-"));
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(join(root, "exports"), { recursive: true });
    await writeFile(join(root, "report.docx"), "test docx");
    const pdf = Buffer.from("%PDF-1.7\nconverted\n%%EOF\n");
    let request: Request | undefined;
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return new Response(pdf, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    };

    const tool = createOfficeToPdfTool();
    const result = await tool.execute({
      input_file: "report.docx",
      output_file: "exports/report.pdf",
    }, toolContext(root, {
      PILOTDECK_OFFICE_RENDERER_URL: "http://node12:19400",
    }));

    assert.equal(result.data?.inputFormat, "docx");
    assert.equal(result.data?.outputFile, "exports/report.pdf");
    assert.equal(result.content[0]?.type, "file");
    assert.equal(
      result.content[0]?.type === "file" ? result.content[0].path : undefined,
      "exports/report.pdf",
    );
    assert.deepEqual(await readFile(join(root, "exports/report.pdf")), pdf);
    assert.equal(request?.url, "http://node12:19400/v1/convert/pdf");
    assert.equal(request?.method, "POST");
    assert.equal(
      request?.headers.get("X-File-Name"),
      "report.docx",
    );
    assert.equal(
      request?.headers.get("Content-Type"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("office_to_pdf rejects unsupported formats before contacting the Renderer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-office-to-pdf-invalid-"));
  try {
    await writeFile(join(root, "notes.txt"), "not an office file");
    const tool = createOfficeToPdfTool();
    const validation = await tool.validateInput?.({
      input_file: "notes.txt",
      output_file: "exports/notes.pdf",
    }, toolContext(root, {
      PILOTDECK_OFFICE_RENDERER_URL: "http://node12:19400",
    }));

    assert.equal(validation?.ok, false);
    assert.match(
      validation && !validation.ok ? validation.issues[0]?.message ?? "" : "",
      /docx.*xlsx.*pptx/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("office_to_pdf does not overwrite an existing PDF without force", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-office-to-pdf-existing-"));
  try {
    await mkdir(join(root, "exports"), { recursive: true });
    await writeFile(join(root, "report.xlsx"), "test xlsx");
    await writeFile(join(root, "exports/report.pdf"), "%PDF-old");
    const tool = createOfficeToPdfTool();
    const validation = await tool.validateInput?.({
      input_file: "report.xlsx",
      output_file: "exports/report.pdf",
    }, toolContext(root, {
      PILOTDECK_OFFICE_RENDERER_URL: "http://node12:19400",
    }));

    assert.equal(validation?.ok, false);
    assert.match(
      validation && !validation.ok ? validation.issues[0]?.message ?? "" : "",
      /force=true/u,
    );
    assert.equal((await stat(join(root, "exports/report.pdf"))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
