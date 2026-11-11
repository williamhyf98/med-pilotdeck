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
  --out    exports/analysis/<slug>-<ts>
```

| 参数 | 必填 | 约束 |
|---|---|---|
| `--script` | 是 | 只允许 `scratch/**` 下的 `.py`；执行前先做 AST 扫描 |
| `--input` | 否 | 只允许 `inbox/**` 或 `scratch/**`（含 `scratch/tool-results/**`，U2 已定）；**只读**挂入 |
| `--out` | **是** | 只允许 `exports/**`；不存在则创建（不给 `--out` 就不知道该把产物写哪） |
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

## 6. 产物目录

```
exports/analysis/<slug>-<ts>/
├── code.py           脚本副本（可复现）
├── run.json          { 依赖版本, 耗时, 输入指纹 sha256, 参数, 退出码 }
├── figures/*.png
├── tables/*.csv
└── report.md         agent 生成（U3 已定）；执行器不产出模板
```

规则：

- `slug` 来自 `--out` 的最后一段或标题，只保留 `[A-Za-z0-9._-]`，超长截断到 40 字符
- **中间文件一律留在 `scratch/work/<turnId>/`**，不落 `exports`
- 同名产物不覆盖：已存在则追加 `-2`、`-3`

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

## 9. 决议（2026-11-11 已定，不再作为未决项）

| # | 事项 | 决定 | 影响 |
|---|---|---|---|
| U1 | 依赖档位 | **全量装**：基础档 + 统计档 + 医学档一次性打进运行时，不拆镜像变体 | 交付体积 +≈250 MB（接受）；`bootstrap-runtime` 只需一次；管理员页只有一个"就绪/缺失"状态 |
| U2 | 能否读其他工具的输出 | **允许** agent 把 `scratch/tool-results/**` 作为 `--input` | `--input` 白名单 = `inbox/**` + `scratch/**`（已含 tool-results），**仍然只读**；写入仍只允许 `exports/**` 与 `scratch/work/<turnId>/**` |
| U3 | `report.md` 生成者 | **由 agent 生成**，执行器保持纯计算（只产 `code.py` / `run.json` / `figures` / `tables`） | 执行器无需模板引擎；报告质量与提示词/技能文档绑定 |

> U1 的推论：依赖清单以「全量」为唯一口径，`runtime/requirements.txt` 就是三档的并集；
> 后续若真要瘦身，另立一项，不在本轮回退。
