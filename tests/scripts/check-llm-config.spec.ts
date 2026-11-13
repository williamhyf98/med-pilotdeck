// @ts-nocheck
// 启动自检 `scripts/check-llm-config.mjs`：并发探测 + 超时归因。
//
// 背景：生产上 10.31.112.47 的两个服务 TCP 40ms 就连上，但 HTTP 一个字节都不回，
// 于是每个目标都要等满 10s；探针又是串行的，启动被拖到 20s+ 且只打印一句 "timeout"。
// 这里锁住两条行为：① 各目标并发，总耗时≈单个超时；② 超时要能区分"连不上"和"连上不回包"。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "scripts", "check-llm-config.mjs"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}

const REPO = findRepoRoot();
const SCRIPT = join(REPO, "scripts", "check-llm-config.mjs");

/** 只听不回：TCP 能连上，但 HTTP 永远等不到响应。 */
function hangServer(): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    const server = http.createServer(() => {
      // 故意不响应
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolvePromise({
        url: `http://127.0.0.1:${port}/v1`,
        port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/** 正常的 OpenAI 兼容端点：chat 与 embeddings 都立即回包。 */
function okServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "OK" } }],
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        }),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** 一个已经关掉的端口：连接会被立即拒绝。 */
async function refusedUrl(): Promise<string> {
  const server = http.createServer(() => {});
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(() => done()));
  return `http://127.0.0.1:${port}/v1`;
}

function writePilotHome(providers: Record<string, unknown>, main: string): string {
  const home = mkdtempSync(join(tmpdir(), "llm-check-"));
  const lines = [
    "agent:",
    `  model: ${main}`,
    "model:",
    "  providers:",
  ];
  for (const [id, provider] of Object.entries(providers)) {
    lines.push(`    ${id}:`);
    lines.push(`      url: ${provider.url}`);
    lines.push("      protocol: openai");
    lines.push("      apiKey: EMPTY");
    if (provider.probeTimeoutMs) lines.push(`      probeTimeoutMs: ${provider.probeTimeoutMs}`);
    lines.push("      models:");
    for (const modelId of provider.models) lines.push(`        "${modelId}": {}`);
  }
  writeFileSync(join(home, "pilotdeck.yaml"), `${lines.join("\n")}\n`);
  return home;
}

/**
 * 必须用**异步** execFile：spawnSync 会阻塞父进程事件循环，同进程里起的假服务
 * 就再也回不了 HTTP 响应，测出来全是超时（踩过一次）。
 */
function runCli(home: string, timeoutMs: number) {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SCRIPT, "--pilot-home", home],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, PILOTDECK_LLM_CHECK_TIMEOUT_MS: String(timeoutMs) },
      },
      (error, stdout, stderr) => {
        resolvePromise({
          status: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          durationMs: Date.now() - started,
        });
      },
    );
  });
}

test("超时归因：TCP 已连通但不回包 ≠ 连不上", async () => {
  const { default: mod } = await import(`${SCRIPT}`).then((m) => ({ default: m }));
  const hang = await hangServer();
  const refused = await refusedUrl();
  try {
    assert.equal((await mod.tcpReachable(hang.url)).ok, true, "TCP 应该连得上");
    assert.equal((await mod.tcpReachable(refused)).ok, false, "关掉的端口应该连不上");
    assert.match(await mod.describeTimeout(hang.url, 3000), /TCP 127\.0\.0\.1:\d+ 已连通/);
    assert.match(await mod.describeTimeout(refused, 3000), /无法连接/);
  } finally {
    await hang.close();
  }
});

test("4 个目标里有 3 个假死时，总耗时≈单个超时（并发，不累加）", async () => {
  const ok = await okServer();
  const hangs = await Promise.all([hangServer(), hangServer()]);
  const home = writePilotHome(
    {
      good: { url: ok.url, models: ["m-good"] },
      dead1: { url: hangs[0].url, models: ["m-dead1"] },
      dead2: { url: hangs[1].url, models: ["m-dead2"] },
    },
    "good/m-good",
  );
  try {
    const timeoutMs = 800;
    const run = await runCli(home, timeoutMs);
    assert.equal(run.status, 0, run.stderr);
    // 串行：2 × 800ms = 1.6s+；并发：≈800ms。阈值取 1.5s 留足机器抖动余量。
    assert.ok(run.durationMs < 1500, `并发探测应当约 ${timeoutMs}ms，实测 ${run.durationMs}ms`);
    assert.match(run.stdout, /✓ good\/m-good/);
    assert.match(run.stdout, /✗ dead1\/m-dead1/);
    assert.match(run.stdout, /✗ dead2\/m-dead2/);
    assert.match(run.stdout, /TCP 127\.0\.0\.1:\d+ 已连通/);
    assert.match(run.stdout, /2 other model\(s\) failed/);
  } finally {
    await ok.close();
    await Promise.all(hangs.map((server) => server.close()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("主模型不可达时仍然启动失败（exit 1）", async () => {
  const hang = await hangServer();
  const home = writePilotHome({ bad: { url: hang.url, models: ["m-bad"] } }, "bad/m-bad");
  try {
    const run = await runCli(home, 600);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /is not reachable/);
  } finally {
    await hang.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("连接被拒绝时把 errno 带出来（fetch failed (ECONNREFUSED)）", async () => {
  const refused = await refusedUrl();
  const ok = await okServer();
  const home = writePilotHome(
    {
      good: { url: ok.url, models: ["m-good"] },
      gone: { url: refused, models: ["m-gone"] },
    },
    "good/m-good",
  );
  try {
    const run = await runCli(home, 1200);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /ECONNREFUSED/);
  } finally {
    await ok.close();
    rmSync(home, { recursive: true, force: true });
  }
});
