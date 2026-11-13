---
name: data-analysis
description: 用 Python 对用户上传的数据做清洗、统计分析、建模与绘图（csv/xlsx/tsv/json，以及 DICOM 目录、ECG 波形）。只通过捆绑的 analysis.sh 执行；产物写 exports/<本轮目录>/（一轮对话一个目录）。不联网、不改 inbox。
---

# 数据分析

只用 `read_skill` 返回的 `<path>` 所在目录：

```bash
ANALYSIS_SKILL_ROOT="$(dirname "<path>")"
```

所有执行都经过唯一入口 `scripts/analysis.sh`。**不要**直接 `python3` 跑脚本，
也不要 `pip install`（离线环境，且属硬拒绝）。

常用写法（读 csv/xlsx、缺失值、t 检验、生存分析、绘图、DICOM、ECG）在
`references/cheatsheet.md`。画图先 `import analysis_plot; analysis_plot.apply()`——
这个技能自带模块会注册随包的中文字体并统一 rcParams，省得中文标签变方框。

## Agent 可用表面

- `analysis.sh check` —— 只读体检，返回运行时是否就绪
- `analysis.sh run --script … --input … --out …` —— 执行一段分析脚本
- 只用 `.py` / `.csv` / `.json` / `.md` 暂存在 `scratch/` 下
- 命令返回 `rejected` / `not ready` / `blocked` 时**立即停止并报告**，不要换别的实现硬闯

写脚本用 `write_file` 直接写到 `scratch/work/<turnId>/analysis.py`；
**不要**用 `bash` 的重定向或 heredoc 造 `.py`（会被自动化策略拦，白费一轮）。
策略只对"`scratch/` 下的 `.py`"开口子，别的位置、别的后缀仍然拒绝。

## 执行契约

```bash
bash "$ANALYSIS_SKILL_ROOT/scripts/analysis.sh" check --json

bash "$ANALYSIS_SKILL_ROOT/scripts/analysis.sh" run \
  --script scratch/work/<turnId>/analysis.py \
  --input  inbox/<batchId> \
  --out    exports/<中文主题>
```

| 参数 | 说明 |
|---|---|
| `--script` | **必填**，只接受 `scratch/**` 下的 `.py`；执行前先做静态体检 |
| `--input` | 可选，只接受 `inbox/**`、`scratch/**`（含 `scratch/tool-results/**`）或 `exports/**`（上一次 run 的产物，做链式分析），**只读** |
| `--out` | 必填，只接受 `exports/**`。**本轮第一次调用时钉住一个根目录**（自动加 `<YYYYMMDD-HHMMSS>` 前缀），此后同一轮的所有调用都写这个目录，写不进第二个；返回里的 `root` 就是它 |
| `--timeout` | 可选，秒，默认 600，上限 1800 |
| `--mem-mb` | 可选，默认 4096，上限 8192 |

参数一律用**空格分隔**（`--out exports/x`）。`--out=exports/x` 这种等号写法不会被命令白名单识别，
会退回人工确认 —— 不要用。

**一轮对话 = 一个目录**，这是硬约束：

- 只写主题，不带时间戳（如 `--out exports/消化科提问类型分析`），执行器自己加前缀；
- 同一轮里重试、追加第二个步骤，都用**同一个 `--out`**，不要另起目录；
- 同一轮里若确实要做**互不相关**的第二件事（换了数据源，或换了一份交付物），
  写成 `--out <root>/02-<子主题>`，不要写成新的根目录；
- 同一份数据、同一个交付目标 → 全部写根目录，靠表名序号区分步骤（`01_`、`02_`）；
- 下一轮即使分析同一批数据也**自动开新目录**，上一轮的内容不会被覆盖。

**链式分析**：上一轮的产物可以直接当下一轮的输入，不需要先拷回 `scratch/`：

```
--input exports/<上一轮目录>/tables
```

`run.json` 的 `inputs` 会记下沿用了哪些文件（含 sha256），来源可追。

## 写分析脚本的规矩

- 脚本里一律用环境变量：输入目录 `PILOTDECK_ANALYSIS_INPUT`、输出目录 `PILOTDECK_ANALYSIS_OUT`
  （都是绝对路径）。不要在脚本里写死 `..` 或绝对路径字面量——静态体检会直接拒
- **不要在脚本里 `cd` / `os.chdir`**：工作目录不是数据目录，切过去以后所有相对路径都会解析错，
  而且 `tail`/`ls` 这类命令失败时只往 stderr 写一句话，很容易产出一份"全 0 但看起来正常"的结果
- 图存 `figures/`、表存 `tables/`（执行器已建好这两个子目录）
- 画图先 `import analysis_plot; analysis_plot.apply()`，再 `import matplotlib.pyplot`
- CSV 输出用 `utf-8-sig`（Excel 双击不乱码）
- 只允许写 `exports/` 与 `scratch/`：写别的目录（含 `inbox/`）会被运行期护栏当场拦下，
  结果是 `blocked`。读文件不设限，但同样不要读工作区以外的东西
- 被禁止的东西（静态体检会在执行前拒绝）：`subprocess` / `socket` / `ctypes` /
  `urllib` / `requests` / `multiprocessing` / `pickle`、`os.system` / `os.popen` / `exec*`、
  `eval` / `exec` / `compile` / `__import__`，以及指向绝对路径的 `open()` 字面量

**判断成败只看执行器返回的 `status`，不要只看退出码**：`failed` / `blocked` / `rejected` 一律停下报告。
**失败信息已经在这次的返回里**：非 `ok` 的调用会带回 `stderrTail`（traceback 末尾）、`logPath`、
`hint`。不要为了看报错去用 `python3`/`cat` 翻 `run.json`——那条路会被自动化策略拦下，白烧工具调用。
如果表里出现"全 0 / 0 行"，先怀疑文件没读到（路径、编码、分隔符），不要把 0 直接写成结论。

**别把通配符放进引号**：`cp "exports/x-2026*/t.csv" .` 里的 `*` 不会被 shell 展开，
会报 `No such file or directory`。先 `ls exports` 拿到确切目录名，再拼完整路径。

## 退出码

| 码 | 含义 | 你该做什么 |
|---|---|---|
| 0 | 成功 | 填 `report.md` 的 `## 结论`（骨架由执行器生成），确认返回里 `reportMissing` 变 `false` |
| 2 | 参数不合法（路径越根、非 `.py`…） | 改参数重试，不要换别的入口 |
| 3 | 静态体检拒绝（`rejected`） | **停止**，把 `violations` 原样告诉用户 |
| 4 | 脚本自己报错（`failed`） | 读返回里的 `stderrTail`，修脚本后对**同一个 `--out`** 重试（最多 2 次）。返回里的 `staleFiles` 是这次留下的半成品，可以打开看，但不要当结论 |
| 5 | 超时（`timeout`） | 缩小数据量或改算法，不要直接抬 `--timeout` |
| 6 | 超内存（`oom`） | 分块读取（`chunksize`），或对大批量数据先抽样 |
| 7 | 执行器自身故障 | 报告运维，不要自己找替代方案 |
| 8 | 运行期护栏拦下（`blocked`） | **停止**，说明被拦的动作（看 `violations`）；不允许绕 |

`check` 例外：**永远以 0 退出**，状态在 JSON 的 `status` 里（`ready` / `missing_dependencies` /
`not_bootstrapped`）。所以先跑 `check --json` 读字段，不要看它的退出码。

## 输出位置

一轮对话只落一个目录：

```
exports/<YYYYMMDD-HHMMSS>-<中文主题>/
├── report.md      执行器生成的骨架；你只补 `## 结论`
├── code.py        最后一次成功运行的脚本副本
├── run.json       依赖、耗时、输入指纹、退出码 + steps[] + attempts[]
├── tables/*.csv   `<步骤序号>_<中文名>.csv`
└── figures/*.png  `<步骤序号>_<中文名>.png`
```

**失败就地重试，不许换目录**：

- 失败时目录和半成品都留在原地，`run.json.attempts[]` 记下每次尝试；
- **下一次运行开始前，执行器会自动删掉上一次失败留下的文件**（`staleFiles` 里的那些），
  所以不要在脚本里依赖"上次写了一半的表还在"；
- 半成品**只能读、不能抄**：看它是为了定位 bug，结论必须来自重跑后的表；
- 本轮彻底失败时不再重试，目录会留下最后那次尝试，`run.json` 里有完整错误——报告给用户即可。

最后回答用户时，**必须写清目录**：末尾给一行 `产物目录：exports/<目录名>/`，再说 1–2 个关键文件名。

## 依赖

运行前先 `check --json`：

- `status: ready` → 可以 `run`
- `status: not_bootstrapped` / `missing_dependencies` → **停止**，告诉用户"分析运行时尚未就绪，
  需要运维执行 `analysis.sh bootstrap-runtime`"，不要尝试自己装包

预装包：pandas / numpy / scipy / openpyxl / xlsxwriter / pyarrow / matplotlib / seaborn /
tabulate / Pillow / statsmodels / scikit-learn / lifelines / pingouin / pydicom / nibabel / wfdb。
