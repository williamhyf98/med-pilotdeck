# 五个内置文档 Skill 改造记录

持续记录仓库 `skills/` 里这五个离线文档技能的改造，方便对照「改了什么、为什么、别的 skill 怎么复用」。

| Skill | 目录 | 状态 |
| --- | --- | --- |
| PDF | `skills/pdf/` | 已改造（本文第 1 节） |
| Word | `skills/docx/` | 已改造（本文第 2 节） |
| PowerPoint | `skills/pptx/` | 已改造（本文第 3 节） |
| 表格 | `skills/spreadsheets/` | 已改造（本文第 4 节） |
| 图示 | `skills/diagram-maker/` | 已改造（本文第 6 节） |

原则（五个 skill 共用，先在 PDF 上落地）：

1. **Agent 只填参数**，捆绑脚本出文件。
2. **不要现场 pip / 不要手写生成器用的 Python**。
3. **新建**走一条 `make`（或等价物）；**改已有文件**的子命令保留，但不要变成「再写一套脚本」。
4. 成功时 JSON 带 `"output"`，产品层才能出预览和下载卡片。

---

## 1. PDF（`skills/pdf`）

PDF **仍然能改已有 PDF**。去掉的是「让模型自己写 ReportLab / 现场装依赖」，不是 merge、拆分、旋转、填表、审计。

### 1.1 一句话对比

| | 改造前 | 改造后 |
| --- | --- | --- |
| Agent 怎么生成新 PDF | `scaffold` 出 `build_pdf.py`，再 `build`，缺依赖就 `check \|\| fix` | `pdf.sh make --title/--body/--markdown/--spec --out` |
| 字体 | 脚本或系统里自己找 | 只用 `assets/fonts/` 里捆绑的 Noto Sans SC |
| 运行时 | Agent 可 `fix`（venv + pip） | Agent 侧 `fix` 直接报错；装依赖只留给打包 `bootstrap-runtime` |
| 技能根目录 | 常写成 `$PILOT_HOME/skills/pdf` | 只用 `read_skill` 返回的 `<path>` 的 `dirname` |
| 长文（对话里的方案） | 容易写成临时 Python，或把全文塞进命令行 | `write_file` 写成 Markdown，再 `--markdown` |
| 改已有 PDF | `inspect` / `merge` / `split` / `rotate` / `forms-*` / `audit` / `render` | **同样保留**，默认输出到 `$PWD/exports/` |
| 用户在聊天里看到什么 | 通用对话不收集产物，前端没有预览/下载卡 | 成功 JSON 的 `output` 被收成 `.pdf` 卡片（预览 + 下载） |

### 1.2 Agent 可见命令

| 命令 | 改造前对 Agent | 改造后对 Agent | 说明 |
| --- | --- | --- | --- |
| `check` | 要跑，失败再 `fix` | 可不作为主路径；未就绪则 JSON 报「交付包不完整」 | 只诊断，不安装 |
| `fix` | **要求使用** | **禁止**（明确错误，不要 pip） | 打包机用 `bootstrap-runtime` |
| `scaffold` + `build` | **新建 PDF 的主路径** | SKILL 里不再教这条路 | CLI 里可能还在，但 Agent 不应调用 |
| **`make`** | 无 | **新建 PDF 的主路径** | 内部用捆绑字体排版，并做审计/渲染 |
| `inspect` | 有 | 有 | 读结构/文本/表 |
| `merge` / `split` / `rotate` | 有 | 有 | 改已有 PDF，源文件保留 |
| `forms-inspect` / `forms-fill` | 有 | 有 | AcroForm，不是 Word 式重排正文 |
| `audit` / `render` | 有 | 有；`make` 里已带一轮 | 对已有文件或编辑结果再验 |
| `self-test` | 有 | 有 | 给人/打包用，不是日常对话路径 |

「改 PDF」在技能里的含义仍是：**页面级操作**（合、拆、转、填表），不会像 Word 那样重排段落。见 `references/structure-and-forms.md`。

### 1.3 文件与运行时

| 路径 | 改造前 | 改造后 |
| --- | --- | --- |
| `SKILL.md` | 长流程：工作目录、scaffold、check/fix | 闸门：禁止写 py / pip / 搜系统字体；给出 `make` 和改文件命令 |
| `scripts/pdf.sh` | `check` / `fix` 装 venv | 未就绪 JSON 退出；`fix` 拒绝；`bootstrap-runtime` 仅打包 |
| `scripts/pdf_cli.py` | scaffold/build 为主 | 增加 `make`（`--title` `--body` `--body-file` `--markdown` `--spec` `--out` `--force`） |
| `assets/starter_pdf.py` | 给 Agent 改的脚手架 | 内部实现，Agent 不要复制、不要改 |
| `assets/fonts/NotoSansSC-VF.ttf` | 无 | 捆绑 CJK 字体（OFL，见 `OFL.txt` / `SOURCE.txt`） |
| `references/creation.md` | 教怎么写构建脚本 | 教怎么填 `make` 参数 |
| 中间产物 | `.pilotdeck/work/manual/.../pdf` | 默认 `$PWD/exports/`；qa/预览 PNG **不是**用户交付物 |
| 成功输出 | 视脚本而定 | JSON：`{"status":"ok","output":"<绝对路径>.pdf"}` |

`make` 覆盖已有文件必须加 `--force`，避免第二次生成时静默覆盖。

### 1.4 产品层（不在 `skills/pdf/` 里，但 PDF 体验依赖它）

通用对话的工作目录是 Pilot 家目录。改造前整段关掉文件产物收集，所以 PDF 生成了前端也没有卡。

| 点 | 改造前 | 改造后 |
| --- | --- | --- |
| 通用对话产物 | 不收集 | 收集 `.pdf` / `.docx`，且不扫整个 home |
| 来源 | — | 优先 bash 成功 JSON 的 `output`（`pdf.sh make` 就是这样出的） |
| 历史回放 | 通用对话隐藏全部产物 | 仍隐藏 json 等杂项，**PDF 会回来** |
| 聊天卡片 | 无 | 文件名 + 预览（右侧/编辑器）+ 下载 |
| 步骤条 | 命令截成约 48 字，成功无说明 | 用 `description` 当标题；`pdf.sh make → 文件名.pdf`；成功「已写入」/失败显示 CLI `error` |

Word 已把白名单扩到 `.docx`。PPT/表格以后同样需要扩展名白名单，并保证
对应 `*.sh` 成功 JSON 里有 `output`。

### 1.5 刻意没做的

- 没有改成在聊天气泡里嵌整份 PDF 翻页。
- 没有把 Word/PPT 的能力并进 PDF skill。
- 没有恢复 Agent 侧 `fix` / 手写 `build_pdf.py`。
- `scaffold` / `build` 若还在 CLI 里，只是没在 SKILL 闸门里开放。

### 1.6 给后面四个 skill 的对应关系

| PDF 已落地 | Word / PPT / 表格 / 图示应对齐 |
| --- | --- |
| `pdf.sh make` | 各自一条「生成」命令，JSON 带 `output` |
| Agent 禁用 `fix` | 不要 `check \|\| fix` |
| `read_skill` 的 `<path>` | 不要写死 `$PILOT_HOME/skills/...` |
| `--markdown` 吃对话长文 | 同样避免把全文塞进 bash 引号 |
| `inspect` + 页面操作仍在 | Word 的「改已有 docx」可以留，但不要再走 fallback 手写 py |
| 产品层只收 `.pdf` | 再为该 skill 的扩展名开白名单 |

---

## 2. Word（`skills/docx`）

Word **仍然能读取、编辑、批注/修订、比较、净化、刷新目录、审计和渲染
DOCX**。本次收敛的是普通新建文档和离线运行时，不是删除高级能力。

### 2.1 一句话对比

| | 改造前 | 改造后 |
| --- | --- | --- |
| 普通新建 Word | `check` → `capabilities` → `prepare` → `schema` → 写 spec → `create` → 逐页 QA → `preflight` → `deliver` | `docx.sh make --title/--body/--markdown/--spec --out` |
| 运行时缺依赖 | `fix` 现场建 venv + pip | `fix` 明确拒绝；仅打包阶段 `bootstrap-runtime` |
| Agent 回退 | 可写 Python，调用 `fallback-create` / `fallback-patch` | SKILL 闸门禁止手写 Python 和 fallback；`unsupported` / `blocked` 时停止 |
| 技能路径 | 示例写死 `$PILOT_HOME/skills/docx` | 只用 `read_skill` 返回 `<path>` 的 `dirname` |
| 字体 | SimSun/系统字体候选和 `fc-match` | 内置模板统一声明仓库捆绑 Noto Sans SC |
| 对话长文 | Agent 构造完整严格 spec，链路很长 | 写 Markdown 后 `make --markdown` |
| 改已有 Word | 完整高级工作流 | **保留**，仍走受控候选、QA、preflight、deliver |
| 前端交付 | 通用对话没有 DOCX 卡 | `.docx` 文件卡：预览 + 下载，历史回放也保留 |

### 2.2 新增 `make`

```bash
bash "$DOCX_TOOL" make \
  --title "救治方案" \
  --markdown "$PWD/exports/qa/content.md" \
  --out "$PWD/exports/救治方案.docx"
```

支持：

- `--title`
- `--body` / `--body-file`
- `--markdown`
- `--spec`（沿用现有严格 create spec）
- `--out`
- `--force`

Markdown 会把 ATX 标题、项目符号、编号项和普通段落映射为真正的 Word
结构。`make` 内部生成候选、校验 OOXML、运行结构审计；LibreOffice 可用时
还会生成页面预览。成功 JSON 的稳定交付字段是：

```json
{"status":"ok","output":"/absolute/path/救治方案.docx"}
```

LibreOffice 不可用时不会伪装做过视觉 QA：结果保留成功的结构校验，同时
返回 warning，`preview` 为空。

### 2.3 运行时与字体

| 路径 | 改造前 | 改造后 |
| --- | --- | --- |
| `scripts/docx.sh` | 优先系统 Python；`fix` 可在线 pip | 只执行带 hash stamp 的隔离 venv；`fix` 拒绝；新增 packager-only `bootstrap-runtime` |
| hash | 无稳定 runtime stamp | requirements 内容 + **venv Python 主次版本** |
| 内置模板 | 中文 SimSun、默认 Noto Serif 候选 | 中文和默认都声明 `Noto Sans SC` |
| 字体来源 | 系统/平台候选 | 复用内置 PDF 包的 `assets/fonts/NotoSansSC-VF.ttf`；运行时设置 `DOCX_SKILL_FONT_DIR` |
| LibreOffice 渲染 | 依赖系统字体/用户配置 | 额外传 `SAL_FONTPATH` 指向捆绑字体目录 |

DOCX 本身通常只记录字体名称，不像 PDF 那样天然嵌入整套字体；因此这里的
「捆绑字体」首先保证 PilotDeck 的离线渲染一致，其他机器打开时仍取决于
Word 的字体替换规则。

### 2.4 保留的修改能力

| 能力 | 命令 | 状态 |
| --- | --- | --- |
| 读取结构/元数据 | `inspect` | 保留 |
| 定向编辑 | `edit` | 保留；先 `prepare --existing-document` + edit schema |
| 批注/修订 | `review` | 保留 |
| 接受/拒绝修订、删批注 | `finalize` | 保留 |
| 版本对比 | `compare` | 保留 |
| 清理个人元数据 | `sanitize` | 保留 |
| 刷新目录 | `refresh-toc` | 保留 |
| 包校验/结构审计/页面渲染 | `validate` / `audit` / `render` | 保留 |
| 候选预检与最终提升 | `preflight` / `deliver` | 保留给高级编辑工作流 |
| 手写 Python 回退 | `fallback-*` | CLI 兼容实现未删除，但 SKILL 不开放，Agent 禁止调用 |

普通新建不再走高级交付链；编辑已有 DOCX 仍保留这套链路，以避免静默破坏
批注、修订、内容控件、宏、签名或复杂 OOXML。

### 2.5 产品层

| 点 | 改造 |
| --- | --- |
| 通用对话白名单 | `.pdf` 扩为 `.pdf` + `.docx` |
| 收集来源 | bash 成功 JSON 的 `output` / `out` |
| 噪声过滤 | `.docx-qa`、spec、audit、预览 PNG 不作为交付物 |
| 历史回放 | 通用对话允许 DOCX artifact 恢复 |
| 步骤条 | `docx.sh make → 文件名.docx`，成功显示「已写入 …」 |
| 文件卡 | 使用现有办公预览入口和下载按钮 |

### 2.6 新增/修改文件

- 重写 `skills/docx/SKILL.md` 为 Agent 闸门；
- 新增 `skills/docx/references/creation.md`；
- 更新 `references/specifications.md`，区分普通 `make` 与高级编辑；
- 新增 `scripts/docxlib/make.py`；
- 更新 `scripts/docx_cli.py`、`scripts/docx.sh`；
- 更新模板、字体解析和 LibreOffice 渲染环境；
- 扩展 Gateway artifact 收集、历史回放及 chat-v2 步骤摘要；
- 增加 PDF + DOCX artifact 和步骤展示测试。

### 2.7 当前验证结果

- 中文 `--title` + `--body`：创建成功，OOXML 校验和 audit 通过；
- Markdown 长文：创建成功，标题层级和 Noto Sans SC 写入正确；
- artifact 后端测试：PDF/DOCX 均可从 bash JSON 收集；
- history/UI 测试：DOCX 卡片历史恢复与步骤摘要通过；
- 页面 PNG 依赖 LibreOffice，**不作为离线部署硬依赖**；无 LibreOffice 时
  `make` 仍写出 DOCX，并带 warning。现场不要为 Word Skill 安装 LibreOffice；
- `bootstrap-runtime` 已在隔离 venv 安装 requirements 并通过 `check`；
- 运行时目录由 `XDG_CACHE_HOME` 决定。App 启动会把它指到
  `.runtime/cache/xdg`，在普通终端里预热会落到 `~/.cache`，网关看不到就报
  「交付包不完整」。`scripts/bootstrap-runtime.sh` 与
  `bootstrap-runtime-darwin.sh` 现在会自动预热 pdf + docx + pptx + spreadsheets 运行时，并在收尾
  摘要里报告每个技能的状态；
- `fix` 已验证返回 `offline-install-disabled`，默认隔离运行时的
  `docx.sh make` 端到端通过。

### 2.8 后续补记（与 2.1–2.7 同一轮改造，日志原先漏写的）

这些不是另一次重构，而是落地后补进记录，避免 PPT 对照时漏项。

**Agent 闸门文档**

- `references/workflows.md`：普通新建改为 `make`；编辑已有文件才走
  `prepare` / 候选 / `deliver`。
- `references/capabilities-and-fallbacks.md`：重写为限制说明；Agent 禁止
  `fallback-create` / `fallback-patch`。
- `references/specifications.md`、`ooxml-and-safety.md`：去掉「用 fallback
  Python 绕过」的指引。
- 远程图片错误文案改为「使用工作区里已有的本地路径」，不再暗示先下载。

**短文不必先写 Markdown**

- `--title` + `--body` 可一步出 DOCX。
- `--markdown` / `--body-file` 只为长文和标题层级服务，避免把全文塞进
  bash 引号。
- `--spec` 留给表格、图片、封面等精确结构。

**离线现场**

- LibreOffice **不是**部署硬依赖。无渲染后端时 `make` 仍成功，`preview`
  为空并带 warning；Agent 不得为此安装软件。
- 运行时真正位置是
  `$PILOTDECK_ROOT/.runtime/cache/xdg/pilotdeck-docx/venv`（由启动脚本设置
  `XDG_CACHE_HOME`）。在普通终端预热会落到 `~/.cache/pilotdeck-docx`，网关
  看不见就会报「交付包不完整」。那份 `~/.cache` 副本已删除。
- `scripts/bootstrap-runtime.sh` 与 `bootstrap-runtime-darwin.sh` 在
  `apply_local_runtime_env` 之后预热 **pdf + docx + pptx + spreadsheets**。
- Python 字节码 `__pycache__` / `*.pyc` 已忽略并清掉，不进仓库和交付包。

**产品层文件（补全）**

- `src/session/artifacts/FileArtifactCollector.ts`：bash JSON 收集
  `.pdf` / `.docx`；排除 `.docx-qa`。
- `src/cli/createLocalGateway.ts`：通用对话白名单 `.pdf` + `.docx`。
- `src/web/server/readSessionMessages.ts`：历史回放同样放行这两种。
- `ui/src/components/chat-v2/processGrouping.ts`：`docx.sh make → 文件名`。

**刻意没做的**

- 没有把 `fallback-*` 从 CLI 删掉（smoke / 旧协议仍依赖）。
- 没有把 Word 运行时装进 `skills/docx/runtime/` 目录；仍用 XDG 下的隔离
  venv，与 PDF 一样靠打包机预热。
- 没有做聊天气泡内嵌整份 Word。

---

## 3. PowerPoint（`skills/pptx`）

PowerPoint 已从「Agent 写 `.mjs` + `check || fix`（`npm ci`）+
`scaffold` / `build` / `deliver`」收敛为 `pptx.sh make`。普通新建不依赖
LibreOffice 页面渲染；模板编辑和旧命令仍保留。

### 3.1 现状（改造前）

| 项 | 现状 |
| --- | --- |
| 入口 | `scripts/pptx.sh` → Node `pptx_cli.mjs` |
| 运行时 | `skills/pptx/runtime/package.json` + lockfile；`fix` 把依赖 `npm ci` 进 `$XDG_CACHE_HOME/pilotdeck-pptx/runtime` |
| 新建 | `scaffold` 出 `deck.mjs`，Agent 改脚本，再 `build` / `deliver` |
| 引擎 | 全新页用 **PptxGenJS**；跟模板用 **pptx-automizer** |
| 字体 | 设计令牌写 Arial / YaHei / PingFang 等**系统字体名**；文档明确「跨平台没有可假设已装的中文字体」 |
| 渲染 | LibreOffice `soffice` 转 PDF，再用 `pdftoppm` / `mutool` / `magick` 出 `slide-N.png` |
| 终稿 | SKILL 要求 `deliver`，且 `delivery.status` 与 `seal.status` 都为 `passed` 才算完成 |
| 技能根 | 示例仍偏「自己解析目录」；SKILL 仍教 `check \|\| fix` |
| 产品层 | 通用对话白名单还没有 `.pptx` |

CLI 子命令：`check` `fix` `convert` `scaffold` `build` `deliver` `inspect`
`render` `audit` `validate-map` `prepare-starter` `apply-template`
`fidelity` `self-test`。**没有** PDF/Word 那种 `make`。

### 3.2 和 PDF/Word 的关键差别

1. **运行时是 Node，不是 Python。** 现场风险是 `npm ci`，不是 `pip`。闸门
   同样必须禁止 Agent 调 `fix`；打包机用 `pptx.sh bootstrap-runtime`。
2. **Agent 今天被要求写 JavaScript。** 这等同于 PDF 旧的 `build_pdf.py`、
   Word 旧的 fallback Python，是离线现场最大的失控面。
3. **幻灯片是分页对象，不是一篇长文。** `--body` 一整段不够；`make` 需要
   「每页一条」的输入（Markdown 按 `#` / `##` 切页，或 JSON spec）。
4. **视觉 QA 更重。** 当前 SKILL 把每页 PNG 当成硬门禁。离线现场**不装
   LibreOffice**，因此 `make` 必须像 Word 一样：结构审计通过即可交付，
   渲染缺失只 warning，禁止 Agent 去装软件。
5. **已有一套布局库。** `assets/layout-library/`（title / section / metric
   / timeline / closing 等）应变成 `make` 的内部实现，而不是给 Agent 改的
   脚手架。`assets/starter-deck.mjs` 应对齐 PDF 的 `starter_pdf.py`：内部
   用，Agent 不要复制。

### 3.3 改造结果

**新建主路径**

```bash
bash "$PPTX_TOOL" make \
  --title "战创伤四级救治" \
  --markdown "$PWD/exports/qa/slides.md" \
  --out "$PWD/exports/战创伤四级救治.pptx"
```

实际参数：`--title` `--body` `--body-file` `--markdown` `--spec`
`--locale` `--footer` `--out` `--force`。成功 JSON 带 `"output"` 绝对
路径。覆盖已有文件必须 `--force`。

Markdown 约定：一级/二级标题变幻灯片标题；标题下的段落、列表、
简单表进入该页正文；不要把规划备注写进幻灯片。复杂图表、精确坐标、模板
继承不走 `make` 的 Markdown，改走 `--spec` 或保留的模板命令。

**Agent 闸门（SKILL.md）**

- 只用 `read_skill` 的 `<path>` 定根。
- 禁止 `write_file` 写 `*.mjs` / `*.js` / `*.py` 来生成 PPT。
- 禁止 `fix`、`npm ci`、`check || fix`、搜索系统字体、安装 LibreOffice。
- 未就绪时报「交付包不完整」并停止。
- 默认输出 `$PWD/exports/`；qa PNG、builder、audit JSON 不交付。

**运行时**

- 镜像 `pdf.sh`：`runtime_ready` + stamp（lockfile hash）；`fix` 返回
  `offline-install-disabled`；新增 packager-only `bootstrap-runtime`
  （现有 `fix` 的 `npm ci` 逻辑搬过去）。
- 已接入 `scripts/bootstrap-runtime.sh` / `-darwin.sh` 的技能预热列表。
- 依赖仍用仓库里已 pin 的 `runtime/package-lock.json`，现场只执行预热好的
  `node_modules`，不访问 npm registry。

**字体**

- 无模板的新建：与 Word 一样声明捆绑 **Noto Sans SC**（复用
  `skills/pdf/assets/fonts/`），不要 YaHei/PingFang 作为默认写入名。
- PPTX 同样通常不嵌入整套字体；捆绑字体服务离线渲染一致性，PowerPoint
  打开时仍可能按系统替换——这点要在 SKILL 里写清，不要承诺像素级一致。
- 用户提供的模板：继续继承模板主题字体，不要强行换成 Noto。

**保留的改已有文件能力（SKILL 仍开放，但不要求渲染才能用）**

| 能力 | 命令 | 改造时怎么处理 |
| --- | --- | --- |
| 读结构 | `inspect` | 保留 |
| 旧版 `.ppt` → `.pptx` | `convert` | 保留；无 LibreOffice 时明确 `unsupported`，不要现场安装 |
| 模板映射/编辑 | `validate-map` / `prepare-starter` / `apply-template` / `fidelity` | 保留；输入改为 JSON 映射 + edits，不要再让 Agent 写 `.mjs` |
| 结构审计 | `audit` | 保留；`make` 内部跑一轮 |
| 页面渲染 | `render` | CLI 保留；Agent 不把它当交付前提 |
| 封印交付 | `deliver` | 高级/模板路径可留；普通 `make` 直接写用户 `--out` |
| 脚手架构建 | `scaffold` + `build` | CLI 可留作内部；SKILL 不再教 |

**产品层**

- 通用对话白名单加上 `.pptx`。
- 收集 bash JSON 的 `output`；排除 `.pptx-qa` / 中间 `.mjs`。
- 步骤条：`pptx.sh make → 文件名.pptx`，成功「已写入 …」。
- 文件卡走现有办公预览 + 下载。

**刻意不做**

- 不为离线现场增加 LibreOffice / Poppler / ImageMagick 安装项。
- 不在聊天气泡里嵌整套幻灯片翻页。
- 不把 HTML 演示或 Google Slides 并进本技能（继续指向 `diagram-maker`）。
- 第一波不删除 `scaffold`/`build`/`deliver` 的 CLI 实现，以免 `self-test`
  一次性崩掉；只从 Agent 可见契约拿掉。

### 3.4 文件与实现

- `skills/pptx/scripts/lib/make.mjs`：新增 Markdown/body/spec 解析、布局映射、
  结构审计、可选渲染和原子交付。
- `assets/layout-library/layouts/core.mjs`：新增通用 `contentSlide` 并登记到
  template registry；`metric` 同时兼容旧 registry 的 `metrics` 名称，其它
  title、section、timeline、chart、table、quote、closing 等布局复用。
- `pptx_cli.mjs`：新增 `make` 子命令。
- `pptx.sh`：`fix` 返回 `offline-install-disabled`，新增 packager-only
  `bootstrap-runtime`，未就绪返回「交付包不完整」。
- `SKILL.md`：重写为 Agent 闸门；`scaffold` / `build` 只保留兼容，不开放。
- `references/creation.md`：记录 Markdown 与 spec 契约。
- Gateway / history / chat-v2：通用对话放行 `.pptx`，排除 `.pptx-qa`，
  步骤摘要显示 `pptx.sh make → 文件名.pptx`。
- 打包脚本：预热列表现在包含 pdf + docx + pptx + spreadsheets。

### 3.5 验证结果与残余风险

- `pptx.sh bootstrap-runtime` 在 App 的 XDG 缓存下安装 143 个锁定 Node 包，
  `check` 返回 dependencies ready，并验证捆绑 Noto Sans SC；若存在可选
  LibreOffice，`SAL_FONTPATH` 会指向该字体目录。
- `fix` 已验证返回 `offline-install-disabled`。
- 中文 `--title` + `--body`：2 页 PPTX 生成成功，OOXML inspect 与 audit
  通过，0 error / 0 warning。
- Markdown 长文：26 页 PPTX 生成成功，结构审计通过。
- JSON spec：metric + timeline 共 3 页生成成功，结构审计通过。
- 当前机器无 LibreOffice：`preview=[]` + warning，PPTX 仍正常交付。
- artifact 后端 21 项通过；chat-v2 相关前端 30 项通过。
- 内置 `self-test` 完整通过：build、inspect、audit、覆盖率门禁、warning
  disposition、原子封印、模板 clone/edit 均通过；render 按预期 skipped。
- 高级 `deliver` 现在允许结构与门禁均通过但可选渲染缺失的
  `passed_with_warnings` 产物封印；未解决 audit warning 仍然阻断。
- `sharp` 是原生模块，离线包仍必须在与目标架构一致的 Node 环境预热。
- `self-test` 中旧的 scaffold/build/deliver/渲染契约未删除；普通 `make`
  不修改这些兼容路径。


## 4. 表格（`skills/spreadsheets`）

表格已从「Agent 写 `.mjs` + `check || fix` + `build` + 强制
LibreOffice 重算/渲染」收敛为 `spreadsheet.sh make`。新建与安全编辑已有
XLSX 都走声明式参数；旧 builder 命令只保留兼容。

### 4.1 改造前

- `SKILL.md` 要求 `check || fix`，现场 `npm ci`。
- 新建和编辑都由 Agent 修改 `workbook.mjs`。
- 非平凡工作簿必须自己写 `requirements.json`。
- 只要有公式，`build` 就强制 LibreOffice 写回缓存结果；无 soffice 直接
  失败。
- 每个终稿必须渲染工作表 PNG，再由 `deliver` 封印。
- 通用对话不收集 `.xlsx`。

### 4.2 新建与编辑主路径

```bash
bash "$SHEET" make \
  --spec "$PWD/exports/qa/workbook.json" \
  --out "$PWD/exports/统计工作簿.xlsx"
```

`make` 支持：

- `--title` + `--body` / `--body-file`：简单单列表格；
- `--markdown`：GitHub 管道表；
- `--csv` / `--tsv`：保留编码、前导零和长标识符；
- `--spec`：多表、公式、数字格式、表格、数据验证、条件格式、原生图表；
- `--input existing.xlsx --spec edits.json`：受控修改已有单元格/公式；
- `--out` / `--force`：原子交付，成功 JSON 带绝对 `output`。

已有 XLSX 编辑先检查 `unsafeForRoundTrip`；有图表、宏、透视表、外链、
签名等风险对象时默认阻断。源文件不覆盖。

### 4.3 公式与 LibreOffice

表格和前三种文档最大的差异是公式。ExcelJS 能写公式，但不是完整公式计算
引擎。

- 有 soffice：`make` 重算并写回公式缓存结果。
- 无 soffice：公式原样保留，设置 `fullCalcOnLoad` / `forceFullCalc`，让
  Excel 打开时重算。
- 缺缓存结果在普通 `audit` / 旧 `deliver` 里仍是硬门禁；只在
  `make` 的无 soffice 模式下降为明确 warning。
- 不伪造 `result: 0`，不自研完整公式引擎。
- 外部工作簿引用、`WEBSERVICE`、`FILTERXML`、`RTD` 和远程
  `HYPERLINK` 被阻断。
- 页面 PNG、旧 `.xls` 转换和显式 `recalculate` 仅在已有 LibreOffice 时
  使用；缺失不提示安装。

### 4.4 离线运行时与字体

- `spreadsheet.sh fix` 返回 `offline-install-disabled`。
- 新增 packager-only `bootstrap-runtime`，使用锁定
  `runtime/package-lock.json` 安装 110 个 Node 包。
- 仓库 `bootstrap-runtime.sh` / `-darwin.sh` 已加入 `spreadsheets`，并
  处理目录名复数、入口脚本 `spreadsheet.sh` 单数的差异。
- `runtime_ready` 同时检查 ExcelJS、CSV、OOXML、sharp 和捆绑
  Noto Sans SC。
- 新建表格默认声明 Noto Sans SC；可选 LibreOffice 只读取捆绑字体目录，
  不扫描系统字体。

### 4.5 Agent 闸门

- Agent 可见表面只保留 `spreadsheet.sh` 与声明式 `.md/.json/.csv/.tsv`
  输入；输入尚未结构化且没有现成抽取工具时停止并说明能力缺口。
- 禁止 `fix`、现场安装、系统字体搜索和 LibreOffice 安装。
- `scaffold` / `build` 只保留维护兼容，不再写入 Agent 主流程。
- CSV/TSV 不允许多工作表、公式或图表；这些需求必须输出 XLSX。
- `.xlsm`、Google Sheets、实时 Excel、宏与未授权 risky round-trip 不支持。

### 4.6 产品层

- 通用对话白名单加入 `.xlsx`，但不放行任意 `.csv`，避免家目录误收。
- bash JSON `output` 可成为 XLSX artifact；排除 `.xlsx-qa` 与中间文件。
- 历史回放识别 XLSX MIME。
- 步骤条显示 `spreadsheet.sh make → 文件名.xlsx`，成功「已写入 …」。
- 文件卡沿用现有表格预览与下载组件。

### 4.7 验证结果

- 简单中文 body → XLSX：通过，0 公式、结构与覆盖审计通过。
- Markdown 管道表 → 原生 Excel table：通过。
- CSV → XLSX：源 SHA-256、事实矩阵、前导零文本与覆盖审计通过。
- 简单内容直接输出 CSV：UTF-8 BOM 与分隔文件审计通过。
- JSON spec：3 条公式、数字格式、列表验证、原生 column chart：通过；
  无 LibreOffice 时保留公式并返回重算 warning。
- `--input` 受控编辑已有 XLSX：单元格、公式、数字格式通过，源文件未覆盖。
- 离线 `self-test`：create、audit、coverage、2 条公式、1 个原生图表通过；
  recalculate/render 按预期 skipped。
- artifact 后端 22 项通过；chat-v2 前端 31 项通过。
- `fix` 已验证返回 `offline-install-disabled`。

### 4.8 刻意不做

- 不为离线现场安装 LibreOffice 或完整公式引擎。
- 不删除旧 `scaffold/build/deliver/self-test` 的兼容代码。
- 不把工作表 PNG 作为用户交付物。
- 不在聊天气泡里嵌整本工作簿。

## 5. 全局声明式自动化边界

2026-08-21 排查 CDA/XML → Excel 失败会话时发现：文档 Skill 虽然要求使用
捆绑入口，但系统提示、`write_file` 与 `bash` 的工具说明仍主动推荐 Agent
保存并运行自建程序。该高优先级引导与 Skill 闸门冲突，导致 Agent 写出
`extract_med_reports.py`，并在零数据行时静默继续。

现统一为医疗/文档离线产品的全局策略：

- 系统提示只推荐「注册工具 + 捆绑 Skill 入口 + 声明式输入」，不再向模型
  描述自建程序工作流。
- `write_file` / `edit_file` 的模型可见用途收敛为 Markdown、JSON、CSV、
  TSV、纯文本等声明式内容。
- `bash` 的模型可见用途收敛为本地检查、文件管理与捆绑 Skill 入口。
- ToolRuntime 在权限判断之前硬阻断可执行源码写入、解释器/编译器、动态
  shell、heredoc、构建/包管理器和任意可执行路径；因此
  `bypassPermissions` 也不能放行。
- `pdf.sh` / `docx.sh` / `pptx.sh` / `spreadsheet.sh` 作为唯一允许的文档
  转换入口继续可用；Skill 示例改为包含真实入口文件名，便于运行时准确识别。
  图示落地后把 `diagram.sh` 加进同一白名单。
- 当前产品没有注册 `agent` 工具，不存在模型可触发的子 Agent 路径，因此
  不增加无效的子 Agent 状态继承设计。

## 6. 图示（`skills/diagram-maker`）

2026-08-21 已完成。图示原先是五个内置技能里唯一没有捆绑入口的，等于让
模型自己当画图引擎；现在已与 PDF/PPTX 对齐：Agent 只填声明式图，
`diagram.sh` 负责布局、审计和出文件。

### 6.1 现状（改造前）

目录里只有 `SKILL.md`、`references/svg-template.md`、
`references/excalidraw-patterns.md`，没有 `scripts/diagram.sh`。

闸门仍在教模型做三件事：

1. 在三种**成品形态**里自选：`clean-svg`、`architecture-svg`、`excalidraw`
2. 复制 HTML 外壳，手写 SVG 坐标和箭头
3. 或手写完整 Excalidraw JSON（元素 `id`、绑定文本、箭头 `points`）

这三种形态分别是：

| 名称 | 是什么 | 典型用途 |
| --- | --- | --- |
| `clean-svg` | 干净的方框+箭头示意图，做成内联 SVG 的单文件 HTML | 教学概念、流程、生命周期、简单数据流 |
| `architecture-svg` | 同样是 SVG/HTML，节点形状和分区偏架构图 | 服务、数据库、队列、信任域 |
| `excalidraw` | `.excalidraw` JSON，给 Excalidraw 打开后还能拖改 | 手绘白板、可继续编辑的草图 |

它们不是三种运行时，而是三种「模型自己画」的输出约定。`clean` 与
`architecture` 的差别主要在题材和图形语言；Excalidraw 则是另一套编辑器
内部协议，聊天里也不能当图预览。

全局自动化策略拦的是 `.py` / `.js` / 解释器，**不拦** `.html` / `.svg` /
`.excalidraw`。因此图示这条手写路径现在仍然合法，也最容易框重叠、箭头
对不齐，或在坐标上反复修改。e2e 用例还要求「保存为 `diagram.html`」，
等于默认模型手写 HTML。

产品层通用对话只收 `.pdf/.docx/.pptx/.xlsx`，即使写出了 SVG 也不会出
预览/下载卡。

### 6.2 为什么不让模型写 SVG / HTML / Excalidraw

交付物仍然可以是 SVG。禁止的是模型去做排版引擎：

- **SVG 坐标**：每个框的 `x,y,width,height` 和箭头路径。模型没有几何
  求解器，这和让它写 Python 去生成 Excel 是同一类失败。
- **完整 HTML**：doctype、CSS 变量、暗色模式每次相同，不该每张图重写；
  手写 HTML 也不走 `*.sh make` 的 JSON `output`，前端收不成卡片。
- **Excalidraw 元素数组**：标签必须是绑定文本，箭头必须 `startBinding` /
  `endBinding`。漏一项文件在编辑器里就坏。这是在手写编辑器协议，不是在
  描述「A 指向 B」。

对照已改造技能：模型提供节点、边、分组和方向；坐标、外壳、元素协议留给
捆绑脚本。

### 6.3 改造后主路径

```bash
DIAGRAM_SKILL_ROOT="$(dirname "<path>")"
mkdir -p "$PWD/exports" "$PWD/exports/qa"
# write_file 只写 .mmd / .json
bash "$DIAGRAM_SKILL_ROOT/scripts/diagram.sh" make \
  --markdown "$PWD/exports/qa/flow.mmd" \
  --out "$PWD/exports/救治流程.svg"
```

`make` 已支持：

| 参数 | 用途 |
| --- | --- |
| `--title` / `--body` | 短线性流程，如 `分诊 → 抢救 → 后送` |
| `--markdown` | Mermaid 子集：`flowchart` / `graph TD\|LR`，节点、边、子图 |
| `--spec` | JSON：nodes / edges / groups / layout / kind |
| `--theme clean\|architecture` | 形状和语义色（原 clean-svg / architecture-svg 收成主题，不是两套引擎） |
| `--format svg`（默认） | 用户交付物 |
| `--format html` | 用现有模板把 SVG 包进单文件 HTML，可选 |
| `--out` / `--force` | 与 PDF 相同；成功 JSON 带绝对 `output` |

内部先把输入收成一份图模型再布局，不要让 Agent 在三种输出格式之间做几何。

**Excalidraw 没有进入主路径。** 聊天里不好预览，元素协议脆，和
「不要手写实现」冲突。若以后要可编辑白板，从同一份 spec 导出，不要让
模型写 `boundElements`。

改已有图：图示不像 PDF 有合页拆页。改图 = 改 spec 再 `make --force`。
第一期不做从已有 SVG 反解析。

不支持的 Mermaid（时序图、类图、gitGraph 等）返回 `unsupported` 并停止，
不要降级成模型手写 SVG。

### 6.4 Agent 闸门

- 只用 `read_skill` 返回 `<path>` 的 `dirname`。
- 只调用 `diagram.sh`；只用 `.md` / `.mmd` / `.json` 暂存声明式内容。
- 禁止手写 `.html` / `.svg` / `.excalidraw` 作为生成器。
- 禁止现场安装、浏览器、Graphviz、Mermaid CLI、搜索替代工具。
- 未就绪或 `unsupported` 时停止并报告。
- 默认输出 `$PWD/exports/`；中间 spec 放 `exports/qa/`，不交付。

第一期闸门用 SKILL.md 禁止手写 HTML/SVG。是否像 `.py` 一样硬拦
`.html/.svg` 写入，观察后再定——HTML 误伤面比 Python 大。

`diagram.sh` 已加入 `automationPolicyConstraints.ts` 的捆绑入口白名单。

### 6.5 运行时与字体

- 已新增 `skills/diagram-maker/scripts/diagram.sh` + Python CLI。
- **不新增 pip/npm 依赖**，不引入 Puppeteer / Chrome / `@mermaid-js/mermaid-cli` /
  Graphviz。离线现场不能再多装一个浏览器。
- 解析 Mermaid 子集和 JSON spec；分层布局（LR/TB、简单分组/泳道）；按现有
  模板语义色画框、线、箭头。
- `fix` 明确拒绝；`bootstrap-runtime` 只检查交付包 Python，不安装依赖。
  Linux/macOS 总预热脚本均已加入 `diagram-maker`。
- 中文第一期用 SVG `<text>` + 系统 UI 字体。SVG 是矢量，不必像 PDF 那样
  嵌 Noto。若现场中文方框缺字，再考虑嵌捆绑字体，不当第一期硬依赖。

### 6.6 产品层

- 通用对话 `artifactAllowedExtensions` 已增加 `.svg`。HTML 不进通用对话
  产物白名单，也不 iframe，避免 XSS。
- 收集 bash JSON 的 `output`。
- 历史回放识别 SVG MIME / `.svg`。
- 步骤条：`diagram.sh make → 文件名.svg`，成功「已写入 …」。
- 文件卡：SVG 当图预览 + 下载。HTML 若产出则只提供下载，或只预览其中的 SVG。
- 更新 `tests/skill-e2e/cases.json` 的 diagram-maker 用例：不再要求模型
  手写 `diagram.html`，改为走 `diagram.sh make`。

### 6.7 文件与实现

| 路径 | 实现 |
| --- | --- |
| `SKILL.md` | 重写为闸门：`diagram.sh make`，禁止手写 SVG/HTML/Excalidraw |
| `scripts/diagram.sh` | 新入口；`make` / `check` / `self-test`；`fix` 拒绝 |
| `scripts/diagram_cli.py` | 解析、分层布局、安全审计、原子写入 SVG/可选 HTML |
| `references/creation.md` | 教 `--markdown` / `--spec`，取代「复制模板填坐标」 |
| `references/svg-template.md` | 降为内部 HTML 外壳，Agent 不要复制 |
| `references/excalidraw-patterns.md` | 第一期不开放给 Agent |
| Gateway / history / chat-v2 | 放行 `.svg`，步骤摘要显示 `diagram.sh make` |

### 6.8 刻意不做

- 不把 `frontend-slides`、完整 Mermaid、PlantUML、D2 并进本技能。
- 不为离线现场增加 Chrome / Graphviz / 字体安装项。
- 不在聊天气泡里嵌可交互白板。
- 不让模型继续「复制 template + 填 SVG」。
- 不做 Excalidraw 主路径，也不做已有 SVG 的反向编辑。

### 6.9 验证结果

- `check` 与 `self-test` 通过；运行时只依赖交付包 Python 标准库。
- `--body "分诊 → 抢救 → 后送"` 生成 3 节点、2 条边的中文 SVG。
- Mermaid `flowchart LR` 生成合法 SVG，分支边标签保留。
- 非 flowchart Mermaid 返回 `invalid-diagram-input`，没有手写回退。
- 已存在输出且无 `--force` 时拒绝覆盖，原文件保持不变。
- SVG 审计阻断脚本、`javascript:` 和外部 `href/src`。
- automation policy、artifact collector、历史回放共 28 项定向后端测试通过。
- chat-v2 步骤摘要 7 项前端测试通过，显示
  `diagram.sh make → 文件名.svg` 与「已写入」。
- 通用对话收集 `.svg`；文件卡和代码编辑器现有图片预览路径原本就支持 SVG，
  因此可预览和下载。
- 仓库全量 TypeScript build 仍被既有
  `scripts/run-skill-e2e.ts` 的 `Dirent<string>` /
  `Dirent<NonSharedBuffer>` 类型错误阻断；该错误与本次图示改动无关，未扩大
  任务范围修改。

### 6.10 上线后修复的两个缺陷

首次真实会话「把战创伤急救止血方式的流程画成一个图」失败，暴露两个独立缺陷。
两者都不是设计问题，但都能让整条链路对用户表现为「入口被拦住」。

**缺陷一：策略把技能自己的 `make` 子命令误判成 GNU make。**

`getAutomationPolicyViolation` 先把捆绑入口从命令里删掉，再拿残渣匹配黑名单。
删成空串后，`make` 就紧贴在前一个 `;` 或 `&&` 后面，落进
`BUILD_OR_PACKAGE_RUNNER` 的命令起始位判定，而 `make` 同时是 GNU make 的名字：

```text
原始：  ...; bash "$DIAGRAM_SKILL_ROOT/scripts/diagram.sh" make --markdown ...
残渣：  ...;  make --markdown ...        ← 被判定为构建工具
```

命令起始位字符类是 `[;&|]`，不含换行，`^` 也没开 `m` 标志。所以用换行串联能过、
用 `;` / `&&` 串联被拦，表现为随机复现；同一次会话里 `spreadsheet.sh` 调 16 次
全过就是因为它用的是换行。原有单元测试只覆盖裸命令形式（残渣以空格开头，
`^` 后紧跟空格不匹配），恰好漏掉了这个缺口。

修法是把剥离时的空串换成占位词 `BUNDLED_ENTRYPOINT_PLACEHOLDER`，
让入口自己的参数不再处于命令起始位。豁免范围精确收窄到「跟在捆绑入口后面的
参数」：`bash pdf.sh …; make clean` 里 `make` 前面的 `;` 仍然保留，照样拦截。
测试补上 `;`、`&&` 和换行三种串联写法，以及两条应被拦的真实构建命令。

影响面是全部五个技能——`pdf`/`docx`/`pptx`/`spreadsheet`/`diagram` 主命令都叫
`make`，这次只是恰好被图示碰上。

**缺陷二：Mermaid 子集不认最常用的流程图写法。**

Agent 写出的是完全标准的 Mermaid，但解析器三处不支持，直接返回
`invalid-diagram-input`：

| 写法 | 之前 | 现在 |
| --- | --- | --- |
| `B{是否为外出血?}` 菱形判断节点 | 报「不支持的节点语法」 | 支持，渲染成菱形，新增 `decision` kind |
| `B -- 否 --> C` 短横线边标签 | 报错（只认 `-->|标签|`） | 与 `-->|标签|` 等价 |
| 方括号内换行 / `<br/>` | 断成两条语句后报错 | 自动重新拼接为一个节点 |

顺带修掉一个既有排版缺陷：`wrapped_lines` 的提前返回用字符数
（`len(label) <= maximum`），而循环体用的是 CJK 加权宽度，两者不一致，导致
17 个汉字的标签判定为「无需换行」后溢出 184px 节点框。现在统一走
`text_width`，默认阈值按 14px 字号下的实际可用宽度改为 11 个汉字单位；
菱形在顶点附近更窄，`node_lines` 给判断节点用 9 并额外加高 32px。
边标签加 `paint-order="stroke"` 白色描边，压在连线上时仍可读。

用户那份真实 `.mmd`（21 节点、26 条边、7 个判断节点）现在能正常导出 SVG，
节点无重叠。已知局限：布局是拓扑分层，分支多的长流程会形成 544×3868 这类
细长图，可读但偏高；改成 Sugiyama 类布局是独立任务，本次没做。

验证：`tests/tool/diagram-skill.spec.ts` 新增判断节点/边标签/标签换行用例，
`tests/tool/automation-policy-constraints.spec.ts` 新增串联写法用例，
后端 `tests/{tool,session,web,context}` 全量 114 项通过。
