// @ts-nocheck
// data-analysis 正确性验收（spec §5 C2–C11）与资源类用例（§4 R2/R3）。
//
// 原则：**不自己验证自己**。参考值要么是手算的闭式解，要么是独立公式重算，
// 要么是同一数据集上 scipy/statsmodels 的一次性黄金值（注释里写明来源）。
// 依赖装不上的用例显式 skip 并说明原因，不假装通过。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const analysisSh = join(repo, "skills", "data-analysis", "scripts", "analysis.sh");

const PYTHON_CANDIDATES = [
  process.env.PILOTDECK_ANALYSIS_PYTHON,
  // 本机跑过 `analysis.sh bootstrap-runtime` 时优先用它：依赖最齐，C6/C11 不会 skip
  join(homedir(), ".cache", "pilotdeck-analysis", "runtime", "bin", "python"),
  "python3",
  "/opt/anaconda3/bin/python3",
  "python",
].filter(Boolean);

/** 找一个**装了这些模块**的解释器（绝对路径，且用 -I 也能 import）。 */
function pickPython(modules: string[]): string | null {
  const probe = modules.length > 0 ? `import ${modules.join(", ")}` : "pass";
  for (const candidate of PYTHON_CANDIDATES) {
    const result = spawnSync(candidate, ["-I", "-c", `${probe}\nimport sys; print(sys.executable)`], {
      encoding: "utf8",
    });
    const resolved = (result.stdout ?? "").trim().split("\n").pop() ?? "";
    if (result.status === 0 && resolved) return resolved;
  }
  return null;
}

function skipUnless(modules: string[]): { skip: false } | { skip: string } {
  return pickPython(modules) ? { skip: false } : { skip: `缺少依赖：${modules.join(", ")}` };
}

async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-analysis-c-"));
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

async function putScript(workspace, name: string, body: string) {
  const relative = `scratch/work/t1/${name}.py`;
  await writeFile(join(workspace, relative), body, "utf8");
  return relative;
}

function runAnalysis({ root, workspace, python, script, out, input = "inbox/batch1", extra = [] }) {
  const result = spawnSync(
    "bash",
    [analysisSh, "run", "--script", script, "--input", input, "--out", out, ...extra],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 300000,
      env: {
        ...process.env,
        PILOTDECK_ANALYSIS_PYTHON: python,
        PILOTDECK_ANALYSIS_CACHE: join(root, "cache"),
      },
    },
  );
  let json = null;
  try {
    json = JSON.parse((result.stdout ?? "").trim().split("\n").pop() ?? "");
  } catch {
    json = null;
  }
  return { status: result.status, json, text: `${result.stdout ?? ""}${result.stderr ?? ""}`, dir: join(workspace, out) };
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readTable(dir: string, name: string) {
  const raw = await readFile(join(dir, "tables", name), "utf8");
  const text = raw.replace(/^\uFEFF/, "").trim();
  // csv.writer 默认 CRLF，pandas 用 LF —— 两种都要能读
  const [header, ...rows] = text.split(/\r?\n/).map((line) => line.split(","));
  return rows.map((row) => Object.fromEntries(row.map((value, index) => [header[index], value])));
}

const close = (actual: number, expected: number, tolerance = 1e-9) => Math.abs(actual - expected) < tolerance;

// ── C2：groupby 分组均值与透视表一致 ───────────────────────────────────────
test("C2 分组均值与手算透视表一致", skipUnless(["pandas"]), async () => {
  const python = pickPython(["pandas"]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    // a: 1,2,3,3  → 2.25 ; b: 10,20 → 15 ; c: 7 → 7
    await writeFile(
      join(workspace, "inbox", "batch1", "rows.csv"),
      ["arm,value", "a,1", "a,2", "b,10", "a,3", "c,7", "b,20", "a,3"].join("\n") + "\n",
      "utf8",
    );
    const script = await putScript(
      workspace,
      "c2",
      `
import os
from pathlib import Path
import pandas as pd

df = pd.read_csv(Path(os.environ["PILOTDECK_ANALYSIS_INPUT"]) / "rows.csv")
pivot = df.groupby("arm")["value"].agg(["count", "sum", "mean"])
pivot.to_csv(Path(os.environ["PILOTDECK_ANALYSIS_OUT"]) / "tables" / "pivot.csv", encoding="utf-8-sig")
print(pivot.to_json())
`,
    );
    const run = runAnalysis({ ...ctx, python, script, out: "exports/analysis/c2" });
    assert.equal(run.status, 0, run.text);
    const rows = await readTable(run.dir, "pivot.csv");
    const byArm = Object.fromEntries(rows.map((row) => [row.arm, row]));
    assert.equal(Number(byArm.a["mean"]), 2.25);
    assert.equal(Number(byArm.b["mean"]), 15);
    assert.equal(Number(byArm.c["mean"]), 7);
    assert.equal(Number(byArm.a["count"]), 4);
    assert.equal(Number(byArm.b["sum"]), 30);
  });
});

// ── C3：缺失值处理留痕 ────────────────────────────────────────────────────
test("C3 丢弃行数与 isna().any(axis=1).sum() 一致且写进产物", skipUnless(["pandas"]), async () => {
  const python = pickPython(["pandas"]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    // 6 行，第 2 行 value 缺失、第 5 行 arm 缺失 → 丢弃 2 行
    await writeFile(
      join(workspace, "inbox", "batch1", "dirty.csv"),
      ["arm,value", "a,1", "a,", "b,3", "b,4", ",5", "b,6"].join("\n") + "\n",
      "utf8",
    );
    const script = await putScript(
      workspace,
      "c3",
      `
import csv, os
from pathlib import Path
import pandas as pd

src = Path(os.environ["PILOTDECK_ANALYSIS_INPUT"]) / "dirty.csv"
out = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])

raw = pd.read_csv(src)
mask = raw.isna().any(axis=1)
dropped = int(mask.sum())
clean = raw.dropna(subset=["arm", "value"])

with (out / "tables" / "cleaning.csv").open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["rows_read", "rows_dropped", "rows_kept"])
    writer.writerow([len(raw), dropped, len(clean)])
print("dropped", dropped)
`,
    );
    const run = runAnalysis({ ...ctx, python, script, out: "exports/analysis/c3" });
    assert.equal(run.status, 0, run.text);
    const [row] = await readTable(run.dir, "cleaning.csv");
    assert.equal(Number(row.rows_read), 6);
    assert.equal(Number(row.rows_dropped), 2);
    assert.equal(Number(row.rows_kept), 4);
  });
});

// ── C4：Welch t 检验 ──────────────────────────────────────────────────────
test("C4 两组 t 检验：t 用手算公式重算，p 对黄金值", skipUnless(["scipy"]), async () => {
  const python = pickPython(["scipy"]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    const armA = [1, 2, 3, 4, 5];
    const armB = [2, 4, 6, 8, 10];
    const lines = ["arm,value"];
    for (const value of armA) lines.push(`a,${value}`);
    for (const value of armB) lines.push(`b,${value}`);
    await writeFile(join(workspace, "inbox", "batch1", "t.csv"), `${lines.join("\n")}\n`, "utf8");

    const script = await putScript(
      workspace,
      "c4",
      `
import csv, os
from pathlib import Path
import pandas as pd
from scipy import stats

df = pd.read_csv(Path(os.environ["PILOTDECK_ANALYSIS_INPUT"]) / "t.csv")
a = df.loc[df["arm"] == "a", "value"]
b = df.loc[df["arm"] == "b", "value"]
result = stats.ttest_ind(a, b, equal_var=False)

out = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])
with (out / "tables" / "ttest.csv").open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["n_a", "n_b", "mean_a", "mean_b", "t", "p"])
    writer.writerow([len(a), len(b), a.mean(), b.mean(), result.statistic, result.pvalue])
print("t", float(result.statistic), "p", float(result.pvalue))
`,
    );
    const run = runAnalysis({ ...ctx, python, script, out: "exports/analysis/c4" });
    assert.equal(run.status, 0, run.text);
    const [row] = await readTable(run.dir, "ttest.csv");

    // 独立重算 Welch t：(m1-m2)/sqrt(s1²/n1 + s2²/n2)，样本方差用 n-1
    const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
    const variance = (xs) => {
      const m = mean(xs);
      return xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1);
    };
    const manual = (mean(armA) - mean(armB))
      / Math.sqrt(variance(armA) / armA.length + variance(armB) / armB.length);
    assert.ok(close(Number(row.t), manual), `t 与手算不一致：${row.t} vs ${manual}`);
    // 黄金值：scipy.stats.ttest_ind([1..5],[2,4,6,8,10], equal_var=False).pvalue
    assert.ok(close(Number(row.p), 0.10753119493062718, 1e-12), `p 与黄金值不一致：${row.p}`);
    assert.equal(Number(row.n_a), 5);
    assert.equal(Number(row.mean_b), 6);
  });
});

// ── C5：线性回归系数（闭式解 vs statsmodels）────────────────────────────────
test("C5 线性回归系数等于闭式解 slope/intercept", skipUnless(["statsmodels"]), async () => {
  const python = pickPython(["statsmodels"]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    // y = 2 + 3x，五个点，闭式解就是 2 / 3
    const xs = [1, 2, 3, 4, 5];
    const lines = ["x,y"];
    for (const x of xs) lines.push(`${x},${2 + 3 * x}`);
    await writeFile(join(workspace, "inbox", "batch1", "lin.csv"), `${lines.join("\n")}\n`, "utf8");

    const script = await putScript(
      workspace,
      "c5",
      `
import csv, os
from pathlib import Path
import pandas as pd
import statsmodels.formula.api as smf

df = pd.read_csv(Path(os.environ["PILOTDECK_ANALYSIS_INPUT"]) / "lin.csv")
model = smf.ols("y ~ x", data=df).fit()

out = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])
with (out / "tables" / "ols.csv").open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["term", "coef", "r2"])
    writer.writerow(["Intercept", model.params["Intercept"], model.rsquared])
    writer.writerow(["x", model.params["x"], model.rsquared])
print(model.params.to_json())
`,
    );
    const run = runAnalysis({ ...ctx, python, script, out: "exports/analysis/c5" });
    assert.equal(run.status, 0, run.text);
    const rows = await readTable(run.dir, "ols.csv");
    const intercept = rows.find((row) => row.term === "Intercept");
    const slope = rows.find((row) => row.term === "x");
    assert.ok(close(Number(intercept.coef), 2), `intercept ${intercept.coef}`);
    assert.ok(close(Number(slope.coef), 3), `slope ${slope.coef}`);
    assert.ok(close(Number(slope.r2), 1, 1e-12), `r2 ${slope.r2}`);
  });
});

// ── C6：KM 中位生存时间 ────────────────────────────────────────────────────
test("C6 KM 中位生存时间与直接调用一致", skipUnless(["lifelines"]), async () => {
  const python = pickPython(["lifelines"]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    // 10 例全事件、时间 1..10 → 中位生存时间 5
    const lines = ["time,event"];
    for (let i = 1; i <= 10; i += 1) lines.push(`${i},1`);
    await writeFile(join(workspace, "inbox", "batch1", "surv.csv"), `${lines.join("\n")}\n`, "utf8");

    const script = await putScript(
      workspace,
      "c6",
      `
import csv, os
from pathlib import Path
import pandas as pd
from lifelines import KaplanMeierFitter

df = pd.read_csv(Path(os.environ["PILOTDECK_ANALYSIS_INPUT"]) / "surv.csv")
km = KaplanMeierFitter()
km.fit(df["time"], event_observed=df["event"])

out = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])
with (out / "tables" / "km.csv").open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["median_survival"])
    writer.writerow([float(km.median_survival_time_)])
print("median", float(km.median_survival_time_))
`,
    );
    const run = runAnalysis({ ...ctx, python, script, out: "exports/analysis/c6" });
    assert.equal(run.status, 0, run.text);
    const [row] = await readTable(run.dir, "km.csv");
    assert.ok(close(Number(row.median_survival), 5, 1e-9));
  });
});

// ── C7：绘图产物 ──────────────────────────────────────────────────────────
test("C7 图像非空、宽度 ≥ 800、标题与坐标轴标签齐全", skipUnless(["matplotlib"]), async () => {
  const python = pickPython(["matplotlib"]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    await writeFile(join(workspace, "inbox", "batch1", "rows.csv"), "arm,value\na,1\na,3\nb,5\nb,7\n", "utf8");
    const script = await putScript(
      workspace,
      "c7",
      `
import json, os
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import analysis_plot
analysis_plot.apply()
import matplotlib.pyplot as plt

out = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])
fig, ax = plt.subplots(figsize=(6, 4))
ax.bar(["a", "b"], [2.0, 6.0])
ax.set_title("Group means")
ax.set_xlabel("arm")
ax.set_ylabel("value")
fig.tight_layout()
fig.savefig(out / "figures" / "group-means.png")
print(json.dumps({"title": ax.get_title(), "xlabel": ax.get_xlabel(), "ylabel": ax.get_ylabel()}))
`,
    );
    const run = runAnalysis({ ...ctx, python, script, out: "exports/analysis/c7" });
    assert.equal(run.status, 0, run.text);
    const png = await readFile(join(run.dir, "figures", "group-means.png"));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG 签名不对");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.ok(width >= 800, `宽度不足 800：${width}`);
    assert.ok(png.length > 5000, `图像过小，可能是空白：${png.length} 字节`);
    assert.ok(height > 0);

    const record = await readJson(join(run.dir, "run.json"));
    const printed = JSON.parse(record.stdoutTail.trim().split("\n").pop());
    assert.equal(printed.title, "Group means");
    assert.equal(printed.xlabel, "arm");
    assert.equal(printed.ylabel, "value");
  });
});

// ── C8：CSV 编码 ──────────────────────────────────────────────────────────
test("C8 CSV 输出带 UTF-8 BOM（Excel 双击不乱码）", skipUnless(["pandas"]), async () => {
  const python = pickPython(["pandas"]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    await writeFile(join(workspace, "inbox", "batch1", "cn.csv"), "分组,数值\n甲,1\n乙,2\n", "utf8");
    const script = await putScript(
      workspace,
      "c8",
      `
import os
from pathlib import Path
import pandas as pd

df = pd.read_csv(Path(os.environ["PILOTDECK_ANALYSIS_INPUT"]) / "cn.csv", encoding="utf-8")
out = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])
df.to_csv(out / "tables" / "中文汇总.csv", index=False, encoding="utf-8-sig")
print("ok")
`,
    );
    const run = runAnalysis({ ...ctx, python, script, out: "exports/analysis/c8" });
    assert.equal(run.status, 0, run.text);
    const raw = await readFile(join(run.dir, "tables", "中文汇总.csv"));
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], "缺 BOM");
    assert.match(raw.toString("utf8"), /分组,数值/);
  });
});

// ── C9：100 MB CSV ────────────────────────────────────────────────────────
test("C9 100 MB CSV 分块读完、不 OOM、耗时记进 run.json", skipUnless(["pandas"]), async () => {
  const python = pickPython(["pandas"]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    const target = join(workspace, "inbox", "batch1", "big.csv");
    const rows = 7_000_000;
    const handle = openSync(target, "w");
    try {
      writeSync(handle, "id,value\n");
      const chunk = 100_000;
      for (let start = 0; start < rows; start += chunk) {
        let block = "";
        for (let index = start; index < Math.min(start + chunk, rows); index += 1) {
          block += `${index},${(index % 1000) / 10}\n`;
        }
        writeSync(handle, block);
      }
    } finally {
      closeSync(handle);
    }

    const script = await putScript(
      workspace,
      "c9",
      `
import csv, os, time
from pathlib import Path
import pandas as pd

src = Path(os.environ["PILOTDECK_ANALYSIS_INPUT"]) / "big.csv"
out = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])

started = time.time()
rows = 0
total = 0.0
for chunk in pd.read_csv(src, chunksize=200_000):
    rows += len(chunk)
    total += float(chunk["value"].sum())

with (out / "tables" / "big.csv").open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["rows", "sum_value", "seconds"])
    writer.writerow([rows, round(total, 6), round(time.time() - started, 3)])
print("rows", rows)
`,
    );
    const run = runAnalysis({ ...ctx, python, script, out: "exports/analysis/c9", extra: ["--timeout", "240"] });
    assert.equal(run.status, 0, run.text);
    const [row] = await readTable(run.dir, "big.csv");
    assert.equal(Number(row.rows), rows);

    const record = await readJson(join(run.dir, "run.json"));
    assert.equal(record.status, "ok");
    assert.ok(record.durationMs > 0, "run.json 必须记耗时");
    assert.equal(record.oom, false);
    // 超过 64 MB 的文件不计算 sha256，但仍记字节数
    assert.equal(record.inputs.length, 1);
    assert.ok(record.inputs[0].bytes > 64 * 1024 * 1024, "指纹应记录大文件字节数");
    assert.equal(record.inputs[0].sha256, null, "超过 64 MB 不哈希，避免把整文件读进内存");
  });
});

// ── C10：DICOM 目录 ───────────────────────────────────────────────────────
test("C10 DICOM 多序列：序列数/层数/PixelSpacing 与写入值一致", skipUnless(["pydicom"]), async () => {
  const python = pickPython(["pydicom"]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    // 用 pydicom 造 3 个序列 × 2 层，PixelSpacing 各不相同。
    // 注意：运行期护栏只允许写 exports/ 与 scratch/，所以 fixture 落在 scratch 下
    const build = await putScript(
      workspace,
      "build-dicom",
      `
import os
from pathlib import Path
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid, SecondaryCaptureImageStorage

root = Path(os.environ["PILOTDECK_ANALYSIS_INPUT"])
root.mkdir(parents=True, exist_ok=True)
for index, spacing in enumerate([0.5, 0.7, 0.9]):
    series_uid = generate_uid()
    for slice_index in range(2):
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
        meta.MediaStorageSOPInstanceUID = generate_uid()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = Dataset()
        ds.file_meta = meta
        ds.SeriesInstanceUID = series_uid
        ds.SeriesDescription = f"series-{index}"
        ds.InstanceNumber = slice_index + 1
        ds.PixelSpacing = [spacing, spacing]
        ds.Rows = ds.Columns = 2
        ds.BitsAllocated = ds.BitsStored = 16
        ds.SamplesPerPixel = 1
        ds.PixelRepresentation = 0
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.PixelData = b"\\x00\\x00" * 4
        ds.save_as(root / f"s{index}-{slice_index}.dcm", enforce_file_format=True)
print("built")
`,
    );
    // 造数据这一步不需要 --out 产物，借用一次 run 把文件写进 inbox
    const buildRun = runAnalysis({
      ...ctx,
      python,
      script: build,
      input: "scratch/fixtures/dicom",
      out: "exports/analysis/c10-build",
    });
    assert.equal(buildRun.status, 0, buildRun.text);

    const script = await putScript(
      workspace,
      "c10",
      `
import csv, os
from pathlib import Path
import pydicom

root = Path(os.environ["PILOTDECK_ANALYSIS_INPUT"])
out = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])

series = {}
for path in sorted(root.glob("*.dcm")):
    ds = pydicom.dcmread(str(path), stop_before_pixels=True)
    entry = series.setdefault(ds.SeriesInstanceUID, {
        "series": str(ds.get("SeriesDescription", "")),
        "slices": 0,
        "spacing": [float(v) for v in ds.get("PixelSpacing", [])],
    })
    entry["slices"] += 1

with (out / "tables" / "series.csv").open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["series", "slices", "row_spacing", "col_spacing"])
    for uid, entry in sorted(series.items(), key=lambda item: item[1]["series"]):
        writer.writerow([entry["series"], entry["slices"], entry["spacing"][0], entry["spacing"][1]])
print("series", len(series))
`,
    );
    const run = runAnalysis({ ...ctx, python, script, input: "scratch/fixtures/dicom", out: "exports/analysis/c10" });
    assert.equal(run.status, 0, run.text);
    const rows = await readTable(run.dir, "series.csv");
    assert.equal(rows.length, 3, "应识别出 3 个序列");
    for (const row of rows) {
      assert.equal(Number(row.slices), 2, "每个序列 2 层");
    }
    const spacings = rows.map((row) => Number(row.row_spacing)).sort((a, b) => a - b);
    assert.deepEqual(spacings, [0.5, 0.7, 0.9]);
  });
});

// ── C11：ECG（wfdb）──────────────────────────────────────────────────────
test("C11 wfdb 记录能读出采样率与通道数", skipUnless(["wfdb"]), async () => {
  const python = pickPython(["wfdb"]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    await writeFile(join(workspace, "inbox", "batch1", "ecg.csv"), "mlII\n0.1\n0.2\n0.3\n", "utf8");
    // 先用 wfdb 写一条格式 16 的记录，再读回来
    const build = await putScript(
      workspace,
      "build-ecg",
      `
import os
from pathlib import Path
import numpy as np
import wfdb

root = Path(os.environ["PILOTDECK_ANALYSIS_INPUT"])
root.mkdir(parents=True, exist_ok=True)
# p_signal 必须是 float64 且二维：wfdb 4.x 的 wrsamp 用 adc_gain/baseline 自己量化，
# 直接传 int16 会被 check_np_array 拒（TypeError: must subclass numpy.floating）
signal = np.sin(np.linspace(0, 6.28, 250 * 10)).astype("float64").reshape(-1, 1)
wfdb.wrsamp("100", fs=250, units=["mV"], sig_name=["MLII"], p_signal=signal,
            fmt=["16"], adc_gain=[200.0], baseline=[0], write_dir=str(root))
print("built")
`,
    );
    const buildRun = runAnalysis({
      ...ctx,
      python,
      script: build,
      input: "scratch/fixtures/ecg",
      out: "exports/analysis/c11-build",
    });
    assert.equal(buildRun.status, 0, buildRun.text);

    const script = await putScript(
      workspace,
      "c11",
      `
import csv, os
from pathlib import Path
import wfdb

root = Path(os.environ["PILOTDECK_ANALYSIS_INPUT"])
out = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])
record = wfdb.rdrecord(str(root / "100"))

with (out / "tables" / "record.csv").open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["sampling_rate", "channels", "samples"])
    writer.writerow([record.fs, record.n_sig, record.sig_len])
print("fs", record.fs, "n_sig", record.n_sig)
`,
    );
    const run = runAnalysis({ ...ctx, python, script, input: "scratch/fixtures/ecg", out: "exports/analysis/c11" });
    assert.equal(run.status, 0, run.text);
    const [row] = await readTable(run.dir, "record.csv");
    assert.equal(Number(row.sampling_rate), 250);
    assert.equal(Number(row.channels), 1);
    assert.equal(Number(row.samples), 2500);
  });
});

// ── R2：内存超限 ─────────────────────────────────────────────────────────
test("R2 超内存被记为 oom（Linux 由 RLIMIT_AS 触发，macOS 走 MemoryError 映射）", skipUnless(["resource"]), async () => {
  const python = pickPython([]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    const script = await putScript(
      workspace,
      "r2",
      `
import resource
raise MemoryError("simulated allocation failure")
`,
    );
    const run = runAnalysis({
      ...ctx,
      python,
      script,
      out: "exports/analysis/r2",
      extra: ["--mem-mb", "256", "--timeout", "30"],
    });
    assert.equal(run.status, 6, `应以 6 退出：${run.text}`);
    assert.equal(run.json?.status, "oom");
    assert.equal(run.json?.oom, true);
    const record = await readJson(join(run.dir, "run.json"));
    assert.equal(record.status, "oom");
    assert.equal(record.limits.memMb, 256);
    assert.equal(record.limits.enforcement, "best-effort");
  });
});

test("R2b 资源上限确实下发给子进程（CPU / 打开文件数）", skipUnless([]), async () => {
  const python = pickPython([]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    const script = await putScript(
      workspace,
      "r2b",
      `
import json, resource
print(json.dumps({
    "cpu_soft": resource.getrlimit(resource.RLIMIT_CPU)[0],
    "nofile_soft": resource.getrlimit(resource.RLIMIT_NOFILE)[0],
    "core_soft": resource.getrlimit(resource.RLIMIT_CORE)[0],
}))
`,
    );
    const run = runAnalysis({
      ...ctx,
      python,
      script,
      out: "exports/analysis/r2b",
      extra: ["--timeout", "45"],
    });
    assert.equal(run.status, 0, run.text);
    const record = await readJson(join(run.dir, "run.json"));
    const printed = JSON.parse(record.stdoutTail.trim().split("\n").pop());
    assert.equal(printed.cpu_soft, 46, "RLIMIT_CPU 应等于 timeout+1");
    assert.equal(printed.nofile_soft, 256);
    assert.equal(printed.core_soft, 0);
  });
});

// ── R3：写 scratch 不阻断（配额告警属配额功能，尚未实现）────────────────────
test("R3 往 scratch 写大文件不被拦（配额告警留给配额功能）", skipUnless([]), async () => {
  const python = pickPython([]);
  await withWorkspace(async (ctx) => {
    const { workspace } = ctx;
    const script = await putScript(
      workspace,
      "r3",
      `
import os
from pathlib import Path

target = Path(os.environ["PILOTDECK_ANALYSIS_ROOT"]) / "scratch" / "work" / "t1" / "bulk.bin"
block = b"0" * (1024 * 1024)
with target.open("wb") as handle:
    for _ in range(32):
        handle.write(block)
print("wrote", target.stat().st_size)
`,
    );
    const run = runAnalysis({ ...ctx, python, script, out: "exports/analysis/r3", extra: ["--timeout", "120"] });
    assert.equal(run.status, 0, run.text);
    const record = await readJson(join(run.dir, "run.json"));
    assert.match(record.stdoutTail, /wrote 33554432/);
  });
});
