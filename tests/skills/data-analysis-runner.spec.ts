// @ts-nocheck
// data-analysis 执行器验收：静态拒绝（spec §4 S1–S12）、运行期护栏、
// 正确性（§5 C1/C12）、产物布局（§6）。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// dist/tests/skills → 仓库根
const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const analysisSh = join(repo, "skills", "data-analysis", "scripts", "analysis.sh");

function detectPython() {
  const candidates = [process.env.PILOTDECK_ANALYSIS_PYTHON, "python3", "python"].filter(Boolean);
  for (const candidate of candidates) {
    // 必须是绝对可执行路径：analysis.sh 拒绝 "python3" 这种命令名
    const probe = spawnSync(candidate, ["-c", "import sys; print(sys.executable) if sys.version_info[0] == 3 else print('')"], {
      encoding: "utf8",
    });
    const resolved = (probe.stdout ?? "").trim();
    if (probe.status === 0 && resolved) return resolved;
  }
  return null;
}

const PYTHON = detectPython();
const SKIP = PYTHON ? false : "需要 python3 才能跑执行器";

async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-analysis-"));
  const workspace = join(root, "users", "1", "workspaces", "general", "ws1");
  await mkdir(join(workspace, "inbox", "batch1"), { recursive: true });
  await mkdir(join(workspace, "exports"), { recursive: true });
  await mkdir(join(workspace, "scratch", "work", "t1"), { recursive: true });
  try {
    await fn({ root, workspace });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function putScript(workspace, name, body) {
  const relative = `scratch/work/t1/${name}.py`;
  await writeFile(join(workspace, relative), body, "utf8");
  return relative;
}

function runAnalysis(workspace, args) {
  const result = spawnSync("bash", [analysisSh, "run", ...args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      PILOTDECK_ANALYSIS_PYTHON: PYTHON,
      PILOTDECK_ANALYSIS_CACHE: join(workspace, "..", "..", "..", "cache"),
    },
  });
  let json = null;
  try {
    json = JSON.parse((result.stdout ?? "").trim().split("\n").pop() ?? "");
  } catch {
    json = null;
  }
  return { status: result.status, json, text: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** spec §4：每一条都必须在**执行之前**被拒。 */
const STATIC_CASES = [
  ["S1", "blocked-import", "import subprocess\nsubprocess.run(['id'])\n"],
  ["S2", "blocked-call", "import os\nos.system('curl http://example.com')\n"],
  ["S3", "blocked-call", "import os\nos.popen('ls')\n"],
  ["S4", "blocked-import", "import socket\nsocket.socket().connect(('10.31.112.13', 19400))\n"],
  ["S5", "blocked-import", "import urllib.request\nurllib.request.urlopen('https://example.com')\n"],
  ["S6", "blocked-import", "import requests\nrequests.get('https://example.com')\n"],
  ["S7", "path-literal", "open('/etc/passwd').read()\n"],
  ["S8", "path-literal", "open('../../../../etc/passwd').read()\n"],
  ["S10", "blocked-call", "__import__('os').system('id')\n"],
  ["S11", "blocked-call", "eval('1+1')\n"],
  ["S12", "blocked-import", "import ctypes\nctypes.CDLL('libc.so.6')\n"],
];

test("静态体检在执行前拒绝 S1–S12", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    for (const [name, rule, body] of STATIC_CASES) {
      const script = await putScript(workspace, name, body);
      const out = `exports/analysis/${name.toLowerCase()}`;
      const result = runAnalysis(workspace, ["--script", script, "--out", out]);
      assert.equal(result.status, 3, `${name} 应以 3 退出，实际 ${result.status}: ${result.text}`);
      assert.equal(result.json?.status, "rejected", `${name} 应被拒`);
      const rules = (result.json?.violations ?? []).map((violation) => violation.rule);
      assert.ok(rules.includes(rule), `${name} 应命中 ${rule}，实际 ${rules.join(",")}`);
      assert.equal(existsSync(join(workspace, out)), false, `${name} 被拒时不应留下产物目录`);
    }
  });
});

/** 静态看不出来的写法，必须被运行期护栏拦住（spec §4 括号里的"动态"部分）。 */
const GUARD_CASES = [
  ["动态拼出越界写路径", "open('../' * 3 + 'inbox/x.csv', 'w').write('x')\n"],
  ["pathlib 动态越界写", "import pathlib\npathlib.Path('../' * 3 + 'inbox/y.csv').write_text('y')\n"],
  ["getattr 绕开 os.system", "import os\ngetattr(os, 'sys' + 'tem')('echo hi')\n"],
  ["动态导入 socket", "import builtins\nmod = getattr(builtins, '__imp' + 'ort__')('so' + 'cket')\nmod.create_connection(('127.0.0.1', 9))\n"],
  ["对外监听", "import builtins\nmod = getattr(builtins, '__imp' + 'ort__')('so' + 'cket')\ns = mod.socket()\ns.bind(('0.0.0.0', 0))\n"],
  ["动态导入 subprocess", "import builtins\nsp = getattr(builtins, '__imp' + 'ort__')('sub' + 'process')\nsp.run(['/bin/echo', 'hi'])\n"],
  ["chdir 到工作区外", "import os\nos.chdir('/')\n"],
];

test("运行期护栏拦住动态越界与起进程", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    for (const [label, body] of GUARD_CASES) {
      const script = await putScript(workspace, `guard-${index(label)}`, body);
      const out = `exports/analysis/guard-${index(label)}`;
      const result = runAnalysis(workspace, ["--script", script, "--out", out, "--timeout", "30"]);
      assert.equal(result.status, 8, `${label} 应以 8 退出（blocked），实际 ${result.status}: ${result.text}`);
      assert.equal(result.json?.status, "blocked", `${label} 应标记 blocked`);
      assert.equal(result.json?.violations?.[0]?.rule, "runtime-guard", `${label} 应记录 runtime-guard`);
    }
    assert.equal(existsSync(join(workspace, "inbox", "x.csv")), false, "inbox 不能被写");
    assert.equal(existsSync(join(workspace, "inbox", "y.csv")), false, "inbox 不能被写");
  });
});

function index(label) {
  return Buffer.from(label).toString("hex").slice(0, 10);
}

const C1_SCRIPT = `
import csv, json, os, statistics
from pathlib import Path

src = Path(os.environ["PILOTDECK_ANALYSIS_INPUT"]) / "sample.csv"
out = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])

rows = list(csv.DictReader(src.open(encoding="utf-8")))
values = [float(row["value"]) for row in rows]
result = {
    "n": len(values),
    "mean": statistics.fmean(values),
    "median": statistics.median(values),
    "sd": statistics.stdev(values),
    "q1": statistics.quantiles(values, n=4)[0],
    "q3": statistics.quantiles(values, n=4)[2],
}
with (out / "tables" / "c1.csv").open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.writer(handle)
    for key, value in result.items():
        writer.writerow([key, value])
print(json.dumps(result))
`;

async function writeSample(workspace, values) {
  const body = ["id,value", ...values.map((value, i) => `${i + 1},${value}`)].join("\n") + "\n";
  await writeFile(join(workspace, "inbox", "batch1", "sample.csv"), body, "utf8");
}

test("正确性 C1：均值/中位数/标准差/四分位与手算一致，产物齐全", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    await writeSample(workspace, values);
    const script = await putScript(workspace, "c1", C1_SCRIPT);
    const out = "exports/analysis/c1-group-diff";
    const result = runAnalysis(workspace, ["--script", script, "--input", "inbox/batch1", "--out", out]);
    assert.equal(result.status, 0, `应成功：${result.text}`);
    assert.equal(result.json?.status, "ok");

    const dir = join(workspace, out);
    for (const relative of ["code.py", "run.json", "tables/c1.csv", "figures", "tables"]) {
      assert.ok(existsSync(join(dir, relative)), `缺少产物 ${relative}`);
    }

    const raw = await readFile(join(dir, "tables", "c1.csv"));
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], "CSV 必须带 UTF-8 BOM");
    const numbers = Object.fromEntries(
      raw.toString("utf8").replace(/^\uFEFF/, "").trim().split("\n")
        .map((line) => line.split(",")).map(([key, value]) => [key, Number(value)]),
    );
    assert.equal(numbers.n, 20);
    assert.ok(Math.abs(numbers.mean - 10.5) < 1e-9);
    assert.ok(Math.abs(numbers.median - 10.5) < 1e-9);
    // 样本标准差 = sqrt(665/19) = sqrt(35)
    assert.ok(Math.abs(numbers.sd - Math.sqrt(35)) < 1e-9);
    // statistics.quantiles 默认 exclusive：位置 j*(N+1)/4 → 5.25 / 15.75
    assert.ok(Math.abs(numbers.q1 - 5.25) < 1e-9);
    assert.ok(Math.abs(numbers.q3 - 15.75) < 1e-9);

    const record = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
    assert.equal(record.guard, "analysis_guard.py");
    assert.equal(record.input, "inbox/batch1");
    assert.equal(record.inputs.length, 1);
    assert.equal(record.inputs[0].path, "inbox/batch1/sample.csv");
    assert.equal(record.limits.memMb, 4096);
  });
});

test("正确性 C12：同一输入跑两次，输入指纹与表格字节一致", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeSample(workspace, Array.from({ length: 20 }, (_, i) => i + 1));
    const script = await putScript(workspace, "c12", C1_SCRIPT);
    const first = "exports/analysis/c12-a";
    const second = "exports/analysis/c12-b";
    assert.equal(runAnalysis(workspace, ["--script", script, "--input", "inbox/batch1", "--out", first]).status, 0);
    assert.equal(runAnalysis(workspace, ["--script", script, "--input", "inbox/batch1", "--out", second]).status, 0);

    const a = JSON.parse(await readFile(join(workspace, first, "run.json"), "utf8"));
    const b = JSON.parse(await readFile(join(workspace, second, "run.json"), "utf8"));
    assert.deepEqual(a.inputs, b.inputs, "输入指纹必须一致");
    assert.equal(a.scriptSha256, b.scriptSha256);
    assert.deepEqual(
      await readFile(join(workspace, first, "tables", "c1.csv")),
      await readFile(join(workspace, second, "tables", "c1.csv")),
      "同一输入两次产出的表格必须字节一致",
    );
  });
});

test("同一 --out 目录不允许被第二次成功运行覆盖（避免新旧产物混放）", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeSample(workspace, Array.from({ length: 10 }, (_, i) => i + 1));
    const script = await putScript(workspace, "reuse", C1_SCRIPT);
    const out = "exports/analysis/reuse";
    const first = runAnalysis(workspace, ["--script", script, "--input", "inbox/batch1", "--out", out]);
    assert.equal(first.status, 0, first.text);
    const before = await readFile(join(workspace, out, "run.json"), "utf8");

    const second = runAnalysis(workspace, ["--script", script, "--input", "inbox/batch1", "--out", out]);
    assert.equal(second.status, 2, `第二次应被拒：${second.text}`);
    assert.match(second.json?.error ?? "", /already holds a successful run/u);
    assert.match(second.json?.error ?? "", /timestamped directory/u);
    assert.equal(await readFile(join(workspace, out, "run.json"), "utf8"), before, "已有结果不能被改写");
  });
});

test("失败的运行可以就地重试（只有成功结果被锁定）", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    const broken = await putScript(workspace, "broken", "raise SystemExit(9)\n");
    const out = "exports/analysis/retry";
    assert.equal(runAnalysis(workspace, ["--script", broken, "--out", out]).status, 4);
    const fixed = await putScript(workspace, "fixed", "print('ok')\n");
    assert.equal(runAnalysis(workspace, ["--script", fixed, "--out", out]).status, 0);
  });
});

test("R1：死循环到 --timeout 被杀，状态记为 timeout", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    const script = await putScript(workspace, "spin", "while True:\n    pass\n");
    const out = "exports/analysis/spin";
    const result = runAnalysis(workspace, ["--script", script, "--out", out, "--timeout", "2"]);
    assert.equal(result.status, 5, `应返回 5：${result.text}`);
    assert.equal(result.json?.status, "timeout");
    assert.equal(result.json?.timedOut, true);
    const record = JSON.parse(await readFile(join(workspace, out, "run.json"), "utf8"));
    assert.equal(record.status, "timeout");
    assert.equal(record.limits.timeoutSeconds, 2);
  });
});

test("参数越界与非法脚本一律拒绝", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeSample(workspace, [1, 2, 3]);
    const script = await putScript(workspace, "ok", "print('hi')\n");
    const outside = join(workspace, "inbox", "batch1", "evil.py");
    await writeFile(outside, "print('hi')\n", "utf8");

    const badScript = runAnalysis(workspace, ["--script", "inbox/batch1/evil.py", "--out", "exports/x"]);
    assert.equal(badScript.status, 2, "--script 必须在 scratch/ 下");

    const badOut = runAnalysis(workspace, ["--script", script, "--out", "scratch/x"]);
    assert.equal(badOut.status, 2, "--out 必须在 exports/ 下");

    const badInput = runAnalysis(workspace, ["--script", script, "--input", "exports", "--out", "exports/y"]);
    assert.equal(badInput.status, 2, "--input 只能是 inbox/ 或 scratch/");

    const notPython = await putScript(workspace, "note", "");
    await writeFile(join(workspace, "scratch/work/t1/note.txt"), "x", "utf8");
    const badSuffix = runAnalysis(workspace, ["--script", "scratch/work/t1/note.txt", "--out", "exports/z"]);
    assert.equal(badSuffix.status, 2, "--script 只接受 .py");
    assert.ok(notPython.endsWith(".py"));
  });
});

test("check --json 永远以 0 退出，状态在 JSON 字段里", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    const result = spawnSync("bash", [analysisSh, "check", "--json"], {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, PILOTDECK_ANALYSIS_CACHE: join(workspace, "..", "..", "..", "cache") },
    });
    assert.equal(result.status, 0, `check 不应以非 0 退出：${result.stdout}${result.stderr}`);
    const json = JSON.parse(result.stdout.trim());
    assert.ok(["ready", "missing_dependencies", "not_bootstrapped"].includes(json.status));
    assert.equal(typeof json.packages, "number");
  });
});

test("PILOTDECK_ANALYSIS_PYTHON 不是可执行文件时立刻报错，而不是 exec 失败后静默", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    const script = await putScript(workspace, "nopy", "print('hi')\n");
    const result = spawnSync(
      "bash",
      [analysisSh, "run", "--script", script, "--out", "exports/x"],
      {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, PILOTDECK_ANALYSIS_PYTHON: "python3" },
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stdout, /PILOTDECK_ANALYSIS_PYTHON must be an executable path/);
  });
});
