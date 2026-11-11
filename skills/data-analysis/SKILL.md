---
name: data-analysis
description: 用 Python 对用户上传的数据做清洗、统计分析、建模与绘图（csv/xlsx/tsv/json，以及 DICOM 目录、ECG 波形）。只通过捆绑的 analysis.sh 执行；产物写 exports/analysis/。不联网、不改 inbox。
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

## 执行契约

```bash
bash "$ANALYSIS_SKILL_ROOT/scripts/analysis.sh" check --json

bash "$ANALYSIS_SKILL_ROOT/scripts/analysis.sh" run \
  --script scratch/work/<turnId>/analysis.py \
  --input  inbox/<batchId> \
  --out    exports/analysis/<主题>-<时间戳>
```

| 参数 | 说明 |
|---|---|
| `--script` | **必填**，只接受 `scratch/**` 下的 `.py`；执行前先做静态体检 |
| `--input` | 可选，只接受 `inbox/**` 或 `scratch/**`（含 `scratch/tool-results/**`），**只读** |
| `--out` | 必填，只接受 `exports/**`，不存在会自动创建 |
| `--timeout` | 可选，秒，默认 600，上限 1800 |
| `--mem-mb` | 可选，默认 4096，上限 8192 |

参数一律用**空格分隔**（`--out exports/x`）。`--out=exports/x` 这种等号写法不会被命令白名单识别，
会退回人工确认 —— 不要用。

## 写分析脚本的规矩

- 脚本里一律用环境变量：输入目录 `PILOTDECK_ANALYSIS_INPUT`、输出目录 `PILOTDECK_ANALYSIS_OUT`
  （都是绝对路径）。不要在脚本里写死 `..` 或绝对路径字面量——静态体检会直接拒
- 图存 `figures/`、表存 `tables/`（执行器已建好这两个子目录）
- 画图先 `import analysis_plot; analysis_plot.apply()`，再 `import matplotlib.pyplot`
- CSV 输出用 `utf-8-sig`（Excel 双击不乱码）
- 只允许写 `exports/` 与 `scratch/`：写别的目录（含 `inbox/`）会被运行期护栏当场拦下，
  结果是 `blocked`。读文件不设限，但同样不要读工作区以外的东西
- 被禁止的东西（静态体检会在执行前拒绝）：`subprocess` / `socket` / `ctypes` /
  `urllib` / `requests` / `multiprocessing` / `pickle`、`os.system` / `os.popen` / `exec*`、
  `eval` / `exec` / `compile` / `__import__`，以及指向绝对路径的 `open()` 字面量

## 退出码

| 码 | 含义 | 你该做什么 |
|---|---|---|
| 0 | 成功 | 读 `run.json` 和产物，写 `report.md` |
| 2 | 参数不合法（路径越根、非 `.py`…） | 改参数重试，不要换别的入口 |
| 3 | 静态体检拒绝（`rejected`） | **停止**，把 `violations` 原样告诉用户 |
| 4 | 脚本自己报错（`failed`） | 看 `run.json` 的 `stderrTail`，修脚本后重试（最多 2 次） |
| 5 | 超时（`timeout`） | 缩小数据量或改算法，不要直接抬 `--timeout` |
| 6 | 超内存（`oom`） | 分块读取（`chunksize`），或对大批量数据先抽样 |
| 7 | 执行器自身故障 | 报告运维，不要自己找替代方案 |
| 8 | 运行期护栏拦下（`blocked`） | **停止**，说明被拦的动作；不允许绕 |

`check` 例外：**永远以 0 退出**，状态在 JSON 的 `status` 里（`ready` / `missing_dependencies` /
`not_bootstrapped`）。所以先跑 `check --json` 读字段，不要看它的退出码。

## 输出位置

执行器会落一套可复现产物：

```
exports/analysis/<主题>-<时间戳>/
├── code.py        本次脚本副本
├── run.json       依赖版本、耗时、输入指纹、退出码
├── figures/*.png
└── tables/*.csv
```

给用户的报告 `report.md` 由你（agent）写，放在同一目录；执行器不生成模板。

## 依赖

运行前先 `check --json`：

- `status: ready` → 可以 `run`
- `status: not_bootstrapped` / `missing_dependencies` → **停止**，告诉用户"分析运行时尚未就绪，
  需要运维执行 `analysis.sh bootstrap-runtime`"，不要尝试自己装包

预装包：pandas / numpy / scipy / openpyxl / xlsxwriter / pyarrow / matplotlib / seaborn /
tabulate / Pillow / statsmodels / scikit-learn / lifelines / pingouin / pydicom / nibabel / wfdb。
