#!/usr/bin/env node
/**
 * 多用户模式技能端到端基线脚本（Task 12.0）。
 *
 * 走与浏览器完全一致的路径：登录 UI 服务器 → 创建系统项目 → 上传附件 →
 * WebSocket 发 `pilotdeck-command` → 收集流回浏览器的帧。因此它经过
 * 网关池、每用户网关的 bash 沙箱、UI 服务器的路径清洗这三层。
 *
 * 与 scripts/run-skill-e2e.ts 的区别：后者直连单机网关，绕过以上三层。
 *
 * 用法：
 *   npx tsx scripts/run-skill-e2e-multiuser.ts [--only pdf,docx] [--server http://127.0.0.1:3020]
 *       [--admin-user admin] [--admin-pass passok] [--user e2e-a] [--pass e2e-pass-123]
 *
 * 只记录行为：调了哪些工具、产物是否落在用户工作区、帧里是否泄露绝对路径。不评估医学内容。
 */
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CASES_PATH = join(REPO_ROOT, "tests/skill-e2e/cases-multiuser.json");
const FIXTURE_ROOT = join(REPO_ROOT, "tests/skill-e2e/fixtures");
const REPORT_ROOT = join(REPO_ROOT, "tests/skill-e2e/work");

type CaseDef = {
  id: string;
  kind: "document" | "medical" | "prompt";
  skill: string;
  tier: 1 | 2 | 3;
  message: string;
  timeoutMs?: number;
  requireSkillLoad?: boolean;
  attachments?: Array<{ name: string; from: string; mimeType?: string }>;
  expectTools?: string[];
  expectToolsCalled?: string[];
  forbidTools?: string[];
  expectBashNeedle?: string;
  forbidBashNeedles?: string[];
  expectToolArgNeedles?: Array<{ tool: string; needle: string }>;
  expectOutputGlob?: string;
  expectOutputUnder?: string;
  expectAssistantContains?: string[];
  requireBatchDirArg?: boolean;
  requireStagePlanBehavior?: boolean;
  allowEmptyAssistant?: boolean;
  abortAfterToolCall?: string;
  /** 远程服务不可用时记为"当前环境无法测试"而不是失败。 */
  needsRemote?: string;
  /** Whether the model may use interactive prompt tools for this case. */
  canPrompt?: boolean;
};

type Frame = Record<string, unknown> & { kind?: string; toolName?: string; toolInput?: unknown; content?: unknown; isError?: boolean };

type CaseResult = {
  id: string;
  tier: number;
  skill: string;
  status: "PASS" | "FAIL" | "UNTESTABLE" | "INFRA_ERROR";
  leak: boolean;
  metadataLeak: boolean;
  reasons: string[];
  tools: string[];
  outputs: string[];
  elapsedMs: number;
};

type TurnStopReason =
  | "complete"
  | "error"
  | "closed"
  | "timeout"
  | "first_frame_timeout"
  | "connection_timeout"
  | "connection_error";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SERVER = arg("--server", process.env.PILOTDECK_E2E_SERVER ?? "http://127.0.0.1:3020");
const ADMIN_USER = arg("--admin-user", process.env.PILOTDECK_E2E_ADMIN_USER ?? "admin");
const ADMIN_PASS = arg("--admin-pass", process.env.PILOTDECK_E2E_ADMIN_PASS ?? process.env.PILOTDECK_ADMIN_PASSWORD ?? "passok");
const TEST_USER = arg("--user", "e2e-a");
const TEST_PASS = arg("--pass", "e2e-pass-123");
const ONLY = (() => {
  const v = arg("--only", "");
  return v ? new Set(v.split(",").map((s) => s.trim()).filter(Boolean)) : undefined;
})();

// ---------------------------------------------------------------- HTTP 辅助

async function api(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  return fetch(`${SERVER}${path}`, { ...init, headers });
}

async function login(username: string, password: string): Promise<{ token: string; id: number }> {
  const res = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { token: string; user: { id: number } };
  return { token: json.token, id: json.user.id };
}

async function ensureTestUser(adminToken: string): Promise<void> {
  const res = await api("/api/admin/users", {
    method: "POST",
    token: adminToken,
    body: JSON.stringify({ username: TEST_USER, password: TEST_PASS, role: "user" }),
  });
  if (res.status === 201 || res.status === 409) return;
  throw new Error(`create user ${TEST_USER} failed: ${res.status} ${await res.text()}`);
}

async function createProject(token: string, displayName: string): Promise<{ name: string; fullPath: string }> {
  const res = await api("/api/projects/create-system", {
    method: "POST",
    token,
    body: JSON.stringify({ displayName, type: "general_medicine" }),
  });
  if (!res.ok) throw new Error(`create project failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { project: { name: string; fullPath: string } };
  return json.project;
}

async function uploadAttachments(
  token: string,
  projectName: string,
  files: Array<{ name: string; from: string; mimeType?: string }>,
): Promise<{ files: Array<{ name: string; path: string; size?: number; mimeType?: string }>; attachmentDir: string | null }> {
  const form = new FormData();
  for (const f of files) {
    const bytes = await readFile(join(FIXTURE_ROOT, f.from));
    form.append("attachments", new Blob([bytes], { type: f.mimeType ?? "application/octet-stream" }), f.name);
  }
  const res = await api(`/api/projects/${encodeURIComponent(projectName)}/upload-attachments`, {
    method: "POST",
    token,
    body: form,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { files?: unknown[]; images?: unknown[]; attachmentDir: string | null };
  const all = [...((json.files as never[]) ?? []), ...((json.images as never[]) ?? [])] as Array<{
    name: string; path: string; size?: number; mimeType?: string;
  }>;
  return { files: all.filter((f) => f?.path), attachmentDir: json.attachmentDir };
}

// ---------------------------------------------------------------- WebSocket 回合

export async function runTurn(
  token: string,
  payload: { command: string; options: Record<string, unknown> },
  opts: {
    timeoutMs: number;
    firstFrameTimeoutMs?: number;
    connectionTimeoutMs?: number;
    abortAfterToolCall?: string;
  },
): Promise<{
  frames: Frame[];
  timedOut: boolean;
  sessionId?: string;
  stopReason: TurnStopReason;
  closeCode?: number;
  closeReason?: string;
}> {
  const wsUrl = `${SERVER.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  const frames: Frame[] = [];
  let sessionId: string | undefined;
  let sessionCreated = false;
  let timedOut = false;
  let aborted = false;
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  const connectionResult = await new Promise<{ ok: true } | { ok: false; reason: "connection_timeout" | "connection_error"; error?: string }>((resolveConnection) => {
    let settled = false;
    const connectionTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveConnection({ ok: false, reason: "connection_timeout" });
    }, opts.connectionTimeoutMs ?? 10_000);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimer);
      resolveConnection({ ok: true });
    }, { once: true });
    ws.addEventListener("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimer);
      resolveConnection({
        ok: false,
        reason: "connection_error",
        error: String((e as ErrorEvent).message ?? e),
      });
    }, { once: true });
  });
  if (connectionResult.ok === false) {
    try { ws.close(); } catch { /* ignore */ }
    return {
      frames,
      timedOut: false,
      stopReason: connectionResult.reason,
    };
  }

  const t0 = Date.now();
  const log = (m: string) => process.stderr.write(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
  const done = new Promise<TurnStopReason>((resolveDone) => {
    let settled = false;
    let firstFrameSeen = false;
    const firstFrameTimer = setTimeout(() => {
      if (settled || firstFrameSeen) return;
      settled = true;
      resolveDone("first_frame_timeout");
    }, opts.firstFrameTimeoutMs ?? 30_000);
    const turnTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      resolveDone("timeout");
    }, opts.timeoutMs);
    const finish = (reason: TurnStopReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(firstFrameTimer);
      clearTimeout(turnTimer);
      resolveDone(reason);
    };
    ws.addEventListener("message", (ev) => {
      let frame: Frame;
      try { frame = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
      if (frame.kind === "session_created" && typeof frame.newSessionId === "string") {
        if (sessionId && frame.newSessionId !== sessionId) return;
        sessionId = frame.newSessionId;
        sessionCreated = true;
      } else if (
        typeof frame.sessionId === "string"
        && ((!sessionCreated) || frame.sessionId !== sessionId)
      ) {
        // A timed-out turn may finish after its client socket closes. The UI
        // server's same-user reconnect fallback can deliver that late frame
        // to a newer socket, so never let another session terminate this turn.
        return;
      }
      if (!firstFrameSeen) {
        firstFrameSeen = true;
        clearTimeout(firstFrameTimer);
        log(`first frame kind=${String(frame.kind ?? frame.type ?? "unknown")}`);
      }
      frames.push(frame);
      if (
        opts.abortAfterToolCall && !aborted && frame.kind === "tool_use"
        && matchesTool(String(frame.toolName ?? ""), opts.abortAfterToolCall)
      ) {
        aborted = true;
        ws.send(JSON.stringify({ type: "abort-session", sessionId, provider: "pilotdeck" }));
      }
      if (sessionCreated && frame.kind === "complete") finish("complete");
      else if (sessionCreated && (frame.kind === "error" || frame.type === "error")) finish("error");
    });
    ws.addEventListener("close", (ev) => {
      closeCode = ev.code;
      closeReason = ev.reason;
      finish("closed");
    });
    ws.addEventListener("error", () => finish("connection_error"));
    log("ws open, sending command");
    ws.send(JSON.stringify({ type: "pilotdeck-command", ...payload }));
  });

  const stopReason = await done;
  if (stopReason === "timeout" || stopReason === "first_frame_timeout") {
    if (sessionId) {
      try {
        ws.send(JSON.stringify({ type: "abort-session", sessionId, provider: "pilotdeck" }));
      } catch { /* the socket may already be closing */ }
    }
  }
  log(`turn ${stopReason}; frames=${frames.length}; kinds=${[...new Set(frames.map((f) => String(f.kind ?? f.type ?? "unknown")))].join(",")}`);
  try { ws.close(); } catch { /* ignore */ }
  return { frames, timedOut, sessionId, stopReason, closeCode, closeReason };
}

// ---------------------------------------------------------------- 断言辅助

/** bridge 会把 bash→Bash、read_file→Read 等改名；MCP 工具保留 mcp__<server>__<tool>。统一不区分大小写并允许后缀匹配。 */
function matchesTool(actual: string, expected: string): boolean {
  const a = actual.toLowerCase();
  const e = expected.toLowerCase();
  const alias: Record<string, string> = { bash: "bash", read: "read_file", write: "write_file", edit: "edit_file", glob: "glob", grep: "grep", task: "agent", askuserquestion: "ask_user_question" };
  const an = alias[a] ?? a;
  const en = alias[e] ?? e;
  return an === en || an.endsWith(`__${en}`) || en.endsWith(`__${an}`);
}

function toolCalls(frames: Frame[]): Array<{ name: string; input: unknown; args: string }> {
  return frames
    .filter((f) => f.kind === "tool_use")
    .map((f) => ({ name: String(f.toolName ?? ""), input: f.toolInput, args: JSON.stringify(f.toolInput ?? "") }));
}

function assistantText(frames: Frame[]): string {
  return frames.filter((f) => f.kind === "stream_delta").map((f) => String(f.content ?? "")).join("");
}

function isUserVisibleOutputFrame(frame: Frame): boolean {
  return new Set([
    "stream_delta",
    "thinking",
    "tool_use",
    "tool_result",
    "error",
    "file_artifacts",
    "agent_activity",
    "permission_request",
    "status",
  ]).has(String(frame.kind ?? ""));
}

function normalizeShell(v: string): string {
  return v.replace(/\\"/g, '"').replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function globMatch(path: string, pattern: string): boolean {
  const m = pattern.match(/\*(\.[A-Za-z0-9]+)$/);
  return m ? extname(path).toLowerCase() === m[1].toLowerCase() : path.endsWith(pattern.replace(/^\*/, ""));
}

function stagePlanOk(resultContents: string[]): boolean {
  const text = resultContents.join("\n");
  return /"care_plan"\s*:\s*"(?:\\.|[^"\\])+"/.test(text) || /fallback_used|agent_continue/.test(text);
}

function remoteUnavailable(frames: Frame[]): boolean {
  const txt = frames.filter((f) => f.kind === "tool_result" || f.kind === "error").map((f) => JSON.stringify(f)).join("\n");
  return /disabled|MED_SPECIALIZED_CT_ENABLED|ECONNREFUSED|connection_refused|fetch failed|unreachable|not reachable|timed out|Request timed out|service .*unavailable|not configured/i.test(txt);
}

function modelInfrastructureFailure(frames: Frame[], stopReason: TurnStopReason): boolean {
  if (stopReason === "connection_timeout" || stopReason === "connection_error" || stopReason === "closed"
    || stopReason === "first_frame_timeout") {
    return true;
  }
  if (stopReason === "timeout") {
    const hasToolProgress = frames.some((f) => f.kind === "tool_use" || f.kind === "tool_result");
    return !hasToolProgress;
  }
  const errors = frames
    .filter((f) => f.kind === "error" || f.type === "error")
    .map((f) => JSON.stringify(f))
    .join("\n");
  return /agent_model_error|model_request_failed|gateway_unavailable|gateway_bridge_error|fetch failed|connection_refused|ECONNREFUSED|terminated|model .*unavailable/i.test(errors);
}

// ---------------------------------------------------------------- 单用例

async function runCase(
  c: CaseDef,
  ctx: { token: string; userHome: string; project: { name: string; fullPath: string }; outDir: string },
): Promise<CaseResult> {
  const started = Date.now();
  const reasons: string[] = [];
  const before = new Set(await walk(ctx.project.fullPath));

  let attachments: Array<{ name: string; path: string; size?: number; mimeType?: string }> = [];
  let batchDir: string | null = null;
  if (c.attachments?.length) {
    const up = await uploadAttachments(ctx.token, ctx.project.name, c.attachments);
    attachments = up.files;
    batchDir = up.attachmentDir;
  }
  const message = c.message.replaceAll("{{BATCH_DIR}}", batchDir ?? ctx.project.fullPath);

  const { frames, timedOut, stopReason, closeCode, closeReason } = await runTurn(
    ctx.token,
    {
      command: message,
      options: {
        projectPath: ctx.project.fullPath,
        cwd: ctx.project.fullPath,
        permissionMode: "bypassPermissions",
        runMode: "agent",
        canPrompt: c.canPrompt ?? false,
        ...(attachments.length ? { attachments } : {}),
      },
    },
    { timeoutMs: c.timeoutMs ?? 180_000, abortAfterToolCall: c.abortAfterToolCall },
  );

  const calls = toolCalls(frames);
  const toolNames = calls.map((t) => t.name);
  const text = assistantText(frames);
  const resultContents = frames.filter((f) => f.kind === "tool_result").map((f) => String(f.content ?? ""));
  const after = await walk(ctx.project.fullPath);
  const newFiles = after.filter((p) => !before.has(p) && !attachments.some((a) => a.path === p));

  // Separate user-visible agent output from transport metadata. The UI still
  // receives absolute paths in projects_updated today, but that is a
  // different boundary from the path leak reported in the conversation.
  const metadataLeak = frames.some((f) => JSON.stringify(f).includes(ctx.userHome));
  const leak = frames.some((f) => isUserVisibleOutputFrame(f) && JSON.stringify(f).includes(ctx.userHome));
  if (leak) reasons.push("LEAK: user-visible frames contain the user's absolute home path");
  if (metadataLeak && !leak) reasons.push("metadata contains the user's absolute home path (projects_updated or equivalent)");

  if (stopReason !== "complete") {
    const detail = [
      stopReason,
      closeCode !== undefined ? `close=${closeCode}` : "",
      closeReason ? `reason=${closeReason}` : "",
    ].filter(Boolean).join(", ");
    reasons.push(`turn ended without complete: ${detail}`);
  }
  if (timedOut && !c.abortAfterToolCall) reasons.push(`timed out after ${c.timeoutMs ?? 180_000}ms`);
  if (c.requireSkillLoad !== false) {
    const loaded = calls.some((t) => matchesTool(t.name, "read_skill") && t.args.toLowerCase().includes(c.skill.toLowerCase()));
    if (!loaded) reasons.push(`read_skill(${c.skill}) not called`);
  }
  for (const t of c.expectTools ?? []) {
    const ok = frames.some((f, i) => f.kind === "tool_use" && matchesTool(String(f.toolName), t)
      && frames.slice(i + 1).some((r) => r.kind === "tool_result" && r.toolId === f.toolId && !r.isError));
    if (!ok) reasons.push(`expected successful tool ${t}`);
  }
  for (const t of c.expectToolsCalled ?? []) if (!toolNames.some((n) => matchesTool(n, t))) reasons.push(`expected tool call ${t}`);
  for (const t of c.forbidTools ?? []) if (toolNames.some((n) => matchesTool(n, t))) reasons.push(`forbidden tool called ${t}`);
  const bashCmds = calls.filter((t) => matchesTool(t.name, "bash")).map((t) => normalizeShell(String((t.input as { command?: string })?.command ?? t.args)));
  if (c.expectBashNeedle && !bashCmds.some((cmd) => cmd.includes(normalizeShell(c.expectBashNeedle!)))) reasons.push(`bash needle missing: ${c.expectBashNeedle}`);
  for (const n of c.forbidBashNeedles ?? []) if (bashCmds.some((cmd) => cmd.includes(normalizeShell(n)))) reasons.push(`forbidden bash needle: ${n}`);
  for (const { tool, needle } of c.expectToolArgNeedles ?? []) {
    if (!calls.some((t) => matchesTool(t.name, tool) && t.args.includes(needle))) reasons.push(`arg needle missing: ${tool} ~ ${needle}`);
  }
  if (c.requireBatchDirArg && batchDir && !calls.some((t) => t.args.includes(batchDir!))) reasons.push("tool args never referenced the uploaded batch dir");
  if (c.requireStagePlanBehavior && !stagePlanOk(resultContents)) reasons.push("no care_plan / fallback_used / agent_continue in results");
  if (c.expectOutputGlob) {
    const hits = newFiles.filter((p) => globMatch(p, c.expectOutputGlob!));
    if (hits.length === 0) reasons.push(`no new output matching ${c.expectOutputGlob} under user workspace`);
    else if (c.expectOutputUnder && !hits.some((p) => p.includes(`/${c.expectOutputUnder}/`))) reasons.push(`output not under ${c.expectOutputUnder}/`);
  }
  for (const s of c.expectAssistantContains ?? []) if (!text.includes(s)) reasons.push(`assistant text missing: ${s}`);
  if (!c.allowEmptyAssistant && !text.trim() && !c.abortAfterToolCall) reasons.push("empty assistant text");

  const functional = reasons.filter((r) =>
    !r.startsWith("LEAK")
    && !r.startsWith("metadata contains")
    && !r.startsWith("turn ended without complete:")
  );
  const infra = modelInfrastructureFailure(frames, stopReason);
  let status: CaseResult["status"] = functional.length === 0 && stopReason === "complete" ? "PASS" : "FAIL";
  if (status === "FAIL" && c.needsRemote && remoteUnavailable(frames)) {
    status = "UNTESTABLE";
    reasons.unshift(`当前环境无法测试：${c.needsRemote} 不可用`);
  } else if (status === "FAIL" && infra) {
    status = "INFRA_ERROR";
    reasons.unshift("基础设施错误：WebSocket、Gateway 或模型请求未能正常完成");
  }
  const leakFrames = frames
    .filter((f) => isUserVisibleOutputFrame(f) && JSON.stringify(f).includes(ctx.userHome))
    .map((f) => f.kind ?? "?");
  if (leak) reasons[reasons.findIndex((r) => r.startsWith("LEAK"))] += ` (frames: ${[...new Set(leakFrames)].join(", ")})`;
  await writeFile(join(ctx.outDir, `${c.id}.frames.json`), JSON.stringify(frames, null, 2));
  return {
    id: c.id,
    tier: c.tier,
    skill: c.skill,
    status,
    leak,
    metadataLeak,
    reasons,
    tools: toolNames,
    outputs: newFiles.map((p) => p.slice(ctx.project.fullPath.length + 1)),
    elapsedMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  const health = await fetch(`${SERVER}/health`).catch(() => null);
  let healthJson: { status?: string } | null = null;
  try { healthJson = health?.ok ? await health.json() as { status?: string } : null; } catch { /* invalid health body */ }
  if (!health?.ok || healthJson?.status !== "ok") {
    console.error(`UI server health check failed at ${SERVER}`);
    process.exitCode = 1;
    return;
  }
  const authResponse = await api("/api/auth/status");
  if (!authResponse.ok) {
    console.error(`Auth status check failed: HTTP ${authResponse.status}`);
    process.exitCode = 1;
    return;
  }
  const status = (await authResponse.json()) as { authDisabled: boolean; needsSetup?: boolean };
  if (status.needsSetup) {
    console.error("Server setup is incomplete; cannot run authenticated baseline.");
    process.exitCode = 1;
    return;
  }
  if (status.authDisabled) { console.error("Server is in no-login mode; this script needs PILOTDECK_DISABLE_LOCAL_AUTH=0"); process.exitCode = 1; return; }

  const admin = await login(ADMIN_USER, ADMIN_PASS);
  await ensureTestUser(admin.token);
  const user = await login(TEST_USER, TEST_PASS);
  const project = await createProject(user.token, `e2e-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`);
  const userHome = resolve(project.fullPath).split("/workspaces/")[0];
  process.stderr.write(`user=${TEST_USER}(id=${user.id}) project=${project.name}\nworkspace=${project.fullPath}\n`);

  const raw = JSON.parse(await readFile(CASES_PATH, "utf8")) as { cases: CaseDef[] };
  const cases = raw.cases.filter((c) => !ONLY || ONLY.has(c.id) || ONLY.has(c.skill) || ONLY.has(`tier${c.tier}`));
  if (cases.length === 0) { console.error("No cases selected."); process.exitCode = 1; return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(REPORT_ROOT, `multiuser-${stamp}`);
  await mkdir(outDir, { recursive: true });
  const results: CaseResult[] = [];
  for (const c of cases) {
    process.stderr.write(`\n--- [tier ${c.tier}] ${c.id} ---\n`);
    try {
      const r = await runCase(c, { token: user.token, userHome, project, outDir });
      results.push(r);
      process.stderr.write(`${r.status}${r.leak ? " +LEAK" : ""} (${Math.round(r.elapsedMs / 1000)}s) tools=[${r.tools.join(", ")}]${r.reasons.length ? "\n  " + r.reasons.join("\n  ") : ""}\n`);
    } catch (err) {
      results.push({
        id: c.id,
        tier: c.tier,
        skill: c.skill,
        status: "INFRA_ERROR",
        leak: false,
        metadataLeak: false,
        reasons: [`基础设施错误：测试脚本或服务初始化异常: ${err instanceof Error ? err.message : String(err)}`],
        tools: [],
        outputs: [],
        elapsedMs: 0,
      });
      process.stderr.write(`FAIL threw: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  await writeFile(join(outDir, "results.json"), JSON.stringify({ server: SERVER, user: TEST_USER, userId: user.id, project, results }, null, 2));
  const table = [
    "| 层 | 用例 | 技能 | 状态 | 输出泄露 | 元数据路径 | 工具 | 产物 | 原因 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.tier} | ${r.id} | ${r.skill} | ${r.status} | ${r.leak ? "是" : "否"} | ${r.metadataLeak ? "是" : "否"} | ${r.tools.join(", ") || "-"} | ${r.outputs.join(", ") || "-"} | ${r.reasons.filter((x) => !x.startsWith("LEAK") && !x.startsWith("metadata contains")).join("; ") || "-"} |`),
  ].join("\n");
  await writeFile(join(outDir, "baseline.md"), table + "\n");
  process.stdout.write(`\n${table}\n\nreport: ${outDir}\n`);
  const pass = results.filter((r) => r.status === "PASS").length;
  const untestable = results.filter((r) => r.status === "UNTESTABLE").length;
  const infra = results.filter((r) => r.status === "INFRA_ERROR").length;
  const leaks = results.filter((r) => r.leak).length;
  const metadataLeaks = results.filter((r) => r.metadataLeak).length;
  process.stdout.write(`PASS ${pass}/${results.length}, UNTESTABLE ${untestable}, OUTPUT_LEAK ${leaks}, METADATA_PATH ${metadataLeaks}\n`);
  process.stdout.write(`INFRA_ERROR ${infra}, FAIL ${results.filter((r) => r.status === "FAIL").length}\n`);
  process.exitCode = results.some((r) => r.status === "FAIL" || r.status === "INFRA_ERROR") ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
