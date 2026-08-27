// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileArtifactCollector } from "../../src/session/artifacts/FileArtifactCollector.js";
function toolResult(toolName) {
    return {
        type: "success",
        toolCallId: `${toolName}-1`,
        toolName,
        content: [{ type: "text", text: "ok" }],
        startedAt: "2026-07-21T10:00:00.000Z",
        completedAt: "2026-07-21T10:00:00.100Z",
    };
}
function failedToolResult(toolName, code) {
    return {
        type: "error",
        toolCallId: `${toolName}-1`,
        toolName,
        error: { code, message: "Tool did not execute." },
        content: [{ type: "text", text: "Tool did not execute." }],
        startedAt: "2026-07-21T10:00:00.000Z",
        completedAt: "2026-07-21T10:00:00.100Z",
    };
}
function successfulFileResult(toolCallId, paths) {
    return {
        type: "success",
        toolCallId,
        toolName: "document_generator",
        content: paths.map((path) => ({ type: "file", path })),
        startedAt: "2026-07-21T10:00:00.000Z",
        completedAt: "2026-07-21T10:00:01.000Z",
    };
}
test("file artifacts include every meaningful inbox and exports change without an extension allowlist", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifacts-"));
    const uploadedFile = join(projectRoot, "inbox", "batch-1", "source.xlsx");
    try {
        await mkdir(join(projectRoot, "exports"), { recursive: true });
        await mkdir(join(projectRoot, "inbox", "batch-1"), { recursive: true });
        await writeFile(join(projectRoot, "exports", "existing.docx"), "before");
        await writeFile(join(projectRoot, "exports", "restored.txt"), "original");
        await writeFile(join(projectRoot, "exports", "mtime-only.txt"), "unchanged");
        await writeFile(uploadedFile, "upload-before");
        const collector = await FileArtifactCollector.start({
            cwd: projectRoot,
            allowedInputPaths: [uploadedFile],
            now: () => new Date("2026-07-21T10:00:00.000Z"),
        });
        await writeFile(join(projectRoot, "exports", "existing.docx"), "after with more bytes");
        await writeFile(join(projectRoot, "exports", "notes.custom"), "unknown extension is still meaningful");
        await writeFile(join(projectRoot, "exports", "result.pptx"), "presentation");
        await writeFile(join(projectRoot, "exports", ".env.example"), "PUBLIC_URL=http://localhost");
        await writeFile(uploadedFile, "upload-after with more bytes");
        await writeFile(join(projectRoot, "exports", "restored.txt"), "temporary change");
        await writeFile(join(projectRoot, "exports", "restored.txt"), "original");
        await utimes(join(projectRoot, "exports", "mtime-only.txt"), new Date(), new Date());
        await writeFile(join(projectRoot, "exports", "created-then-deleted.txt"), "temporary");
        await rm(join(projectRoot, "exports", "created-then-deleted.txt"));
        await mkdir(join(projectRoot, "scratch", "work", "session", "turn", "pptx"), { recursive: true });
        await writeFile(join(projectRoot, "scratch", "work", "session", "turn", "pptx", "deck.mjs"), "builder");
        await writeFile(join(projectRoot, "exports", ".env"), "API_KEY=secret");
        await writeFile(join(projectRoot, "exports", "private.pem"), "secret key");
        collector.observeToolResult(toolResult("bash"));
        const artifacts = await collector.finish("incomplete");
        const expectedPaths = [
            "exports/.env.example",
            "exports/existing.docx",
            "exports/notes.custom",
            "exports/result.pptx",
            "inbox/batch-1/source.xlsx",
        ].sort((left, right) => left.localeCompare(right));
        assert.deepEqual(artifacts.map((artifact) => artifact.path), expectedPaths);
        assert.equal(artifacts.find((artifact) => artifact.path === "exports/existing.docx")?.operation, "updated");
        assert.equal(artifacts.find((artifact) => artifact.path === "exports/notes.custom")?.operation, "created");
        assert.equal(artifacts.find((artifact) => artifact.path === "exports/notes.custom")?.mimeType, undefined);
        assert.ok(artifacts.every((artifact) => artifact.status === "incomplete"));
        assert.ok(artifacts.every((artifact) => artifact.sha256.length === 64));
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("file artifact collection ignores workspace changes when no mutating tool ran", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-no-tool-"));
    try {
        await mkdir(join(projectRoot, "app"), { recursive: true });
        await writeFile(join(projectRoot, "app", "page.tsx"), "before");
        const collector = await FileArtifactCollector.start({ cwd: projectRoot });
        await writeFile(join(projectRoot, "app", "page.tsx"), "changed outside the agent turn");
        await writeFile(join(projectRoot, "app", "external.txt"), "external file");
        assert.deepEqual(await collector.finish("complete"), []);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("read-only tool results do not enable workspace-diff artifacts", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-readonly-tool-"));
    try {
        await writeFile(join(projectRoot, "notes.txt"), "before");
        const collector = await FileArtifactCollector.start({ cwd: projectRoot });
        await writeFile(join(projectRoot, "notes.txt"), "changed outside a read-only tool");
        collector.observeToolResult(toolResult("read_file"));
        assert.deepEqual(await collector.finish("complete"), []);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("unexecuted mutating tool errors do not enable workspace-diff artifacts", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-denied-tool-"));
    try {
        await writeFile(join(projectRoot, "notes.txt"), "before");
        const collector = await FileArtifactCollector.start({ cwd: projectRoot });
        await writeFile(join(projectRoot, "notes.txt"), "changed outside a denied tool");
        collector.observeToolResult(failedToolResult("bash", "permission_denied"));
        assert.deepEqual(await collector.finish("complete"), []);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("mutating tool execution failures still enable workspace-diff artifacts", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-failed-tool-"));
    try {
        await mkdir(join(projectRoot, "exports"), { recursive: true });
        await writeFile(join(projectRoot, "exports", "notes.txt"), "before");
        const collector = await FileArtifactCollector.start({ cwd: projectRoot });
        await writeFile(join(projectRoot, "exports", "notes.txt"), "changed before a tool failure");
        collector.observeToolResult(failedToolResult("bash", "tool_execution_failed"));
        assert.deepEqual((await collector.finish("complete")).map((artifact) => artifact.path), ["exports/notes.txt"]);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("file artifact fingerprints are reused for unchanged files across scans and turns", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-cache-"));
    const trackedFile = join(projectRoot, "exports", "report.txt");
    let hashCalls = 0;
    const hashFile = async (filePath) => {
        hashCalls += 1;
        return createHash("sha256").update(await readFile(filePath)).digest("hex");
    };
    try {
        await mkdir(join(projectRoot, "exports"), { recursive: true });
        await writeFile(trackedFile, "before");
        await mkdir(join(projectRoot, ".venv", "lib"), { recursive: true });
        await writeFile(join(projectRoot, ".venv", "lib", "dependency.py"), "ignored");
        const firstTurn = await FileArtifactCollector.start({ cwd: projectRoot, hashFile });
        assert.equal(hashCalls, 1, "the initial scan hashes only non-excluded workspace files");
        assert.deepEqual(await firstTurn.finish("complete"), []);
        assert.equal(hashCalls, 1, "the final scan reuses an unchanged baseline fingerprint");
        const secondTurn = await FileArtifactCollector.start({ cwd: projectRoot, hashFile });
        assert.equal(hashCalls, 1, "the next turn reuses the cached workspace fingerprint");
        await writeFile(trackedFile, "after with a different size");
        secondTurn.observeToolResult(toolResult("bash"));
        const artifacts = await secondTurn.finish("complete");
        assert.equal(hashCalls, 2, "only the changed file is re-hashed");
        assert.deepEqual(artifacts.map((artifact) => artifact.path), ["exports/report.txt"]);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("concurrent collectors in one workspace keep only files explicitly reported by their own turns", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-concurrent-"));
    try {
        await mkdir(join(projectRoot, "exports"), { recursive: true });
        const firstTurn = await FileArtifactCollector.start({ cwd: projectRoot });
        const secondTurn = await FileArtifactCollector.start({ cwd: projectRoot });
        await writeFile(join(projectRoot, "exports", "first.txt"), "first turn");
        await writeFile(join(projectRoot, "exports", "second.txt"), "second turn");
        await writeFile(join(projectRoot, "exports", "shared.txt"), "shared result");
        await writeFile(join(projectRoot, "exports", "unreported.txt"), "unknown owner");
        firstTurn.observeToolResult(successfulFileResult("first-call", ["exports/first.txt", "exports/shared.txt"]));
        secondTurn.observeToolResult(successfulFileResult("second-call", ["exports/second.txt", "exports/shared.txt"]));
        const firstArtifacts = await firstTurn.finish("complete");
        const secondArtifacts = await secondTurn.finish("complete");
        assert.deepEqual(firstArtifacts.map((artifact) => artifact.path), ["exports/first.txt", "exports/shared.txt"]);
        assert.deepEqual(secondArtifacts.map((artifact) => artifact.path), ["exports/second.txt", "exports/shared.txt"]);
        assert.ok(firstArtifacts.every((artifact) => artifact.source === "tool"));
        assert.ok(secondArtifacts.every((artifact) => artifact.source === "tool"));
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("concurrent collectors in separate workspaces retain independent workspace diffs", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-project-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-project-b-"));
    try {
        await mkdir(join(firstRoot, "exports"), { recursive: true });
        await mkdir(join(secondRoot, "exports"), { recursive: true });
        const firstTurn = await FileArtifactCollector.start({ cwd: firstRoot });
        const secondTurn = await FileArtifactCollector.start({ cwd: secondRoot });
        await writeFile(join(firstRoot, "exports", "first.txt"), "first project");
        await writeFile(join(secondRoot, "exports", "second.txt"), "second project");
        firstTurn.observeToolResult(toolResult("bash"));
        secondTurn.observeToolResult(toolResult("bash"));
        const firstArtifacts = await firstTurn.finish("complete");
        const secondArtifacts = await secondTurn.finish("complete");
        assert.deepEqual(firstArtifacts.map((artifact) => artifact.path), ["exports/first.txt"]);
        assert.deepEqual(secondArtifacts.map((artifact) => artifact.path), ["exports/second.txt"]);
        assert.equal(firstArtifacts[0]?.source, "workspace_diff");
        assert.equal(secondArtifacts[0]?.source, "workspace_diff");
    }
    finally {
        await rm(firstRoot, { recursive: true, force: true });
        await rm(secondRoot, { recursive: true, force: true });
    }
});
test("disposing an unfinished collector removes it from workspace concurrency tracking", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-dispose-"));
    try {
        await mkdir(join(projectRoot, "exports"), { recursive: true });
        const unfinishedTurn = await FileArtifactCollector.start({ cwd: projectRoot });
        unfinishedTurn.dispose();
        const nextTurn = await FileArtifactCollector.start({ cwd: projectRoot });
        await writeFile(join(projectRoot, "exports", "detected.txt"), "workspace diff remains enabled");
        nextTurn.observeToolResult(toolResult("bash"));
        const artifacts = await nextTurn.finish("complete");
        assert.deepEqual(artifacts.map((artifact) => artifact.path), ["exports/detected.txt"]);
        assert.equal(artifacts[0]?.source, "workspace_diff");
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("bash pdf.sh JSON output becomes an explicit PDF artifact without a workspace scan", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-pdf-bash-"));
    const pdfPath = join(projectRoot, "exports", "战创伤救治方案.pdf");
    try {
        await mkdir(join(projectRoot, "exports"), { recursive: true });
        await writeFile(pdfPath, "%PDF-1.4 test");
        await writeFile(join(projectRoot, "notes.md"), "should not be collected");
        const collector = await FileArtifactCollector.start({
            cwd: projectRoot,
            allowWorkspaceDiff: false,
            allowedExtensions: [".pdf"],
            now: () => new Date("2026-08-21T10:00:00.000Z"),
        });
        collector.observeToolResult({
            type: "success",
            toolCallId: "bash-1",
            toolName: "bash",
            content: [{
                type: "text",
                text: [
                    "BASH_RESULT[success][stdout_data]",
                    "stdout:",
                    JSON.stringify({ status: "ok", output: pdfPath, pages: 3 }),
                ].join("\n"),
            }],
            data: {
                command: `bash pdf.sh make --out "${pdfPath}"`,
                stdout: JSON.stringify({ status: "ok", output: pdfPath, pages: 3 }),
                stderr: "",
                exitCode: 0,
            },
            startedAt: "2026-08-21T10:00:00.000Z",
            completedAt: "2026-08-21T10:00:01.000Z",
        });
        const artifacts = await collector.finish("complete");
        assert.deepEqual(artifacts.map((artifact) => artifact.path), ["exports/战创伤救治方案.pdf"]);
        assert.equal(artifacts[0]?.source, "tool");
        assert.equal(artifacts[0]?.mimeType, "application/pdf");
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("bash docx.sh JSON output becomes an explicit DOCX artifact without a workspace scan", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-docx-bash-"));
    const docxPath = join(projectRoot, "exports", "救治方案.docx");
    try {
        await mkdir(join(projectRoot, "exports"), { recursive: true });
        await writeFile(docxPath, "PK test docx");
        const collector = await FileArtifactCollector.start({
            cwd: projectRoot,
            allowWorkspaceDiff: false,
            allowedExtensions: [".pdf", ".docx"],
            now: () => new Date("2026-08-21T10:00:00.000Z"),
        });
        collector.observeToolResult({
            type: "success",
            toolCallId: "bash-docx-1",
            toolName: "bash",
            content: [{
                type: "text",
                text: [
                    "BASH_RESULT[success][stdout_data]",
                    "stdout:",
                    JSON.stringify({ status: "ok", output: docxPath, blocks: 5 }),
                ].join("\n"),
            }],
            data: {
                command: `bash docx.sh make --out "${docxPath}"`,
                stdout: JSON.stringify({ status: "ok", output: docxPath, blocks: 5 }),
                stderr: "",
                exitCode: 0,
            },
            startedAt: "2026-08-21T10:00:00.000Z",
            completedAt: "2026-08-21T10:00:01.000Z",
        });
        const artifacts = await collector.finish("complete");
        assert.deepEqual(artifacts.map((artifact) => artifact.path), ["exports/救治方案.docx"]);
        assert.equal(artifacts[0]?.source, "tool");
        assert.equal(
            artifacts[0]?.mimeType,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("bash pptx.sh JSON output becomes an explicit PPTX artifact without a workspace scan", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-pptx-bash-"));
    const pptxPath = join(projectRoot, "exports", "救治教学.pptx");
    try {
        await mkdir(join(projectRoot, "exports"), { recursive: true });
        await writeFile(pptxPath, "PK test pptx");
        const collector = await FileArtifactCollector.start({
            cwd: projectRoot,
            allowWorkspaceDiff: false,
            allowedExtensions: [".pdf", ".docx", ".pptx"],
        });
        collector.observeToolResult({
            type: "success",
            toolCallId: "bash-pptx-1",
            toolName: "bash",
            content: [{
                type: "text",
                text: JSON.stringify({ status: "ok", output: pptxPath, slides: 3 }),
            }],
            data: {
                command: `bash pptx.sh make --out "${pptxPath}"`,
                stdout: JSON.stringify({ status: "ok", output: pptxPath, slides: 3 }),
                stderr: "",
                exitCode: 0,
            },
            startedAt: "2026-08-21T10:00:00.000Z",
            completedAt: "2026-08-21T10:00:01.000Z",
        });
        const artifacts = await collector.finish("complete");
        assert.deepEqual(artifacts.map((artifact) => artifact.path), ["exports/救治教学.pptx"]);
        assert.equal(
            artifacts[0]?.mimeType,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        );
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("bash spreadsheet.sh JSON output becomes an explicit XLSX artifact without a workspace scan", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-xlsx-bash-"));
    const xlsxPath = join(projectRoot, "exports", "救治统计.xlsx");
    try {
        await mkdir(join(projectRoot, "exports"), { recursive: true });
        await writeFile(xlsxPath, "PK test xlsx");
        const collector = await FileArtifactCollector.start({
            cwd: projectRoot,
            allowWorkspaceDiff: false,
            allowedExtensions: [".pdf", ".docx", ".pptx", ".xlsx"],
        });
        collector.observeToolResult({
            type: "success",
            toolCallId: "bash-xlsx-1",
            toolName: "bash",
            content: [{
                type: "text",
                text: JSON.stringify({ status: "ok", output: xlsxPath, formulaCount: 3 }),
            }],
            data: {
                command: `bash spreadsheet.sh make --out "${xlsxPath}"`,
                stdout: JSON.stringify({ status: "ok", output: xlsxPath, formulaCount: 3 }),
                stderr: "",
                exitCode: 0,
            },
            startedAt: "2026-08-21T10:00:00.000Z",
            completedAt: "2026-08-21T10:00:01.000Z",
        });
        const artifacts = await collector.finish("complete");
        assert.deepEqual(artifacts.map((artifact) => artifact.path), ["exports/救治统计.xlsx"]);
        assert.equal(
            artifacts[0]?.mimeType,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("bash diagram.sh JSON output becomes an explicit SVG artifact without a workspace scan", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-svg-bash-"));
    const svgPath = join(projectRoot, "exports", "救治流程.svg");
    try {
        await mkdir(join(projectRoot, "exports"), { recursive: true });
        await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
        const collector = await FileArtifactCollector.start({
            cwd: projectRoot,
            allowWorkspaceDiff: false,
            allowedExtensions: [".pdf", ".docx", ".pptx", ".xlsx", ".svg"],
        });
        collector.observeToolResult({
            type: "success",
            toolCallId: "bash-svg-1",
            toolName: "bash",
            content: [{
                type: "text",
                text: JSON.stringify({ status: "ok", output: svgPath, nodes: 3, edges: 2 }),
            }],
            data: {
                command: `bash diagram.sh make --out "${svgPath}"`,
                stdout: JSON.stringify({ status: "ok", output: svgPath, nodes: 3, edges: 2 }),
                stderr: "",
                exitCode: 0,
            },
            startedAt: "2026-08-21T10:00:00.000Z",
            completedAt: "2026-08-21T10:00:01.000Z",
        });
        const artifacts = await collector.finish("complete");
        assert.deepEqual(artifacts.map((artifact) => artifact.path), ["exports/救治流程.svg"]);
        assert.equal(artifacts[0]?.mimeType, "image/svg+xml");
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
test("general-chat PDF collection ignores non-pdf writes even when bash mutates the workspace", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-pdf-filter-"));
    try {
        await writeFile(join(projectRoot, "notes.md"), "before");
        const collector = await FileArtifactCollector.start({
            cwd: projectRoot,
            allowWorkspaceDiff: false,
            allowedExtensions: [".pdf"],
        });
        await writeFile(join(projectRoot, "notes.md"), "after");
        await writeFile(join(projectRoot, "ignored.json"), "{}");
        collector.observeToolResult({
            ...toolResult("write_file"),
            data: { filePath: join(projectRoot, "ignored.json") },
        });
        assert.deepEqual(await collector.finish("complete"), []);
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
