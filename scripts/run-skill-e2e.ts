/**
 * Full-skill acceptance: one isolated Gateway session per skill.
 * Connects to an already-running PilotDeck server (scripts/start-local.sh).
 * Does not start vLLM. Behavioral checks only — no medical content scoring.
 *
 * Usage:
 *   npm run test:skills
 *   npx tsx scripts/run-skill-e2e.ts --only pdf,docx
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectRemoteGatewayIfAvailable } from "../src/gateway/index.js";
import type { ChannelAttachment, Gateway, GatewayEvent } from "../src/gateway/protocol/types.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CASES_PATH = join(REPO_ROOT, "tests/skill-e2e/cases.json");
const FIXTURE_ROOT = join(REPO_ROOT, "tests/skill-e2e/fixtures");
const WORK_ROOT = join(REPO_ROOT, "tests/skill-e2e/work");
const DOCUMENT_KINDS = new Set(["document"]);

type CaseKind = "medical" | "document";

type CaseDef = {
  id: string;
  kind: CaseKind;
  skill: string;
  /** Require an explicit read_skill call. Defaults to true. */
  requireSkillLoad?: boolean;
  timeoutMs: number;
  message: string;
  attachments?: Array<{ type: ChannelAttachment["type"]; name: string; from: string; mimeType?: string }>;
  copyDir?: string;
  expectTools?: string[];
  /** Tool must be invoked; success is not required (e.g. ask_user_question with canPrompt=false). */
  expectToolsCalled?: string[];
  forbidTools?: string[];
  expectToolCounts?: Record<string, number>;
  expectBashNeedle?: string;
  forbidBashNeedles?: string[];
  expectToolArgNeedles?: Array<{ tool: string; needle: string }>;
  expectOutputGlob?: string;
  expectOutputUnder?: string;
  expectAssistantContains?: string[];
  requireBatchDirArg?: boolean;
  requireStagePlanBehavior?: boolean;
  allowEmptyAssistant?: boolean;
  /** Elicitation observation cases intentionally abort before a normal turn completion. */
  allowIncompleteTurn?: boolean;
  /** Expose interactive tools to the model for this case. */
  canPrompt?: boolean;
  /** Abort after observing this tool call so headless tests do not wait for user input. */
  abortAfterToolCall?: string;
};

type CaseResult = {
  id: string;
  kind: CaseKind;
  skill: string;
  pass: boolean;
  reasons: string[];
  tools: string[];
  elapsedMs: number;
};

function parseOnlyFlag(argv: string[]): Set<string> | undefined {
  const idx = argv.indexOf("--only");
  if (idx < 0 || !argv[idx + 1]) {
    return undefined;
  }
  return new Set(
    argv[idx + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await walkFiles(full)));
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  } catch {
    return out;
  }
  return out;
}

function globExts(pattern: string): string[] {
  const brace = pattern.match(/\*\.\{([^}]+)\}$/);
  if (brace) {
    return brace[1].split(",").map((e) => `.${e.trim().replace(/^\./, "")}`);
  }
  const simple = pattern.match(/\*(\.[A-Za-z0-9]+)$/);
  if (simple) {
    return [simple[1]];
  }
  return [];
}

function matchesOutputGlob(path: string, pattern: string): boolean {
  const exts = globExts(pattern);
  if (exts.length === 0) {
    return path.endsWith(pattern.replace(/^\*/, ""));
  }
  const ext = extname(path).toLowerCase();
  return exts.some((e) => e.toLowerCase() === ext);
}

function skillLoaded(tools: Array<{ name: string; args?: string }>, skill: string): boolean {
  const needle = skill.toLowerCase();
  return tools.some((t) => {
    if (t.name !== "read_skill") {
      return false;
    }
    return (t.args ?? "").toLowerCase().includes(needle);
  });
}

function bashCommand(args: string | undefined): string {
  if (!args) {
    return "";
  }
  try {
    const parsed = JSON.parse(args) as { command?: unknown };
    if (typeof parsed.command === "string") {
      return parsed.command;
    }
  } catch {
    // Fall back to the preview text when it is truncated or not JSON.
  }
  return args;
}

function normalizeShellForMatching(value: string): string {
  return value
    .replace(/\\"/g, "\"")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function bashHit(tools: Array<{ name: string; args?: string }>, needle: string): boolean {
  const normalizedNeedle = normalizeShellForMatching(needle);
  return tools.some(
    (t) =>
      t.name === "bash"
      && normalizeShellForMatching(bashCommand(t.args)).includes(normalizedNeedle),
  );
}

function stagePlanBehaviorOk(previews: string[]): boolean {
  const text = previews.join("\n");
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (typeof obj.care_plan === "string" && obj.care_plan.trim().length > 0) {
      return true;
    }
    if (obj.fallback_used === true || obj.agent_continue === true) {
      return true;
    }
  } catch {
    // preview may be truncated / wrapped
  }
  if (/"care_plan"\s*:\s*"(?:\\.|[^"\\])+"/.test(text) && !/"care_plan"\s*:\s*""/.test(text)) {
    return true;
  }
  return /fallback_used|agent_continue/.test(text);
}

function isMedToolsSkillGateResult(
  tool: { preview?: string },
): boolean {
  return (tool.preview ?? "").includes("<med-tools-skill-gate>");
}

async function prepareWorkDir(c: CaseDef): Promise<{ workDir: string; batchDir?: string }> {
  const workDir = join(WORK_ROOT, `${c.id}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  let batchDir: string | undefined;
  if (c.copyDir) {
    batchDir = join(workDir, c.copyDir);
    await cp(join(FIXTURE_ROOT, c.copyDir), batchDir, { recursive: true });
  }
  if (c.attachments) {
    for (const att of c.attachments) {
      const dest = join(workDir, att.name);
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(FIXTURE_ROOT, att.from), dest);
    }
  }
  return { workDir, batchDir };
}

function buildAttachments(c: CaseDef, workDir: string): ChannelAttachment[] {
  if (!c.attachments) {
    return [];
  }
  return c.attachments.map((att) => ({
    type: att.type,
    name: att.name,
    path: join(workDir, att.name),
    mimeType: att.mimeType,
  }));
}

async function runCase(gateway: Gateway, c: CaseDef): Promise<CaseResult> {
  const started = Date.now();
  const reasons: string[] = [];
  const { workDir, batchDir } = await prepareWorkDir(c);
  const message = c.message.replaceAll("{{BATCH_DIR}}", batchDir ?? workDir);
  const created = await gateway.newSession({
    channelKey: "cli",
    projectKey: REPO_ROOT,
    hint: `skill-e2e:${c.id}`,
  });
  const sessionKey = created.sessionKey;
  const tools: Array<{ id: string; name: string; args?: string; ok?: boolean; preview?: string }> = [];
  const toolsById = new Map<string, (typeof tools)[number]>();
  let assistant = "";
  let modelStarted = 0;
  let turnCompleted = false;
  let fatalError: string | undefined;
  const runId = randomUUID();

  try {
    const stream = gateway.submitTurn({
      sessionKey,
      channelKey: "cli",
      projectKey: REPO_ROOT,
      workspaceCwd: workDir,
      message,
      attachments: buildAttachments(c, workDir),
      runMode: "agent",
      mode: "bypassPermissions",
      basePermissionMode: "bypassPermissions",
      canPrompt: c.canPrompt ?? false,
      runId,
      timeoutMs: c.timeoutMs,
    });

    const watchdog = setTimeout(() => {
      void gateway.abortTurn({ sessionKey, runId, reason: "skill-e2e-timeout" });
    }, c.timeoutMs + 15_000);

    try {
      for await (const event of stream as AsyncIterable<GatewayEvent>) {
        if (event.type === "model_request_started") {
          modelStarted += 1;
          process.stderr.write(`[${c.id}] model request\n`);
        } else if (event.type === "assistant_text_delta") {
          assistant += event.text;
        } else if (event.type === "tool_call_started") {
          const row = { id: event.toolCallId, name: event.name, args: event.argsPreview };
          tools.push(row);
          toolsById.set(event.toolCallId, row);
          process.stderr.write(`[${c.id}] tool ${event.name} ${event.argsPreview ?? ""}\n`.slice(0, 400) + "\n");
          if (c.abortAfterToolCall === event.name) {
            void gateway.abortTurn({
              sessionKey,
              runId,
              reason: `skill-e2e-observed-${event.name}`,
            });
          }
        } else if (event.type === "tool_call_finished") {
          const row = toolsById.get(event.toolCallId);
          if (row) {
            row.ok = event.ok;
            row.preview = event.resultPreview;
          }
        } else if (event.type === "turn_completed") {
          turnCompleted = true;
        } else if (event.type === "error") {
          fatalError = event.message;
          if (!event.recoverable) {
            reasons.push(`gateway error: ${event.message}`);
          }
        }
      }
    } finally {
      clearTimeout(watchdog);
    }
  } catch (err) {
    reasons.push(`submitTurn threw: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      await gateway.closeSession({ sessionKey, reason: "skill-e2e-done" });
    } catch {
      // ignore
    }
  }

  if (modelStarted < 1) {
    reasons.push("main model was not called");
  }
  if (fatalError && !turnCompleted && !c.allowIncompleteTurn) {
    reasons.push(`turn did not complete (${fatalError})`);
  }
  if (c.requireSkillLoad !== false && !skillLoaded(tools, c.skill)) {
    reasons.push(`skill not loaded via read_skill (${c.skill})`);
  }
  for (const name of c.expectTools ?? []) {
    const hits = tools.filter((t) => t.name === name);
    if (hits.length === 0) {
      reasons.push(`missing tool ${name}`);
    } else if (!hits.some((t) => t.ok === true && !isMedToolsSkillGateResult(t))) {
      if (hits.some(isMedToolsSkillGateResult)) {
        reasons.push(`tool ${name} was skill-gated but not retried`);
        continue;
      }
      reasons.push(`tool ${name} did not finish successfully`);
    }
  }
  for (const name of c.expectToolsCalled ?? []) {
    if (!tools.some((t) => t.name === name)) {
      reasons.push(`missing tool call ${name}`);
    }
  }
  for (const { tool, needle } of c.expectToolArgNeedles ?? []) {
    const hits = tools.filter((t) => t.name === tool);
    if (hits.length === 0) {
      reasons.push(`missing tool ${tool} (needed arg ${needle})`);
    } else if (!hits.some((t) => (t.args ?? "").includes(needle))) {
      reasons.push(`tool ${tool} args missing ${needle}`);
    }
  }
  for (const name of c.forbidTools ?? []) {
    if (tools.some((t) => t.name === name)) {
      reasons.push(`forbidden tool was called: ${name}`);
    }
  }
  for (const [name, expectedCount] of Object.entries(c.expectToolCounts ?? {})) {
    const actualCount = tools.filter((t) => t.name === name).length;
    if (actualCount !== expectedCount) {
      reasons.push(`tool ${name} called ${actualCount} time(s), expected ${expectedCount}`);
    }
  }
  if (c.expectBashNeedle && !bashHit(tools, c.expectBashNeedle)) {
    reasons.push(`bash did not invoke ${c.expectBashNeedle}`);
  }
  for (const needle of c.forbidBashNeedles ?? []) {
    if (bashHit(tools, needle)) {
      reasons.push(`bash invoked forbidden path: ${needle}`);
    }
  }
  if (c.requireBatchDirArg) {
    const parseCalls = tools.filter((t) => t.name === "mcp__med-tools__med_parse_medical");
    if (!batchDir || !parseCalls.some((t) => (t.args ?? "").includes(batchDir))) {
      reasons.push("med_parse_medical did not receive the prepared batch directory");
    }
  }
  if (c.expectOutputGlob) {
    const skip = new Set((c.attachments ?? []).map((a) => join(workDir, a.name)));
    const outputRoot = c.expectOutputUnder ? join(workDir, c.expectOutputUnder) : workDir;
    const files = (await walkFiles(outputRoot)).filter((p) => !skip.has(p));
    const hits = files.filter((p) => matchesOutputGlob(p, c.expectOutputGlob!));
    if (hits.length === 0) {
      const location = c.expectOutputUnder ? ` under ${c.expectOutputUnder}/` : "";
      reasons.push(`no output matching ${c.expectOutputGlob}${location}`);
    }
  }
  for (const expectedText of c.expectAssistantContains ?? []) {
    if (!assistant.includes(expectedText)) {
      reasons.push(`final assistant message missing: ${expectedText}`);
    }
  }
  if (c.requireStagePlanBehavior) {
    const previews = tools
      .filter((t) => t.name === "mcp__med-tools__med_trauma_stage_plan")
      .map((t) => t.preview ?? "");
    if (!stagePlanBehaviorOk(previews)) {
      reasons.push("stage-plan care_plan empty and no fallback recorded");
    }
  }
  if (!c.allowEmptyAssistant && assistant.trim().length === 0) {
    reasons.push("empty final assistant message");
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    id: c.id,
    kind: c.kind,
    skill: c.skill,
    pass: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    tools: tools.map((t) => t.name),
    elapsedMs: Date.now() - started,
  };
}

function printSummary(results: CaseResult[]): number {
  const pad = Math.max(...results.map((r) => r.id.length), 8);
  process.stdout.write("\n=== skill e2e ===\n");
  for (const r of results) {
    const status = r.pass ? "PASS" : "FAIL";
    const extra = r.pass ? "" : `  ${r.reasons.join("; ")}`;
    process.stdout.write(
      `${r.id.padEnd(pad)}  ${status}  ${(r.elapsedMs / 1000).toFixed(1)}s  tools=[${r.tools.join(", ")}]${extra}\n`,
    );
  }
  const failedDocs = results.filter((r) => !r.pass && DOCUMENT_KINDS.has(r.kind));
  const failedAny = results.filter((r) => !r.pass);
  if (failedDocs.length > 0) {
    process.stdout.write(
      `\n文档skill not pass: ${failedDocs.map((r) => r.id).join(", ")}\n`,
    );
  }
  if (failedAny.length > 0) {
    process.stdout.write(`OVERALL FAIL (${failedAny.length}/${results.length})\n`);
    return 1;
  }
  process.stdout.write(`OVERALL PASS (${results.length}/${results.length})\n`);
  return 0;
}

async function main(): Promise<void> {
  const only = parseOnlyFlag(process.argv.slice(2));
  process.env.PILOT_HOME ??= join(REPO_ROOT, ".pilotdeck-home");

  const raw = JSON.parse(await readFile(CASES_PATH, "utf8")) as { cases: CaseDef[] };
  const cases = raw.cases.filter((c) => !only || only.has(c.id) || only.has(c.skill));
  if (cases.length === 0) {
    console.error("No cases selected.");
    process.exitCode = 1;
    return;
  }

  const gatewayUrl = process.env.PILOTDECK_GATEWAY_URL ?? "http://127.0.0.1:18789";
  const gateway = await connectRemoteGatewayIfAvailable({ url: gatewayUrl, timeoutMs: 2000 });
  if (!gateway) {
    console.error(
      `Gateway not reachable at ${gatewayUrl}. Start the local stack first: bash scripts/start-local.sh`,
    );
    process.exitCode = 1;
    return;
  }

  const results: CaseResult[] = [];
  try {
    for (const c of cases) {
      process.stderr.write(`\n--- ${c.id} (new session) ---\n`);
      results.push(await runCase(gateway, c));
    }
    process.exitCode = printSummary(results);
  } finally {
    gateway.close();
  }
}

await main();
