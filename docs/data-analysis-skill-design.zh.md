# 数据分析技能（`data-analysis`）设计

> 定位：面向医学科研人员的"写 Python 做数据分析"能力。
> 本文档只写这个技能自己的设计；权限/路径/配额的通用规则见
> [permission-arch-v2-design.zh.md](./permission-arch-v2-design.zh.md)，
> 步骤与进度见 [plans/permission-arch-v2-todo.md](./plans/permission-arch-v2-todo.md) §3。

## 1. 目标与边界

| 项 | 内容 |
|---|---|
| 能做 | 读取用户上传的 `csv/xlsx/tsv/json`、DICOM 目录、ECG 波形；做清洗/统计/建模/绘图；把结果落 `exports/` |
| 不能做 | 出网（`network: none`）、装包（`pip install` 属硬拒绝）、执行任意 shell、读写 `inbox` 与系统保留项、访问工作区外路径 |
| 使用者 | agent（通过技能入口调用）。用户不直接跑脚本 |
| 交付形态 | 一个 shell 入口 + 一个 Python 执行器 + 一个离线 venv + 一份依赖清单 |

**核心约束：代码只能从一个口子跑。** 这个口子同时受五层约束：
① `bash` 命令策略白名单（设计书 §10.4.1）② 自动化策略（`automationPolicyConstraints` 认这个入口，
否则整条命令会被当成"非受信 shell 执行"硬拦）③ 沙箱 `network: none`
④ 执行器内 AST 黑名单（静态）⑤ 运行期护栏 `analysis_guard.py`（动态路径 / 动态导入）。

## 2. 唯一入口契约

```bash
bash "$SKILL_ROOT/scripts/analysis.sh" run \
  --script scratch/work/<turnId>/analysis.py \
  --input  inbox/<batchId> \
  --out    exports/<中文主题>
```

| 参数 | 必填 | 约束 |
|---|---|---|
| `--script` | 是 | 只允许 `scratch/**` 下的 `.py`；执行前先做 AST 扫描 |
| `--input` | 否 | 只允许 `inbox/**`、`scratch/**`（含 `scratch/tool-results/**`，U2 已定）或 `exports/**`（2026-11-12 起，用于链式分析）；**只读**挂入 |
| `--out` | **是** | 只允许 `exports/**`。agent 只给中文主题，`<YYYYMMDD-HHMMSS>-` 前缀由执行器加；**根目录由本轮第一次调用钉住**，后续调用第一段一律改写回该目录；根目录之后的段保留为子目录（见 §6） |
| `--timeout` | 否 | 默认 600s，上限 1800s |
| `--mem-mb` | 否 | 默认 4096，上限 8192 |

子命令：

| 子命令 | 作用 | 谁能调 |
|---|---|---|
| `check` | 返回 JSON：运行时是否就绪、依赖是否齐、版本号 | agent（只读）、管理员页 |
| `bootstrap-runtime` | 打包/镜像构建期用；离线从 `runtime/wheels` 建 venv | **只允许构建期**，SKILL.md 不暴露 |
| `run` | 执行分析脚本 | agent |

其他约定：

- 运行时位置：`$HOME/.cache/pilotdeck-analysis/runtime`（照 `skills/pdf/scripts/pdf.sh:9-30` 的模式：venv + `.pilotdeck-requirements-hash` 戳）
- 沙箱：`network: none`（设计书 §10.5.3 已定），**不需要**任何网络白名单
- cwd：固定 `scratch/work/<turnId>/`，脚本里用相对路径也跑不出去
- 轮次绑定：读环境变量 `PILOTDECK_TURN_ID`（`AgentLoop.ts:2879` 已注入），在 `scratch/work/<turnId>/` 里记
  `{root, locked}`；**没有这个变量时**（终端手跑、测试脚本）退化为"每次运行一个目录"，语义与 2026-11-11 版一致

## 3. 预装依赖（三档全量安装，U1 已定）

**版本对齐原则**：`plugins/med-tools/requirements.txt` 已包含 `pydicom>=2.4 / nibabel>=5.2 / numpy>=1.24 / Pillow>=10`，
离线 wheels 目录里已经有这些 wheel（`packaging/offline-arm64.Dockerfile:45-55` 已把 med-tools 合进去）。
**本技能只补差集，不重复钉版本。**

### 3.1 基础档（base）

| 包 | 版本 | 用途 |
|---|---|---|
| pandas | `>=2.2,<3` | 表格 |
| numpy | `>=1.24,<2.4`（下界沿用 med-tools，**上界是本技能加的**） | 数值 |
| scipy | `>=1.11,<2` | 统计检验 |
| openpyxl / xlsxwriter | `>=3.1` | xlsx 读写 |
| pyarrow | `>=15,<22` | parquet / 大文件 |
| matplotlib | `>=3.8,<4` | 绘图 |
| seaborn | `>=0.13,<0.14` | 统计图 |
| tabulate | `>=0.9` | 文本表 |
| Pillow | `>=10`（沿用 med-tools） | 图片输出 |

### 3.2 统计档（stats）

| 包 | 版本 | 用途 |
|---|---|---|
| statsmodels | `>=0.14,<0.15` | 回归 / GLM / 多重比较 |
| scikit-learn | `>=1.4,<1.6` | 聚类 / 降维 / 模型评估 |
| lifelines | `>=0.30,<0.31` | 生存分析（KM / Cox）。**0.29 的元数据写死 `numpy<2`，在 Python 3.13 上无解** |
| pingouin | `>=0.5,<0.6` | 常用医学统计（t/ANOVA/相关/效应量） |

### 3.3 医学档（medical）

| 包 | 版本 | 用途 | 备注 |
|---|---|---|---|
| pydicom | `>=2.4`（沿用 med-tools） | DICOM 解析 | 与系统现有 `plugins/med-tools/server/dicom_parse.py` 同族 |
| nibabel | `>=5.2`（沿用 med-tools） | NIfTI 读写 | 与前端 `NiftiPreview` 对齐 |
| wfdb | `>=4.1` | ECG / 波形（MIT-BIH 等） | med-tools 目前标为 optional，本技能**转正** |

**明确不装**：`SimpleITK`（体积大、与 nibabel 重叠）、`torch`（属模型推理，不进分析技能）、
`requests/httpx`（出网用，故意不装）、`jupyter`（交互式不需要）。

**两条实测踩过的坑（2026-11-11，macOS + Python 3.13 bootstrap）**：

1. `numpy` 不写上界时解析到 2.5.x，pip 会在 statsmodels / lifelines / wfdb 之间反复回溯
   （实测下了 58 个候选仍未收敛，还顺手把 numpy 升到 2.5.4 顶掉 lifelines 的依赖）；
2. `lifelines 0.29.0` 元数据是 `numpy<2.0`，而 Python 3.13 上 numpy 最低只能到 2.0 —— 该组合**无解**，
   必须用 0.30.x（离线镜像的 Python 3.12 两边都能装 0.30.x，版本不分裂）。

离线镜像构建若也出现长时间回溯，先怀疑这两条，而不是网络。

### 3.4 运行时落在哪（一份共享，不按用户复制）

venv 有 **589 MB**（17 包 + 依赖），按用户各装一份，12 个用户就是 ~7 GB 纯重复。
所以运行时是**全机器共享一份只读**，可写的字体缓存才按用户分：

| 目录 | 作用 | 权限 | 谁写 |
|---|---|---|---|
| `<app>/.runtime/cache/xdg/pilotdeck-analysis/runtime` | venv（共享运行时） | 只读 | 只有打包期 `prepare-offline-runtime.sh` |
| `${XDG_CACHE_HOME:-~/.cache}/pilotdeck-analysis-mpl` | matplotlib 字体缓存 | 每用户可写 | 首次 bootstrap / 首次绘图 |

**解析顺序**（`analysis.sh` 与管理员页 `analysisCacheRoot()` 必须一致，否则会出现
"管理页 ready、agent 报 not_bootstrapped"）：

1. `PILOTDECK_ANALYSIS_CACHE` —— 沙箱里由 `skillCacheEnv()` 注入，指向共享目录；
2. `<app>/.runtime/cache/xdg/pilotdeck-analysis` —— 存在 `runtime/bin/python` 就用它
   （开发机手动 `analysis.sh` 时无需任何环境变量也能命中）；
3. `${XDG_CACHE_HOME:-$HOME/.cache}/pilotdeck-analysis` —— 每用户缓存，`bootstrap-runtime` 自举时用。

沙箱授权：`appReadOnlyGrants()` 把共享运行时加进只读挂载（`bwrap --ro-bind`），
**不要**把它改成可写 —— 那等于让任意用户篡改所有人共用的 venv。

## 4. 执行期安全（12 条必须拒绝 + 3 条资源限制）

每条拒绝都要写审计（`action: analysis.rejected`，带命中的规则名）。
**判定发生在执行之前**（AST 扫描），不依赖运行时报错。

| # | 用例 | 期望 |
|---|---|---|
| S1 | `import subprocess` | 拒（AST） |
| S2 | `os.system('curl …')` | 拒（AST，且 `curl` 本就在 bash 硬拒绝里） |
| S3 | `os.popen('…')` | 拒（AST） |
| S4 | `socket.socket().connect(('10.31.112.13', 19400))` | 拒（AST 拦 `socket`）+ 沙箱 EPERM 双保险 |
| S5 | `urllib.request.urlopen('https://…')` | 拒（AST） |
| S6 | `import requests` | 拒（包未安装 + AST） |
| S7 | `open('/etc/passwd')` | 拒（路径越界） |
| S8 | `open('../../../../etc/passwd')` | 拒（路径越界，realpath 后判） |
| S9 | `open('inbox/x.csv', 'w')` | 拒（写 `inbox`） |
| S10 | `__import__('os').system('…')` | 拒（AST 拦 `__import__` 动态导入） |
| S11 | `eval(...)` / `exec(...)` / `compile(...)` | 拒（AST） |
| S12 | `ctypes.CDLL('libc.so.6')` | 拒（AST 拦 `ctypes`） |

资源类（不是"拒绝"，是"必须先被掐断并留痕"）：

| # | 用例 | 期望 |
|---|---|---|
| R1 | `while True: pass` | 到 `--timeout` 被杀，审计记 `analysis.timeout` |
| R2 | 一次性分配 32 GB | 到 `--mem-mb` 被 OOM-kill，审计记 `analysis.oom` |
| R3 | 往 `scratch` 写 50 GB | 写到配额告警（**不阻断**，设计书 §8.0），审计记 `analysis.disk_warn` |

### 4.1 两层判定：静态 + 运行期

静态 AST 只看得到**字面量**。`open('inbox/x.csv','w')` 换个写法
（`open('../'*3 + 'inbox/x.csv','w')`）或 `getattr(os,'sys'+'tem')('curl …')`
就能绕过扫描。所以执行器在起子进程时再装一层 `sys.addaudithook`
（`skills/data-analysis/scripts/analysis_guard.py`）：

| 层 | 管什么 | 结果 |
|---|---|---|
| 静态（`run_analysis.py:scan_source`） | 字面量能看出来的：阻断 import / 调用、绝对路径、`..` | `status: rejected`，退出码 3，**不产生任何产物** |
| 运行期（`analysis_guard.py`） | 算出来的路径、`getattr` 拼出来的函数、动态导入的模块 | `status: blocked`，退出码 8，`violations[].rule = runtime-guard` |

运行期护栏的四条线：

1. 出网：只拦**真的会出网**的事件 —— `socket.connect` / `sendto` / `sendmsg` / `getaddrinfo` /
   `gethostbyname` / `gethostbyaddr` / `getnameinfo` / `sethostname`。两条特意放行：
   - `socket.__new__`：urllib3（pydicom 的依赖）在 **import 期**就会 `socket(AF_INET6)` 探一下 IPv6，
     一刀切会把所有用到 requests 的库判成 `blocked`；
   - `socket.bind` 只许回环（`""` / `localhost` / `127.0.0.1` / `::1`，**不含 `0.0.0.0` / `::`**）——
     自检式 bind 放行，对外监听照样拒。

   `urllib.Request` / `http.client.*` / `ftplib` / `smtplib` 仍走静态层拒；真封网最终靠外层
   `network: none` 沙箱兜底。
2. 起进程：`os.system` / `os.exec*` / `os.spawn*` / `os.fork` / `pty.*` → 拒；`subprocess.Popen`
   只放行**只读探针**：`fc-list` / `fc-match` / `system_profiler`（matplotlib 扫字体）、
   `lscpu`（numpy.testing 探 ARM SVE，statsmodels 会带进来）、`uname` / `sw_vers` / `nproc` /
   `sysctl`（平台信息，`sysctl` 额外禁 `-w` / `-p` / 含 `=` 的写入型参数）。argv 里出现
   `-c` / `-e` / `--exec` 一律拒。字体缓存在 `bootstrap-runtime` 里预热到 `$CACHE_ROOT/mpl`，
   之后 run 直接读缓存，正常不会再触发
3. 原生代码：`ctypes.dlopen` 只放行解释器/系统库（numpy、scipy 在 import 期就要 dlopen，
   一刀切会让 pandas 起不来）；`import ctypes` 本身已被静态层拒掉
4. 写盘：只允许 `exports/`、`scratch/`、进程私有 `TMPDIR`（外加班加点用的 `MPLCONFIGDIR`），
   其余一律拒 → 这条覆盖 S9 的动态写法

**读盘不设限是有意的**：pandas / matplotlib 要读 site-packages 和系统字体，拦读会把正常分析搞死；
越界读由静态层（S7/S8）和外层沙箱兜底（§1 四层约束）。

## 5. 正确性验收清单

每次改依赖或执行器后跑一遍，全部通过与手算/参照值对齐才算过。

| # | 用例 | 判定 |
|---|---|---|
| C1 | 20 行小样本的 mean / median / sd / 四分位 | 与手算误差 < 1e-9 |
| C2 | `groupby` 分组均值 | 与 Excel 透视表一致 |
| C3 | 缺失值处理 | 丢弃行数写进 `run.json`，与 `df.isna().any(axis=1).sum()` 一致 |
| C4 | 两组 t 检验 | p 值与 `scipy.stats.ttest_ind` 手算一致（相对误差 < 1e-6） |
| C5 | 线性回归系数 | 与 `statsmodels.OLS` 直接调用一致 |
| C6 | KM 中位生存时间 | 与 `lifelines` 直接调用一致 |
| C7 | 绘图产物 | `figures/*.png` 非空、宽度 ≥ 800 px、含标题与坐标轴标签 |
| C8 | CSV 输出编码 | UTF-8 with BOM（Excel 双击不乱码） |
| C9 | 100 MB CSV | 不 OOM、耗时记入 `run.json` |
| C10 | DICOM 目录（≥3 序列） | 能列出序列/层数，PixelSpacing 与 `dcmdump` 一致 |
| C11 | ECG（wfdb 格式） | 能读采样率与通道数 |
| C12 | 同一输入跑两次 | `run.json` 里输入指纹一致、图表字节级一致（除时间戳） |

## 6. 产物目录（2026-11-12 改版：单位从「一次运行」改成「一轮对话」）

改版原因：旧约定"一次运行一个目录"（2026-11-11 版）在一轮对话里试 5 次就落 5 个平级目录。
2026-11-12 实测一轮留下 14 个目录 / 102 个文件，其中 6 个是失败、重复或空跑，
用户在工作区里根本判断不出哪个是最终版，agent 回复里列了 25 个文件卡片。

```
exports/<YYYYMMDD-HHMMSS>-<中文主题>/    ← 本轮唯一根目录
├── report.md        执行器生成骨架，agent 填结论（U4）
├── code.py          最后一次成功运行的脚本副本
├── run.json         依赖 / 耗时 / 输入指纹 / 退出码 + steps[] + attempts[]
├── tables/*.csv
└── figures/*.png
```

同一轮里若还有**互不相关**的第二件事，才开子目录：

```
exports/<YYYYMMDD-HHMMSS>-<中文主题>/
├── report.md
├── 01-<子主题>/
│   ├── code.py  run.json  tables/  figures/
└── 02-<子主题>/
    └── ...
```

规则：

| # | 规则 | 说明 |
|---|---|---|
| 1 | **一轮一目录** | 根目录在本轮第一次调用时钉住（`PILOTDECK_TURN_ID`），后续调用改写回同一目录，agent 想另起一个也起不来 |
| 2 | **跨轮不覆盖** | 下一轮即使处理同一批数据也开新目录；上一轮内容原样保留 |
| 3 | **同轮允许覆盖** | 重试、追加步骤都写同一个根目录；`status: ok` 不再是拒绝写入的理由（2026-11-11 的旧规则作废，见 §9） |
| 4 | **命名** | `<YYYYMMDD-HHMMSS>-<中文主题>`：agent 只给主题，时间戳前缀由执行器加；时间戳在前（工作区按 mtime 倒序，名字顺序做第二道保险）；主题 ≤ 40 字符且不含 `/`；同名目录已存在时自动加 `-2`、`-3` |
| 5 | **子目录只给「不相关」用** | 口径：**同一份输入数据 + 同一个交付物 → 写根目录**（靠表名序号区分步骤）；换了数据源、或换了产出目的（一份质检报告 vs 一份对外材料）→ `<序号>-<子主题>/` |
| 6 | **表图命名** | `<步骤序号>_<中文名>.csv` / `.png`，例 `01_科室分布.csv`。序号让同轮多步骤在根目录里也不打架 |
| 7 | **中间文件** | 一律留在 `scratch/work/<turnId>/`，不落 `exports` |
| 8 | **失败就地重试** | 不新建目录、不搬到别处，见 §6.2 |

### 6.1 失败必须自带诊断（2026-11-12 实跑后追加）

`run.json` 只是留档，agent 真正能读到的是**这一次 bash 调用的 stdout**。所以非 `ok` 时，
stdout 的那行 JSON 必须自带诊断，否则模型只能猜：

| 字段 | 条件 | 内容 |
|---|---|---|
| `errorSummary` | 非 `ok` 且 stderr 非空 | traceback 最后一行（如 `KeyError: 'x'`），结论一句话 |
| `stderrTail` | 非 `ok` | 子进程 stderr 末尾 1600 字符（traceback 结论在末尾） |
| `stdoutTail` | 非 `ok` 且非空 | 子进程 stdout 末尾 600 字符 |
| `logPath` | 非 `ok` | `run.json` 的相对路径，供人复核 |
| `hint` | `failed` / `timeout` / `oom` / `blocked` | 一句话说明该改什么，避免反复重试同一条命令 |
| `staleFiles` | 非 `ok` 且本次写出了文件 | 本次尝试留在目录里的文件（相对路径）。下一轮重试开始前会被删掉，**只用于定位问题，不当作结果** |

`ok` 时不打这些字段（正常路径不额外耗 token）。出现背景：一次 `KeyError` 被吞进
`run.json.stderrTail`，工具结果只有 `{"status":"failed"}`，agent 于是用 `python3` 去读
`run.json`，又被自动化策略拦下——3~4 次工具调用就这么烧掉了，最后撞上调用预算。

### 6.2 失败就地重试与残留清理（2026-11-12 追加）

失败不是"作废重来"，而是在**同一个目录里继续迭代**——半成品留在原地给 agent 看，
下一次尝试开始前清掉，成功时目录里只剩最终产物。

| 时刻 | 执行器动作 | 目录内容 |
|---|---|---|
| 运行前 | 快照 `tables/` `figures/` 的 `(路径, mtime, size)` | 上一次的产物原样在 |
| 失败（退出码 4/5/6/8） | 反算出本次 `produced`，写入 `attempts[]`，返回 `staleFiles` | 半成品保留，**agent 可读** |
| 下一次运行**开始前** | 删掉 `attempts[-1].produced` 里的文件（只删这些，不碰其他步骤） | 干净起点 |
| 成功 | 写入新产物；`steps[]` 追加 `{scriptSha256, produced[], at}` | 只剩最终产物 |

为什么在"重试前删"而不是"成功后删"：

- 脚本若用追加模式写（`mode='a'`），半成品会被拼进新结果，**数据翻倍且没人察觉**；
- 脚本若写 `if exists: skip`，最终留下的其实是上次失败时的旧内容；
- agent 中途看目录时，分不清哪些是新的、哪些是旧的。

`attempts[]` 只存元数据（文件名清单 + stderr 摘要），几十字节，不占体积。
**彻底失败的一轮**会留下最后一次尝试的半成品（不再有下一次重试来清它），此时 `run.json`
里的错误信息就是这段留档的全部价值；目录仍只有一个。

**硬规矩**（同步写进 `SKILL.md`）：

1. 失败后**不许换目录**：重试必须用同一个 `--out`，新建目录会破坏"一轮一目录"；
2. 半成品**只能读、不能抄**：可以打开看"为什么只有 3 行"，但结论必须来自重跑后的表。

### 6.3 `report.md` 的生成（U4 已定，取代 U3 的「执行器不产出模板」）

| 时机 | 动作 |
|---|---|
| 首次成功 | 执行器生成骨架：标题、数据口径（从 `run.json` 的 `inputs` / `dependencies` 填）、`tables`/`figures` 索引表、"## 结论"占位 |
| 同轮后续步骤成功 | **只追加一节**，不动已有文字（避免冲掉 agent 已写好的结论） |
| agent 收尾 | 填 `## 结论`；`run.json.reportMissing` 保持 `true` 直到占位符被替换 |
| 失败 | 不生成（跟着这次尝试的产物一起被清） |

### 6.4 旧目录处置（一次性，不写进运行时逻辑）

2026-11-12 之前的产物全在 `exports/analysis/` 下（14 个目录 / 102 个文件，1.7 MB）。
改版后这一层不再使用，处置方式是**整包移入回收站**：

- `moveFileToTrash(工作区, 'exports/analysis')` → `.trash/analysis.<stamp>`，1 条记录、可整体恢复、7 天后自动释放；
- `exports/` 根下的 docx / pdf / pptx **一律不动**（它们不是分析产物，归属用户）；
- 不在代码里写迁移逻辑，跑一次就结束。

## 7. 管理员页「数据分析依赖」

| 字段 | 来源 |
|---|---|
| 依赖清单（包名 + 版本约束 + 档位） | `skills/data-analysis/runtime/requirements.txt` |
| 实际安装版本 | `analysis.sh check` 返回的 JSON |
| 运行时状态 | `ready` / `missing_dependencies` / `not_bootstrapped` |
| 最近一次 bootstrap 时间 | venv 内 `.pilotdeck-requirements-hash` 戳的 mtime |

接口：`GET /api/admin/skills/data-analysis/deps`（`requireAdminChain`）。
**只读**：不提供"在线安装"按钮（离线环境装了也没用）。

## 8. 与 permission-arch 的接口

| 依赖项 | 来自 | 为什么 |
|---|---|---|
| 写不进 `inbox` | 设计书 §4.2 第 5 条（门 0） | 分析不能改原件 |
| 保留项拒绝 | 设计书 §4.2 第 4 条（门 0） | `.trash` / `.usage.json` 不可碰 |
| 审计留痕 | 设计书 §11（门 0） | 12 条拒绝必须可检索 |
| 命令零弹窗 | 设计书 §10.4.1（B0） | 否则每条命令都要用户点一次 |
| 出网为零 | 设计书 §10.5（已完成） | `network: none` + 启动自检 |

## 9. 决议（2026-11-11 起；2026-11-12 增补 U4）

| # | 事项 | 决定 | 影响 |
|---|---|---|---|
| U1 | 依赖档位 | **全量装**：基础档 + 统计档 + 医学档一次性打进运行时，不拆镜像变体 | 交付体积 +≈250 MB（接受）；`bootstrap-runtime` 只需一次；管理员页只有一个"就绪/缺失"状态 |
| U2 | 能否读其他工具的输出 | **允许** agent 把 `scratch/tool-results/**` 作为 `--input` | `--input` 白名单 = `inbox/**` + `scratch/**`（已含 tool-results），**仍然只读**；写入仍只允许 `exports/**` 与 `scratch/work/<turnId>/**` |
| U3 | `report.md` 生成者 | **由 agent 生成**，执行器保持纯计算（只产 `code.py` / `run.json` / `figures` / `tables`）。**已被 U4 部分取代**：骨架改由执行器出 | 执行器无需模板引擎；报告质量与提示词/技能文档绑定 |
| U4 | 产物目录粒度（2026-11-12 改） | **一轮一目录**：根目录按 `PILOTDECK_TURN_ID` 钉住，失败就地重试；`report.md` 改由执行器出骨架、agent 填结论 | 目录数从"每次运行一个"降到"每轮一个"；`SKILL.md` 的"每次运行新目录"整条作废；`run_analysis.py` 的 `status: ok` 拒绝覆盖规则改为"跨轮拒绝、同轮允许" |

> U1 的推论：依赖清单以「全量」为唯一口径，`runtime/requirements.txt` 就是三档的并集；
> 后续若真要瘦身，另立一项，不在本轮回退。

> **U2 补充（2026-11-12 实跑）**：`--input` 再加 `exports/**`。原来只认 `inbox|scratch`，
> 于是"上一轮清洗好的表给下一轮用"必须 `cp` 回 scratch，而 agent 十有八九会写成
> `cp "exports/analysis/x-2026*/t.csv"`（通配符被引号包住，shell 不展开）→ 白跑两次调用。
> `exports` 是技能自己的产物区，读回来自成闭环；`run.json.inputs` 记 sha256，来源仍可追。
> 写入范围不变（只 `exports`），安全面没有扩大。

> **U4 补充（2026-11-12，U3 部分被取代）**：`report.md` 不再"只由 agent 写"。
> 实测 14 个运行目录**一份 `report.md` 都没有**——`SKILL.md` 里"成功 → 写 report.md"
> 只是退出码表里的一行，模型稳定跳过。改成执行器出骨架（标题 / 口径 / 索引表 / 结论占位），
> agent 只补结论；缺结论时 `run.json.reportMissing` 为 `true`，可被管理页或测试发现。
> 目录粒度同步从「一次运行一个」改成「一轮对话一个」，理由见 §6 开头。
