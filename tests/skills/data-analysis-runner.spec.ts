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

function runAnalysis(workspace, args, extraEnv = {}) {
  const result = spawnSync("bash", [analysisSh, "run", ...args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      PILOTDECK_ANALYSIS_PYTHON: PYTHON,
      PILOTDECK_ANALYSIS_CACHE: join(workspace, "..", "..", "..", "cache"),
      ...extraEnv,
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

// 2026-11-12 实跑教训：脚本抛异常时只回 `{"status":"failed"}`，agent 看不到 traceback，
// 只能靠猜（还会去 python3 读 run.json 然后被策略拦）。失败必须把 stderr 末尾交回去。
test("失败时 stdout 直接带回 stderrTail / logPath / hint", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    const script = await putScript(
      workspace,
      "boom",
      "print('stage=load')\ncounts = {'甲': 1}\nprint(counts['乙'])\n",
    );
    const out = "exports/analysis/boom";
    const result = runAnalysis(workspace, ["--script", script, "--out", out]);

    assert.equal(result.status, 4, `应返回 4：${result.text}`);
    assert.equal(result.json?.status, "failed");
    assert.match(result.json?.errorSummary ?? "", /^KeyError:/u, "errorSummary 就是 traceback 最后一行");
    assert.match(result.json?.stderrTail ?? "", /KeyError/u, "stderrTail 必须包含异常类型");
    assert.match(result.json?.stderrTail ?? "", /'乙'|"乙"/u, "stderrTail 必须包含出错的键");
    assert.equal(result.json?.logPath, "exports/analysis/boom/run.json");
    assert.match(result.json?.hint ?? "", /exception/u, "hint 要说明是脚本异常");
    assert.match(result.json?.stdoutTail ?? "", /stage=load/u, "stdoutTail 保留崩溃前的输出");
  });
});

test("成功时不回传 stderrTail，避免正常路径多耗 token", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeSample(workspace, Array.from({ length: 10 }, (_, i) => i + 1));
    const script = await putScript(workspace, "quiet", C1_SCRIPT);
    const out = "exports/analysis/quiet";
    const result = runAnalysis(workspace, ["--script", script, "--input", "inbox/batch1", "--out", out]);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.json?.status, "ok");
    assert.equal(result.json?.stderrTail, undefined);
    assert.equal(result.json?.hint, undefined);
  });
});

// 链式分析：上一次 run 的 tables/ 直接作为下一次 --input，不必先 cp 回 scratch。
test("--input 可以指向上一次 run 的 exports 产物", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeSample(workspace, Array.from({ length: 10 }, (_, i) => i + 1));
    // 先造一份"上一次的产物"，模拟 exports/analysis/<slug>/tables/sample.csv
    await mkdir(join(workspace, "exports", "analysis", "prev", "tables"), { recursive: true });
    await writeFile(
      join(workspace, "exports", "analysis", "prev", "tables", "sample.csv"),
      "id,value\n1,2\n2,4\n",
      "utf8",
    );

    const script = await putScript(workspace, "chain", C1_SCRIPT);
    const out = "exports/analysis/chain";
    const result = runAnalysis(workspace, [
      "--script", script,
      "--input", "exports/analysis/prev/tables",
      "--out", out,
    ]);

    assert.equal(result.status, 0, `链式分析应成功：${result.text}`);
    const record = JSON.parse(await readFile(join(workspace, out, "run.json"), "utf8"));
    assert.equal(record.input, "exports/analysis/prev/tables");
    assert.equal(record.inputs.length, 1, "输入指纹要记下沿用来的产物");
  });
});

test("超长 stderr 只回传末尾 1600 字符，结论仍在", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    const script = await putScript(
      workspace,
      "deep",
      [
        "import sys",
        "for i in range(300):",
        "    sys.stderr.write('noise line %d\\n' % i)",
        "raise ValueError('boom')",
        "",
      ].join("\n"),
    );
    const out = "exports/analysis/deep";
    const result = runAnalysis(workspace, ["--script", script, "--out", out, "--timeout", "30"]);

    assert.equal(result.status, 4, `应返回 4：${result.text}`);
    const tail = result.json?.stderrTail ?? "";
    assert.ok(tail.length <= 1601, `stderrTail 必须被截断，实际 ${tail.length}`);
    assert.ok(tail.startsWith("…"), "截断处要有省略号，提示前面还有内容");
    assert.match(result.json?.errorSummary ?? "", /^ValueError: boom/u, "最后一行仍是结论");
    assert.match(tail, /ValueError: boom/u, "截断后末尾仍带结论");
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

    // exports/ 自 2026-11-12 起可读（链式分析），其它根仍然拒绝
    const badInput = runAnalysis(workspace, ["--script", script, "--input", "memory", "--out", "exports/y"]);
    assert.equal(badInput.status, 2, "--input 只能是 inbox/、scratch/ 或 exports/");
    const escapeInput = runAnalysis(workspace, ["--script", script, "--input", "../inbox", "--out", "exports/y2"]);
    assert.equal(escapeInput.status, 2, "--input 不能越根");

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

// ---- 2026-11-12 改版：一轮一目录（设计书 §6 / U4）------------------------

function turnEnv(workspace, turn) {
  return {
    PILOTDECK_TURN_ID: turn,
    PILOTDECK_WORK_DIR: join(workspace, "scratch", "work", "s1", turn),
  };
}

const PARTIAL_SCRIPT = `
import os
from pathlib import Path
out = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])
(out / "tables" / "half.csv").write_text("x", encoding="utf-8")
raise RuntimeError("boom")
`;

test("轮次模式：换根目录名被改写回钉住的目录，并说明怎么开子目录", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeSample(workspace, [1, 2, 3]);
    const script = await putScript(workspace, "turn1", C1_SCRIPT);
    const env = turnEnv(workspace, "turnA");

    const first = runAnalysis(
      workspace,
      ["--script", script, "--input", "inbox/batch1", "--out", "exports/内科问答分析"],
      env,
    );
    assert.equal(first.status, 0, first.text);
    assert.match(first.json.root, /^exports\/\d{8}-\d{6}-内科问答分析$/u, "根目录应带时间戳前缀");
    assert.equal(first.json.out, first.json.root);

    // 同一轮里 agent 另起一个名字：被改写回原根目录，并给出提示
    const second = runAnalysis(
      workspace,
      ["--script", script, "--input", "inbox/batch1", "--out", "exports/另一个主题"],
      env,
    );
    assert.equal(second.status, 0, second.text);
    assert.equal(second.json.out, first.json.root, "同一轮不应出现第二个根目录");
    assert.match(second.json.note ?? "", /钉住/u);

    // 显式写子目录则保留
    const third = runAnalysis(
      workspace,
      ["--script", script, "--input", "inbox/batch1", "--out", `${first.json.root}/02-教学材料`],
      env,
    );
    assert.equal(third.status, 0, third.text);
    assert.equal(third.json.out, `${first.json.root}/02-教学材料`);
    assert.ok(existsSync(join(workspace, third.json.out, "tables", "c1.csv")));
  });
});

test("轮次模式：下一轮即使同一个主题也开新目录，上一轮保留", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeSample(workspace, [1, 2, 3]);
    const script = await putScript(workspace, "turn2", C1_SCRIPT);
    const args = ["--script", script, "--input", "inbox/batch1", "--out", "exports/内科问答分析"];

    const first = runAnalysis(workspace, args, turnEnv(workspace, "turnA"));
    assert.equal(first.status, 0, first.text);
    const second = runAnalysis(workspace, args, turnEnv(workspace, "turnB"));
    assert.equal(second.status, 0, second.text);

    assert.notEqual(second.json.root, first.json.root, "跨轮必须开新目录");
    assert.ok(existsSync(join(workspace, first.json.root, "run.json")), "上一轮目录必须原样保留");
  });
});

test("轮次模式：失败留半成品给 agent 读，重试前自动清掉", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeSample(workspace, [1, 2, 3]);
    const broken = await putScript(workspace, "partial", PARTIAL_SCRIPT);
    const fixed = await putScript(workspace, "fixed", C1_SCRIPT);
    const env = turnEnv(workspace, "turnC");
    const out = "exports/失败重试";

    const failed = runAnalysis(workspace, ["--script", broken, "--out", out], env);
    assert.equal(failed.status, 4, failed.text);
    assert.deepEqual(failed.json.staleFiles, ["tables/half.csv"], "半成品清单要回给 agent");
    const root = failed.json.root;
    assert.ok(existsSync(join(workspace, root, "tables", "half.csv")), "半成品要留在原地给 agent 看");

    const retried = runAnalysis(workspace, ["--script", fixed, "--input", "inbox/batch1", "--out", root], env);
    assert.equal(retried.status, 0, retried.text);
    assert.equal(existsSync(join(workspace, root, "tables", "half.csv")), false, "重试前应清掉上一次的半成品");
    assert.ok(existsSync(join(workspace, root, "tables", "c1.csv")));

    const record = JSON.parse(await readFile(join(workspace, root, "run.json"), "utf8"));
    assert.equal(record.attempt, 2);
    assert.equal(record.attempts[0].status, "failed");
    assert.equal(record.attempts[0].cleaned, true);
    assert.equal(record.steps.length, 1, "只有成功那次进 steps");
  });
});

test("轮次模式：report.md 骨架由执行器生成，索引随步骤刷新且不覆盖 agent 结论", { skip: SKIP }, async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeSample(workspace, [1, 2, 3]);
    const script = await putScript(workspace, "rep1", C1_SCRIPT);
    const env = turnEnv(workspace, "turnD");

    const first = runAnalysis(
      workspace,
      ["--script", script, "--input", "inbox/batch1", "--out", "exports/报告骨架"],
      env,
    );
    assert.equal(first.status, 0, first.text);
    assert.equal(first.json.reportMissing, true, "结论没写时应标记 reportMissing");
    const root = first.json.root;
    const reportPath = join(workspace, root, "report.md");
    const skeleton = await readFile(reportPath, "utf8");
    assert.match(skeleton, /## 数据口径/u);
    assert.match(skeleton, /tables\/c1\.csv/u, "索引要列出本次产物");
    assert.match(skeleton, /TODO\(agent\)/u);

    // agent 填结论 → 再跑一步 → 结论保留、索引追加、reportMissing 变 false
    await writeFile(reportPath, skeleton.replace(/<!-- TODO\(agent\)[^>]*-->/u, "结论：共 3 例。"), "utf8");
    const more = await putScript(
      workspace,
      "rep2",
      'import os\nfrom pathlib import Path\nout = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])\n(out / "tables" / "c2.csv").write_text("y", encoding="utf-8")\n',
    );
    const second = runAnalysis(workspace, ["--script", more, "--out", root], env);
    assert.equal(second.status, 0, second.text);
    assert.equal(second.json.reportMissing, false);

    const updated = await readFile(reportPath, "utf8");
    assert.match(updated, /结论：共 3 例。/u, "agent 写的结论不能被覆盖");
    assert.match(updated, /tables\/c1\.csv/u);
    assert.match(updated, /tables\/c2\.csv/u, "新步骤的产物要进索引");
  });
});
