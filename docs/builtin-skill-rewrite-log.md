# 五个内置文档 Skill 改造记录

持续记录仓库 `skills/` 里这五个离线文档技能的改造，方便对照「改了什么、为什么、别的 skill 怎么复用」。

| Skill | 目录 | 状态 |
| --- | --- | --- |
| PDF | `skills/pdf/` | 已改造（本文第 1 节） |
| Word | `skills/docx/` | 已改造（本文第 2 节） |
| PowerPoint | `skills/pptx/` | 已改造（本文第 3 节） |
| 表格 | `skills/spreadsheets/` | 已改造（本文第 4 节） |
| 图示 | `skills/diagram-maker/` | 未开始 |

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

- 禁止写 `.mjs` / `.js` / `.py` 生成表格。
- 禁止 `fix`、npm、npx、pip、系统字体搜索和 LibreOffice 安装。
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

## 5. 图示（`skills/diagram-maker`）

未开始。
