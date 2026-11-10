# 通用文档 Skill 优化任务书

> 范围：`skills/` 内 `docx`、`pptx`、`spreadsheets`、`pdf`、`frontend-slides`、`diagram-maker` 六项通用技能。
>
> 版本：v2.4.1（2026-11-09，适配 `feat/permission-arch-v2`）。这是后续编码的执行和进度记录；每项能力以本分支实际测试结果为准。
>
> 执行规则：完成一个子项后才勾选，并在第 9 节写验收结果；需求变化在第 10 节追加记录。先保持原有功能可用，再逐步启用新能力。

## 0. 给使用者看的任务概览

| 阶段 | 做什么 | 解决什么问题 | 交付时能看到什么 | 当前状态 |
| --- | --- | --- | --- | --- |
| **T0 基线** | 用仅存本地的合成样本保存现有默认效果和运行方式 | 改造后无法判断旧功能是否受损 | 可以对比改前、改后的内容与版式 | 五项 CLI 已生成并目视检查；Word/PPTX/Excel 已抽样复核；HTML Agent 因模型超时不可测 |
| **T1 设计规范** | 定义共享主题、颜色、字体角色和组件规则，接入读取器 | 同一种风格在各技能里各写各的 | 六套中文主题可选；默认主题在基线和批准完成后刷新 | 共享主题已接入六格式；字体包门禁通过；**默认主题已按 D1 刷新（PPTX/PDF/HTML → `clinical`，2026-11-10 批准）** |
| **T3 验收统一** | 扩展现有交付检查，记录要求是否满足、每页视觉检查结果 | 文件生成了，却不知道缺了什么、排版是否检查过 | 报告通过、待处理或未完成视觉检查的具体原因 | T3a/T3b 已完成（QA 协议 v1、旧报告适配器、六格式回归 34 项）；HTML/图示视觉仍为 `not_performed` |
| **T2 HTML 生成** | 保留自由生成，补充主题令牌、静态审计和图片文件夹交付 | HTML 结构和资源引用不稳定，带图页面难以完整交付 | 可交付单 HTML 或带 `index.html`、图片的文件夹 | T2.1–T2.6 已完成（六主题令牌、`audit`/`package`/`verify`、静态预算） |
| **T2c 视觉反馈** | 不做服务端浏览器；生成后静态检查 + 用户截图回传 | 无法自动发现真实排版问题，但不增加部署负担 | 交付后可直接打开；用户截图回传可继续优化 | 已决策：不部署浏览器 |
| **T4 主题与版式** | 分格式扩展版式组件、图表、图片、表格和排版能力 | 文件过于单调，只有换颜色没有设计感 | 同一主题下，各种格式都能产出更丰富、适用的内容 | T4 完成：能力矩阵、PDF、PPTX/XLSX、HTML/图示、目标平台复验 |
| **T5 回归样本** | 用仅存本地的合成材料固定质量测试 | 技能升级后不知道是否退步 | 脚本和人工视觉对照可以复查 | 未开始 |

**推荐顺序：** T0 静态基线 → T1a（主题契约和读取器）与 T3a（兼容式 QA 协议）可并行 → T1a0（字体/硬编码颜色，仅显式主题试验）→ T1b（先接 PPTX/DOCX）→ T2（HTML 自由生成 + 静态审计）→ T3b 与 T4（逐格式接入）→ T5 完整回归。T5 的最小样本从 T0 就要建立；T2c 是人工回路。默认观感切换必须等对应格式的旧基线、渲染对照和批准记录齐备；T3 不依赖 T1。

**本分支入口边界：** 当前 `feat/permission-arch-v2` 的文档生成仍调用技能 wrapper 的 `make`/`deliver` 等命令，`tests/skill-e2e/cases.json` 仍验证 Bash 调用。另一分支的 `pdf_make`、`docx_make`、`pptx_make`、`spreadsheets_make`、`diagram_make` 结构化入口不在本分支；本计划不把它们写成已实现，也不在 T0–T5 中暗中引入其调用契约。

### 0.1 主题决策记录（2026-11-06）

以下决定覆盖 v2.0 中“默认样式一律不变”“五套主题”的表述。令牌级细则见 `docs/design-theme-tokens.zh.md`。

| 编号 | 决定 | 影响 |
| --- | --- | --- |
| D1 | **允许刷新默认主题**（2026-11-10 已批准并执行） | 先完成旧基线、改版对照和批准，再让未指定主题的 PPTX / PDF / HTML 使用新版 `clinical`；旧色值保留为隐藏主题 `clinical-legacy` 供 A/B 与回退。PDF 的旧纯黑白走 `--design-theme none`。DOCX/XLSX/图示按 D4/D5 不刷新 |
| D2 | **合并“月白影像”与“临床晨光”** | 影像深色底板改为 `clinical` 的签名组件，按内容自动启用；最终为 **5 套展示主题 + 1 套灰阶**，共 6 套 |
| D3 | **字体预算获批** | PDF 新增衬线字体约 +24 MB；HTML 文件夹交付可携带 WOFF2 分片约 15–18 MB；单文件交付仍只用系统字体栈 |
| D4 | **DOCX 默认保持中性** | `neutral-document-v1` 不动；只有用户显式指定主题才走新增的 `themed-v1` 彩色策略 |
| D5 | **分档支持** | A 档（全量主题）：HTML、PDF、PPTX；B 档（仅令牌级）：DOCX、XLSX、diagram-maker。不承诺六种格式像素一致 |
| D6 | **HTML 不做服务端渲染** | 取消自动截图与独立 HTML 渲染服务；改为生成后静态预算 + 用户截图回传；内部记 `not_performed`，不向用户输出固定免责声明 |

**默认主题刷新不是“悄悄变样”**：改动时必须同时产出改版前后对照、记录批准人，并在变更说明中写明“默认观感升级”。

### 全局验收和降级规则

- **L1：可验证要求与结构。** 从用户这次的要求提取具体断言，例如必含标题、章节、页数范围、图片引用和有来源的数值。不同任务的断言不同，不强制用户填写固定表格；只有确实可自动验证的项才进入硬门槛。文件损坏、内容断言失败或明确的数值与来源冲突，不得声称完成，需修复或说明无法完成；不要用“视觉不可用”掩盖 L1 失败。
- **L2：视觉检查。** 对具备可靠渲染后端的格式，检查最终候选文件的每页/每工作表渲染结果；HTML 当前不部署服务端浏览器，不能把静态检查当作浏览器视觉验收。记录检查人、结论和文件及截图的哈希，抽样规则必须明示。**内部 QA 报告必须如实记录状态**（`approved` / `not_performed` / `failed`），不能把没看过的页面写成通过；**面向用户的默认文案不写固定免责声明**，只在以下情况说明：用户明确要求视觉验收、用户追问、或已发现具体问题。若截图已经看到严重遮挡、裁切或空白，不按“环境缺失”放行。
- **L3：内容溯源。** 保留关键数值、影像/检验结论对应的来源路径和可核对证据。可以核实且矛盾的内容必须修正；没有来源的内容不得被包装成已核实事实，标记“未提供/待核实”。不得擅自编造临床数据或图片。
- **缺图：** 无论用户是否明确要求图片，都允许“带缺项交付”一个有效文件；在页面中标记“图片未提供”，在 QA 报告及回复中列出具体缺失项及影响。用户明确要求的图片缺失属于未满足的要求，须按独立的“缺项交付”状态记录，不能把相应 L1 断言伪装成通过，也不能悄悄省略或声称原要求全部完成。
- **离线：** 运行时不从公网下载字体、依赖、模板或图片。Office 转换继续使用医院内网 HTTP Office Renderer；HTML 不依赖任何服务端浏览器（D6）。服务不可用时采用上述降级，不回退应用端 LibreOffice，也不在医院现场安装浏览器或缺失依赖。
- **兼容：** 默认生成路径、用户覆盖规则、已有 `make`/`deliver` 参数与报告消费方不得突然失效；新增功能以兼容扩展和可回退方式上线。测试旧工作流通过后才能将新门禁设为强制。

## 1. T0 —— 先留下现有功能的参照

### 工作

1. 用无个人信息的合成中文医学材料为六个技能各建至少一份仅存本地的固定输入；记录当前 CLI、默认主题/字号、文件名、页数或工作表数、可见内容、图片/图表和相关 QA 结果。不得使用真实会话中的患者文件；样本、预期输出、截图和测试生成产物都不进入 GitHub、Gitee 或离线部署包。
2. 建立**两类**对照：程序断言（文本、XML/OOXML 结构、颜色/字体、哈希、页数）和少量人工确认的渲染截图。PDF/PPTX/XLSX 的二进制产物可能含时间戳或顺序变化，不要求整文件字节一致。
3. 记录完整运行条件：运行时已安装情况、字体、Office Renderer 地址及版本、模型/服务版本、是否完成视觉验收。服务未就绪时，先保留纯静态基线并注明缺口，不声称视觉基线已完成。
4. 明确区分三类检查：**旧行为兼容**（`make`/`deliver`/文件结构必须始终通过）、**默认观感升级**（D1 只允许发生一次，需改版前后对照与批准记录）、**新能力**（显式主题与版式，在对应阶段实现后启用）。T0 记录的是改版前的参照，不得因后续刷新默认而删除。

### 验收

- 现有 `make` 和 `deliver` 的代表性路径分别记录，先确认是否能够跑通；用 `check` 命令核实对应技能运行时，必要时在构建环境预装，不在医院现场 `pip/npm install`。
- `git status` 不包含样本、截图、患者文件或当前工作区导出文件；通过忽略规则和打包检查核对本地测试材料不会被提交或带入离线包。样本说明在本地记录来源与许可。结果写入第 9 节。

- [x] T0.1 建立六技能的合成输入和预期内容清单（本地 `tests/skill-e2e/local-fixtures/t0/cases.json`；尚非 Agent E2E）
- [x] T0.2 记录已有默认样式、CLI、QA 路径与环境
- [ ] T0.3 核实渲染可用时的视觉基线，记录不可测项

## 2. T1 —— 共享主题与设计规范

### 目标与边界

建立 `skills/_shared/design-tokens.json` 作为**主题的单一真源**，提供六套中文命名主题的语义颜色、字体角色、组件规则、别名和自动推荐规则。颜色、字体、版式是三件不同的事：令牌只定义视觉意图与颜色，**不**把 PPT 的 pt/英寸、Word 的 pt、网页的 rem 强塞成同一个数值；各技能保留自己的尺寸表、字体 profile 和排版约束。

六套对外主题（5 展示 + 1 灰阶）：**临床晨光** `clinical`、**青黛循证** `academic`、**松风急救** `trauma`、**宣纸病案** `archive`、**杏林宣教** `edu`、**灰阶印刷** `mono`；另有 2 套不对外展示的回退色板 `clinical-legacy`、`vital-legacy`。中文名用于界面及交付说明，ASCII ID 用于内部键和已有 CLI；中文名、别名、ID 都应可解析。

**旧 ID 兼容：** 共享读取器把 `vital` 解析为 `clinical` 并提示视觉迁移；`vital-legacy` 与 `clinical-legacy` 保留旧观感供 A/B 与回退。PPTX wrapper 已接入共享读取器（T1b.1）。旧版 PPTX 四页基线存于本地忽略目录。用户指定优先；未指定时按 D1（2026-11-10 已批准执行）PPTX/PDF/HTML 使用新版 `clinical`，DOCX/XLSX/图示保持既有默认（D4/D5）。

令牌级规范以 `docs/design-theme-tokens.zh.md` 为准，包括逐主题色值、对比度实测、字体预算和验收用例。

### 现状与兼容契约

| 现有实现 | 必须保护的行为 |
| --- | --- |
| `pptx/assets/layout-library/design-tokens.json`：基础 `colors` + 主题增量覆盖，`toolkit.mjs` 合并 | `paper`/`surface` 必须为浅色、`primary` 必须为深色（`white` 历史上同时用作浅底和深底白字）。`clinical` 色值已按 D1 切换（2026-11-10），版面几何不变；旧值保留为 `clinical-legacy`。旧路径在迁移期可读，不维护两份人工修改的真源。 |
| `pptx` 中文 typography：`cross-platform-zh` 配置现为 `Arial`，但快捷 `make` 又显式覆盖为 `Noto Sans SC` | 两条路径必须分别核实：T0 快捷 `make` 的 `<a:latin>` / `<a:ea>` 实测均为 `Noto Sans SC`，不能说现有所有 PPTX 都用 Arial；构建器等未覆盖路径的 `cross-platform-zh` 仍需验证并修正，不能误改已正常的默认 `make`。 |
| `docx/scripts/docxlib/templates.py`：`neutral-document-v1` | 内置中性策略和预检对彩色样式的限制不变；**未指定主题不得上色**。彩色只走新增 `themed-v1`，且颜色必须来自当前主题令牌。 |
| `frontend-slides/references/med-visual.md`：A/B/C 是阅读密度和距离方案 | A/B/C 继续表示密度，与颜色主题正交；原“只允许一种高饱和强调色”改为“只允许 `primary`/`accent`/`support` 三个装饰角色，语义色固定”。 |
| `diagram-maker`：`clean`/`architecture` 还影响形状 | 保留它们作 `layoutVariant`，新增配色参数 `--design-theme`，不要把旧布局参数重命名为颜色。 |
| `spreadsheets`：`table.style.theme` 是 Excel 表格样式名 | 新增设计主题字段用 `designTheme`；已有原生表格样式和未指定时的输出不变；字体只请求名称，不承诺一致。 |
| `pdf`：ReportLab 固定颜色和内嵌字体 | 未指定主题时使用新版 `clinical`（D1，2026-11-10 已执行）；旧纯黑白用 `--design-theme none` 显式取回；`archive` 已新增衬线字体并验证嵌字。 |

### 实施

1. **T1a0：在 T1a 定义字体角色之后修字体确定性。** 先分别生成快捷 `make` 与构建器路径的 PPTX，核对 `<a:latin>` / `<a:ea>`；在显式主题的中文构建器路径，把仍继承 Arial 的 `headFontFace`/`bodyFontFace` 改为 `fontRoles.sans` 对应的真实中文字体，确保 PptxGenJS 写出的 `<a:ea>` 同步。加 XML 断言测试（显式新版主题禁止 `ea=Arial`），保护默认构建器、旧 `vital` 和快捷 `make` 的既有结果。`core.mjs` 的浅蓝灰以 `onDark`/`onDarkMuted`/`soft`/`rule` 作可选值，缺值继续用旧色。改动可能影响换行、分页或颜色观感，因此默认路径升级留给 T1b 的对照和批准流程。
2. **T1a：契约先行。** 新建 `skills/_shared/design-tokens.json`、schema、设计说明；共享文件只保存语义角色，不重复存旧 PPTX 键。T1b 的适配器把 `navy→primary`、`white→surface` 映射回旧布局接口，避免直接改动布局代码。主题增加 `typography` 乘数、`surface` 组件规则、`layoutVariant`。提供 Python 和 Node 读取器，路径定位兼容内置技能与用户覆盖技能。
3. **T1b：兼容接入。** 先接 PPTX，再接 DOCX。PPTX 在完成 T0 基线、改版前后对照和批准前，先通过显式主题或试验开关验证；批准后才按 D1 刷新默认输出。DOCX 默认输出保持中性。显式主题走各自可验证的分支。后续 PDF/HTML/XLSX/图示在 T2/T4 接入。不要在 T1 阶段宣称“六个生成器已经使用六套主题”。
4. **失败策略。** 共享文件缺失时运行端可用内置默认颜色维持生成能力，必须在结果标明 `builtin-fallback` 和原因；文件损坏或版本不兼容要明确报错。构建/离线包检查发现共享文件缺失必须失败，不能靠 fallback 掩盖漏包。
5. **加载路径。** 不假设每个技能根目录旁都有 `_shared`：用户复制覆盖内置技能时可能没有它。读取器优先定位应用包自带 `skills/_shared`，再按约定位置查找，找不到才降级；不从任意上级目录读取不受信任的同名文件。

### 验收

- `node skills/_shared/tokens.mjs --list` 与 `python3 skills/_shared/tokens.py --list` 对六套主题的中文名、ID、别名、颜色输出一致；纯读取器不加载 PPTX `sharp`/DOCX `python-docx` 等运行时。
- `node scripts/check-skill-tokens.mjs` 通过 `docs/design-theme-tokens.zh.md` 第 12.1 节的全部门禁：schema、别名唯一、对比度、灰度、语义锁定、完整性。缺失文件 fallback 在临时副本中测，**不删除工作区原文件**。
- 显式选择新版主题的 PPTX 构建器产物中 `<a:ea>` 不得为 `Arial`，中文字体与 `fontRoles.sans` 一致。自 2026-11-10 起该断言已扩展到**默认构建器**（不传 `--theme` 即 `clinical`）；旧 Arial 基线改由 `clinical-legacy` 与 `vital-legacy` 覆盖。
- 默认刷新有据可查：`clinical` 改版前后各一组样张、批准记录、以及用 `clinical-legacy` 复现旧观感的对照。
- 经过 wrapper 验证而非直接调用 CLI：`bash skills/pptx/scripts/pptx.sh themes`、`bash skills/docx/scripts/docx.sh capabilities`；必须先确认 `check` 返回运行时可用。在本地尚未备齐依赖时，将集成验收转到构建好的离线环境，不能把未运行写成通过。
- 旧主题 ID 与旧 CLI 参数保持可用；`vital` 解析为 `clinical` 时提示视觉变化及旧观感回退方式；中文别名与 ID 指向同一主题。

- [x] T1a0.1 显式主题构建器修正中文 `ea` 字体并加 XML 断言；默认路径待 T1b 刷新
- [x] T1a0.2 浅蓝灰改为主题令牌可选值，旧默认及 `vital` 使用原值
- [x] T1a.1 定义六套主题 schema、别名与设计意图（对齐令牌规范）
- [x] T1a.2 实现 Node/Python 读取器、定位策略与显式 fallback
- [x] T1a.3 数据门禁：对比度、灰度、别名、语义锁定、包完整性（HTML 侧经 T2 评估改用系统字体栈，不声明未交付字体；是否随包嵌字体留待 T4.5 目标平台复验后决定）
- [x] T1b.1 PPTX 接入六套主题（显式生效）；`clinical-legacy` 复现旧观感
- [x] T1b.2 DOCX 保留中性默认；实现显式主题的 `themed-v1` 策略
- [x] T1b.3 已具备运行时的环境下验证 CLI 与视觉基线
- [x] T1b.4 默认主题刷新（D1，2026-11-10 批准）：PPTX/PDF 不带主题参数即 `clinical`，HTML 由 SKILL 指令默认 `clinical`；PDF 旧黑白走 `--design-theme none`

## 3. T3 —— 统一验收语义，复用已有交付门

### 现状

DOCX 已有 `prepare` / `qa-init` / `qa-record` / `qa-finalize` / `deliver`；PPTX 的 `deliver` 已审计、渲染、核对哈希并封存；XLSX 的 `deliver` 已查结构、公式、需求覆盖与渲染空白页；PDF 有 `audit` 和 `render`，HTML 和图示的检查不足。`make` 等快捷命令不等于完整的最终 `deliver`；单改提示词无法保证每条产物都必经同一门。

### 实施

1. **T3a 协议与适配：** 在 `skills/_shared/qa/` 写版本化协议和 `acceptance` / `review` / `qa-report` 样例，编写各技能的报告适配器。通过向现有报告添加摘要或转换层实现统一，保留 DOCX 的旧记录、PPTX 的 `delivery.json`、XLSX 的报告和原有 CLI。不要用一个新通用脚本替换成熟的审计器。
2. **任务隔离：** 中间数据以 `$PILOTDECK_WORK_DIR/<skill>/qa/` 为默认位置（实际在 `<工作区>/scratch/work/<会话>/<轮次>/`）。PPTX、XLSX 现有以候选文件或 `--qa-dir` 定位的方式继续兼容；不能用所有轮次共用的 `scratch/qa/` 覆盖历史任务。独立 CLI 手动运行时允许显式 `--qa-dir`，并检查路径边界和用户覆盖规则。
3. **冻结实际用户要求：** 从用户话语和材料提取本次可验证的必含章节、页数/工作表、关键数字与图片清单；schema 只规定断言类型和记录方式，不让所有用户填写同一张表。未知事实标记待核实。每个断言记录来源和 `passed/failed/unverifiable`。
4. **视觉矩阵：** 记录最终产物哈希、渲染图哈希、页码、检查状态、问题及依据。最终产物变化则旧截图证据失效。可声明抽样规则，但不能把未看的页写成“已通过”。截图工具只负责产图，**视觉批准必须确实由人或具备图像能力的模型查看**，不能由脚本自动填 `approved`。
5. **主题与字体记录：** 报告中固定写入本次主题（ID + 中文名）、是否按用途推荐、字体角色与是否发生降级（如衬线缺失）。同一产物换了主题即视为不同基线，旧截图不得复用。
6. **逐格式接入：** PPTX/XLSX/DOCX 先适配现有门；PDF 再补交付流程；图示补可实现的几何检查；HTML 结合 T2 的静态检查。先以提示及报告引导调用，再对新工作流做阶段性强制；保留旧命令以免现有 `make` 直接交付的使用方式突然失败。
7. **状态：** L1 失败 → `failed`，修复后再交付；L1 通过但视觉未做 → `passed_with_warnings`，内部记为 `not_performed` 并附原因；缺图 → `delivered_with_missing_assets`（或等价独立字段）并列明用户要求未满足的项；视觉实际发现严重错误 → 先修复。内部报告必须准确；面向用户只在必要时说明，不输出统一模板句。

### 验收

- 正例：满足用户要求的合成文档，旧 `deliver` 能完成，新报告引用同一产物哈希。
- 反例：缺章节、关键数值与来源不符、产物在 QA 后变化，各自触发可解释的错误；旧版报告仍能被读取。
- 降级：Office Renderer 不可达时，结构有效的文件仍可交付；内部报告记 `not_performed` 并附原因，答复中不默认声明，用户要求过验收或追问时才说明；渲染成功但已确认遮挡不可放行。
- 冷启动或排队不可盲目把 Bash 超时提高为 120 秒：先核对工具层/网关/服务层的实际超时，再分步调用与限时重试，避免同步调用反复超时。

- [x] T3a.1 固定 QA 协议、状态机、逐页矩阵和兼容策略
- [x] T3a.2 适配 DOCX、PPTX、XLSX 既有报告，保持旧路径可用
- [x] T3b.1 PDF 交付审计及降级
- [x] T3b.2 HTML/图示审计与视觉状态（结合 T2/T2c）
- [x] T3b.3 正例、反例、降级、旧流程四类回归

## 4. T2 —— HTML 生成、静态审计与图片文件夹

### 目标与范围

当前 `frontend-slides` 由模型通过 `write_file` / `edit_file` 生成和修改 HTML，已有三种阅读密度预设、修改已有页面的规则与 PPT → HTML 的文字抽取。本任务**不把固定模板、统一内容 schema 或区块生成器设为默认路径**，保留模型根据内容自由组织页面的能力，避免为了通过模板而压缩内容或限制设计。

新增能力集中在三件事：共享主题令牌的接入、写盘后的静态审计、带图片页面的文件夹交付。`designTheme`（六套之一）负责颜色、字体角色和签名组件建议，`density`（A/B/C）继续负责阅读密度；两者不互相替代。未指定主题时默认 `clinical`（D1，2026-11-10 批准），只有内容用途明显更合适时才推荐其他主题并说明原因。

可以在真实样本中逐步沉淀可复用的 CSS 片段、图表和页面结构，但它们是可选的实现资产，不构成所有 HTML 必须遵守的固定区块集合。复杂图表仍只能依据用户提供或已核实的数据生成；没有数据时使用说明或空态。

### 实现与安全

- 可新增独立的 `html.sh audit` / `html_audit.py` 静态审计入口，但不新增必须经过的 HTML 生成器、固定内容 schema 或统一模板。文本默认转义；需要受控富文本时列白名单。内部内容和报告放 `$PILOTDECK_WORK_DIR/frontend-slides/`，最终成品放当前工作区 `exports/`。
- 静态检查覆盖：标题/章节、资源引用实际存在、相对路径边界、空态说明、`alt`/图注、基本可访问性、文件大小、潜在外链字体/脚本。不要仅凭正文含 `http://` 就判外部依赖；检查真正的 `src`/`href`/CSS URL，并限制 `file://`、目录穿越及脚本。`html.parser` 能做基础检查，不能冒充浏览器布局与完整语法验证。
- 用户显式点名的必含文字或章节，用 `--require-text` / `--require-heading` 变成可判定断言（匹配忽略空白与行内标签）；未命中即 `error`，不靠人工目测（T3b.2）。
- **生成后静态预算（不依赖浏览器，写盘后跑一次）：** 分两类，互不影响。
  - **事实类（必须准确）：** 资源存在且可解码、相对路径不越界、无 `http(s)` 外链、CSS 变量齐全、`id` 唯一、空章节、未闭合标签、文件大小、主题色对比度。
  - **估算类（仅告警，不阻断）：** 仅当页面显式使用约定的 `data-pd-block` 标记时，对可识别的 `section` / `table` / `callout` / `figure-grid` 区块按字符宽度模型估算高度、列宽压力和文本密度；自由布局或手写 HTML 直接跳过。阈值放宽（估算值超过 150% 才提示），避免把启发式结果误当成浏览器排版结论。
  - 估算类结果只进内部 QA 报告，**不写进用户可见文案，也不得阻断生成**；不为了通过检查而新增固定版式或限制设计自由度。
- **两种交付：** 无图或小图可用单 HTML；有医学图片默认 `exports/<页面短名>_<YYYYMMDD-HHmm>/index.html` + `assets/`。时间以部署配置的本地时区（院内默认 `Asia/Shanghai`）计，同分钟撞名加 `-2`、`-3`；新目录不覆盖；`--update` 仅在明确更新旧目录时启用，需核对该目录范围。复制被实际引用的图片，按哈希去重、清理文件名，禁止引用工作区外的图片。大图优先文件夹，不默认 base64。
- **缺图可交付：** 图片路径缺失时页面相应区域清楚写“图片未提供”，报告列出图片、原要求和影响；不得把缺图记为“全部通过”。资源文件存在但损坏、引用越界或图片复制失败，按实际故障与缺项分别处理。
- **可下载性：** 当前产物收集器扫描文件，不会将目录本身变成一个可下载文件卡；`index.html` 与各图可能分别显示。实施时核实 UI 能打开目录中的入口页及相对资源、能让用户一次下载整个文件夹；必要时增加 `.zip` 打包或目录下载入口，并把这项作为文件夹交付的硬验收。不能只检查磁盘上存在 `index.html` 就声称用户可完整取走。
- **确定性：** 固定输入、固定主题和固定资源内容，两次生成的 `index.html` 字节一致；时间戳只在外层目录名称，不写入页面正文或 CSS。`--update` 不得清理用户自行放进目录的文件。
- **主题落地：** 令牌以 CSS 变量注入 `<html data-pd-theme="…">`；页面可以按 `surface` 令牌选择页眉、章节标记、提示块和影像底板，但不强制所有页面使用相同结构。文件夹交付时允许 `assets/fonts/`；单文件交付只用系统字体栈。不得出现主题外第四种高饱和色。
- **字体落位：** HTML 统一使用 `--pd-font-*` 系统字体栈（含 Windows/macOS/Linux 常见中文字体），`assets/fonts/` 目录约定保留给确有需要时的本地字体；`fontRoles.*.htmlBundle` 保持为空，不在包内声明未交付字体。是否改为随包嵌 WOFF2，等 T4.5 在真实医院终端复验字体缺失情况后再决定。

### 验收

- 合成样例覆盖无图、带图、缺图、同分钟撞名、跨目录引用、HTML 特殊字符与窄屏；自动检查输出文件、链接、图片哈希和完整下载包。
- 六套主题各生成一份：CSS 变量与主题一致、无外部字体/脚本请求、`archive` 的字体角色正确。具备本地浏览器时可以做人工抽样，但截图不作为医院部署环境的自动门禁。
- HTML 生成与静态检查分别计时；记录页面生成、资源复制和审计耗时，不记录不存在的 HTML 渲染服务排队时间。端到端耗时只在指定模型/设备下作为参考，不设置与硬件无关的硬门槛。
- **HTML 不做服务端渲染**（见 T2c）：不装浏览器、不预留半成品接口。生成完成后执行上述静态预算，内部记 `visual_acceptance=not_performed`；不向用户输出免责声明，也不声称视觉审查通过。
- 静态预算不得改变页面内容与样式：同一份输入，开启与关闭估算类检查应产出字节一致的 HTML。

- [x] T2.1 主题令牌接入约定、静态审计规则和样例
- [x] T2.2 `audit`、文件夹/单文件输出与缺图说明
- [x] T2.3 入口预览、相对资源和整包下载验收
- [x] T2.4 更新 SKILL.md，保留旧流程和现有内容约束
- [x] T2.5 确定性、安全、视觉降级与分段耗时验收
- [x] T2.6 生成后静态预算：事实类与估算类分开，零副作用

## 5. T2c —— HTML 视觉反馈：不做服务端渲染（已决策）

### 决策

**不部署服务端浏览器，不做自动截图，不预留半成品接口。** 医院服务器为 Linux、且不由我们控制，预装 Chromium 意味着：

- 镜像增加约 250–400 MB（含系统库，需实测）；
- 容器要处理 `--no-sandbox`、`/dev/shm`、字体等额外依赖；
- 浏览器版本、可调用性、与既有依赖包的兼容性都无法在部署前确认；
- 收益只是一个**代理指标**——HTML 的最终读者本来就是用户自己的浏览器。

同样的取舍也适用于“复用现有 Office Renderer 加端点”的方案：仍需在渲染节点装浏览器，成本不变。因此整条路线不采用。

### 替代方案：静态预算 + 人工回路

1. **生成后静态预算（T2）：** 写盘后跑一次检查，事实类准确、估算类仅告警，结果只进内部报告。
2. **交付后自然引导：** 用一句正常的话邀请用户回看并回传截图，例如“生成好了，打开看看；哪里想调截图发我”。**不写“未完成视觉验收”这类固定免责声明**，避免让功能显得不可靠。
3. **截图回传闭环：** 用户发来截图后，Agent 读图 → 指出问题（溢出、遮挡、字号、配色、留白）→ 定位到具体区块 → 修改 → 生成新目录。旧目录不覆盖。
4. **不做追问：** 用户没有回传截图时不催促、不阻塞、不记为失败。

### 边界

- 静态预算**不得**改变设计自由度：不新增固定版式规则，不因估算超限而强制改写页面。
- 内部 QA 报告记 `visual_acceptance=not_performed`；面向用户默认不提。
- 用户明确要求“帮我检查排版”时，必须说明只能做结构检查、无法自动看渲染效果，并请其提供截图。
- 用户回传截图即视为 L2 输入的起点：此时视觉结论以截图为准，不再引用旧基线。

### 验收

- 无浏览器环境下完整生成并交付，不出现“缺少渲染服务”类报错。
- 静态预算关闭与开启，输出的 `index.html` 字节一致。
- 模拟用户回传截图：Agent 能定位到区块并给出可执行的修改，重新生成到新目录。
- 检查新增 HTML 交付路径不安装、不调用服务端浏览器，不新增浏览器端口或环境变量。仓库中已有的可选 `export-pdf.sh` 等历史脚本单独标记为非本任务路径，不得被 HTML 默认流程调用；是否删除它们另行评审。

## 6. T4 —— 共享主题、格式专用版式与丰富内容

### 用户体验

用户可选中文主题；未指定时 PPTX/PDF/HTML 使用新版 `clinical`（D1，2026-11-10 已批准执行），DOCX/XLSX/图示保持既有默认（D4/D5）。生成结果写明“本次使用主题：青黛循证（academic）”，推断得来时追加“（按用途推荐）”；默认路径要注明用的是 `clinical`。六套主题共享语义色与气质，**不是**六份产物强行套一样的字重、边距、结构。

三条轴分别处理：`designTheme`（配色与字体角色）、`layoutVariant`（组件和页面组织方式）、`density`/字体 profile（阅读距离、密度、目标平台）。`diagram-maker` 保留 `clean/architecture` 为布局参数，新增 `--design-theme` 作配色；Excel 的 `table.style.theme` 继续表示原生表格样式。DOCX 的中性 `builtin` 保留，显式彩色主题走新增 `themed-v1` 与预检规则。PDF 嵌入随包字体（无衬线 + `archive` 衬线）；Word/PPTX 指定字体名称须在目标 Office Renderer 上核验，不承诺 OOXML 嵌字；HTML 文件夹交付可带 WOFF2，单文件交付只用系统字体栈；XLSX 不承诺文件内嵌字体。

**分档不做平均用力：**

- **A 档（全量主题：颜色 + 字体角色 + 组件 + 签名版式）**：HTML、PDF、PPTX。
- **B 档（仅令牌级：颜色 + 字体角色，不做签名版式）**：DOCX、XLSX、diagram-maker。

六种格式允许“同一主题家族、各自适配”，**不允许**把像素一致写成验收标准。

### 分格式增量工作

| 技能 | 档位 | 先补什么 | 必须验证 |
| --- | --- | --- | --- |
| HTML | A | 六个主题的令牌块与签名组件（标线、通栏页眉、时间轴、印章、圆角卡、影像底板）；文件夹交付带字体 | 窄屏、长文本、离线资源、对比度、灰度 |
| PDF | A | 主题化报告；`archive` 衬线；目录/图注/表格版式 | 嵌字、分页、跨页表格、提取文本不丢失 |
| PPTX | A | 六个主题；病例、对比、证据、时间线、影像页；真实数据图表 | 文字不溢出、主结论醒目、`ea` 字体、目标 Renderer 差异 |
| DOCX | B | 显式主题的 `themed-v1`：标题/表头/提示块着色 | 默认仍黑白、彩色仅限主题令牌、Word 预检与医院字体 |
| XLSX | B | 表头/分组/数值格式/条件格式/原生图表配色 | 公式值、图表源范围、打印分页、原生表格样式兼容 |
| diagram-maker | B | 配色令牌化、`--design-theme` 与 `clean/architecture` 解耦 | 旧输入仍生成旧结构、长标签不遮挡、连线标签无白边、SVG 无外部资源 |

**功能目标优先于主题数量。** 图表只能依据输入数据产生；没有数据时提供说明或空态。每一格式先做一个真实场景的布局，再扩充其余场景；用户自带医院模板的优先级高于系统主题。每种新组件增加结构断言、目标软件/浏览器的视觉对照和用户指定主题的验收。

- [x] T4.1 六格式能力矩阵与已有默认回归（`docs/format-capability-matrix.zh.md` + `tests/skills/format-capability.test.mjs`）
- [x] T4.2 DOCX/PDF 版式和主题适配（PDF 六主题 + 衬线 + 管道表格 + 目录；DOCX `themed-v1` 已在 T1b.3 完成）
- [x] T4.3 PPTX/XLSX 图表和复杂页面样本（Markdown 表格页、主题化图表、case/evidence/imaging 版式、XLSX 六主题）
- [x] T4.4 HTML/图示布局与六套中文主题映射（HTML 签名组件 + 图示 `--design-theme` 与 `clean/architecture` 解耦）
- [x] T4.5 目标平台字体、溢出、跨页和图片场景复验（字体替换实测 + `scripts/platform-preflight.mjs` + `docs/target-platform.zh.md`）

## 7. T5 —— 安全、真实且可重复的回归集

现有 `tests/skill-e2e/cases.json` 有 11 个用例，偏向“是否调用工具、是否有文件”。新增每技能至少三个合成场景（最小/常规/边界），覆盖内容断言、缺图、超长文本、中文字体、表格、图表和离线降级；脚本级、实际 Agent 端到端、截图人工/多模态复核分层运行，不把模型生成误记为完全确定性。

**素材约束：** 所有**新增**回归材料（合成输入、图片、预期输出、截图及测试生成文件）仅留在本机 `tests/skill-e2e/local-fixtures/`，**不提交 GitHub/Gitee、不进入离线部署包**。测试脚本、无样本内容的断言逻辑及说明文档可随正常代码维护；对本地材料配置忽略规则与构建排除规则，提交/打包前核对。本分支原有 `tests/skill-e2e/fixtures/` 三个文件仍被 Git 跟踪且旧用例仍引用；本任务不擅自删除或改动它们。既有 Git 历史中的素材即使后续移除也不会自动消失；隐私/授权与历史清理需另行评估。测试 runner 在本地素材缺失时应显示跳过/不可测，不能冒充通过。

**已知风险（2026-11-10 登记，暂不处理）：** `tests/skill-e2e/fixtures/medical-batch/ultrasound.dcm` 是**真实患者 DICOM**，含未脱敏的 `PatientName`、`PatientID`、`PatientBirthDate`、`AccessionNumber` 与医院名，且该文件已被 Git 跟踪（`git ls-files` 可见），已随分支历史存在。
按用户 2026-11-10 决定：**本轮不删除、不改动该文件，只在计划书登记为已知风险**。后续需另行评估三条路径——改写 Git 历史、收紧仓库访问权限、或做结构性脱敏替换（保留 DICOM 标签与像素，仅替换姓名/ID/生日/检查号）。
同目录 `admission-note.xml` 的姓名字段已脱敏为 `***`；`wse_0820_00_injury.jpg` 的 EXIF 自述为特效化妆库存图，但来源与许可未登记，属 T5.1 待补项。

- [x] T5.1 六技能合成材料与来源/许可登记
  - 进展（2026-11-10）：PPTX/DOCX/XLSX/PDF 的样张内容改为直接写在
    `tests/skills/theme-sample-matrix.test.mjs` 里（自撰合成病例，无第三方素材，
    无图片、无许可问题），不需要额外的素材目录。
  - 进展（2026-11-10）：`theme-sample-matrix` 补上 `html`（自带含 viewport 的页面 +
    `html.sh audit`）与 `diagram`（`diagram.sh make`）两个 wrapper，六种格式全部纳入。
  - 进展（2026-11-10）：新增 `tests/skill-e2e/fixtures/PROVENANCE.md` 作为来源与许可登记表——
    逐份登记现有三个公开素材的来源/许可/隐私状态与决定，并登记测试内自撰合成素材的所在文件。
    `wse_0820_00_injury.jpg` 的来源与许可仍标为待补，属人工登记项，不影响本轮勾选。
- [x] T5.2 本地素材隔离和打包自检；公开素材隐私检查
  - 进展（2026-11-10）：新增 `scripts/check-test-assets.mjs`（`npm run check:test-assets`）：
    ①`git ls-files` 不得包含 `tests/skill-e2e/local-fixtures/`；②`.gitignore` 与 `.dockerignore`
    都必须排除该目录，且用 `git check-ignore` 实测生效；③离线包 staging 步骤不得把 `tests/` 复制进交付包；
    ④跟踪的公开素材只作为**告警**列出（隐私复核是已登记的人工项，不允许把构建卡死）。
    新增 `tests/skills/check-test-assets.test.mjs` 5 条：真实仓库通过 + 在临时 git 仓库里分别复现
    「素材被提交」「缺少忽略规则」「打包把 tests/ 带进交付包」三种失败。
    另在 `scripts/package-offline-arm64.sh` 的 buildx 之前调用该脚本（有 node 时），打包本身就会先拦。
  - 未做：公开素材的 PHI 机器扫描（会与本轮"暂不处理 DICOM"的决定冲突），
    仍以 `PROVENANCE.md` 人工登记为准。
- [x] T5.3 脚本级结构、主题、缺项、内容溯源回归
  - 进展（2026-11-10）：新增 `tests/skills/theme-sample-matrix.test.mjs`，
    六套主题 × 四种格式（24 组）逐组构建并断言主题真的落地（PPTX `theme`/`themeLabel`、
    DOCX 标题主色、XLSX/PDF `theme.id`），另断言 `archive` 在 PDF 里嵌入衬线体。
  - 进展（2026-11-10）：矩阵扩到**六种格式**（48 组），HTML 断言 `theme.id`/`mismatched` 为空/
    `counts.errors=0`，图示断言 `designTheme.id/label` 且无 warning。
  - 进展（2026-11-10）：新增 `tests/skills/regression-missing-assets.test.mjs`（5 条）把"缺项"行为钉住：
    DOCX 缺图 → 非零退出 + `code=image-not-found`（错误 JSON 走 stderr）；PDF 缺图 → 载荷 `status=error`
    且 `error` 含 `image not found`（**该命令退出码仍为 0，不能拿退出码断言**）；PPTX imaging 无 `image`
    字段 → 成功并画 `Imaging Placeholder` + `影像未提供`；PPTX imaging 有 `path` 但文件不存在 → 非零退出 +
    `ENOENT`；HTML 审计缺图 → `status=error`、`counts.missing=1`、`issues` 含 `missing-resource`。
  - 内容溯源已由既有 `qa-regression.test.mjs`（六格式正例/反例/降级/旧流程）与 `format-capability.test.mjs`
    （XLSX 图表缺 `sourceRanges`/`minPoints` 必须失败）覆盖，本轮未重复造轮子，只做了复核。
- [ ] T5.4 Agent 端到端回归与视觉矩阵，记录可测比例和通过率
  - 进展（2026-11-10）：`scripts/run-skill-e2e.ts` 新增 `--probe`（只探测不跑用例）与
    「不可测」退出码 `78`：原先网关不可达只是 `exit 1` 报错，无法与"用例失败"区分；
    现在会输出机读 JSON（网关/模型端点/六套运行时/素材/用例分布/可测比例/阻塞项）并明确打印
    `UNTESTABLE`。网关地址改为按 `PILOTDECK_GATEWAY_URL` → `PILOTDECK_GATEWAY_PORT` →
    `scripts/config.env` → 18789 的顺序解析，避免新 shell 探测到旧默认端口。
  - 进展（2026-11-10）实测：`--probe` → `untestable`，11 个用例**可测 0 个**
    （`gateway not reachable at http://127.0.0.1:18800 (token=missing)`；
    `qwen=http://10.31.112.47:18001/v1` 处于 `listening-but-silent`——TCP 可连、HTTP 无响应；
    备份 `qwen-backup=http://10.31.112.13:8040/v1` 完全不可达）；六套运行时与三个 fixture 均就绪。
    `npm run test:skills` 因此退出 78，未产生任何伪造的 PASS 或 FAIL。
  - 未做：真实 Agent 会话与视觉矩阵。待模型端点恢复响应并启动本地栈
    （`bash scripts/start-local.sh`）后重跑 `npm run test:skills`，届时才有通过率可记。

## 8. 跨任务的落地检查

1. **完整运行链路：** 技能 `check`、内置默认输出、已有 `make`/`deliver`、多用户工作目录隔离、Office Renderer 降级、UI 文件卡和下载路径都应纳入回归。尤其不能把“脚本返回成功”等同于“用户能看到并完整取走文件”。
2. **构建包：** `skills/_shared`、字体和新脚本随离线包安装；字体包含 PDF 的无衬线/衬线 TTF 与 HTML 的 WOFF2 分片（预计 +24 MB 与 +15–18 MB，见令牌规范 6.2）。所有测试材料（包括新增合成样本）不在 Docker 上下文和交付目录。（2026-11-10 实测：新增合成样本以代码形式存在，不进任何目录；本地素材已被两处 ignore 排除；既有三份公开素材仍在 Docker **构建上下文**内，但 staging 只复制脚本/技能/插件等目录，交付包内没有测试材料 —— 这一区分由 `scripts/check-test-assets.mjs` 守住。）构建前用本地样本运行 `check-skill-tokens` 和最小离线回归，包内只检查必要的运行脚本及依赖；现场不自动安装浏览器/字体/依赖，也不依赖本地测试样本。
3. **防止假阳性：** `SKIP/UNTESTABLE` 与 `PASS` 分开统计；没有截图则 L2 为 `not_performed`；缺图则写缺项；没有可核对来源则不宣称已溯源。
4. **逐步启用：** 先纯脚本测试，再在隔离工作区跑完整技能，最后验证院内目标平台；不能凭 Node/Python 单元测试推断中文排版和视觉效果无误。

## 9. 执行日志

> 只有真正完成子任务并记录验收结果后，才更新状态；不要删历史行。

| 日期 | 任务号 | 实际修改 | 验收命令及结果 | 未完成/风险 |
| --- | --- | --- | --- | --- |
| 2026-11-04 | — | 建立 v1.2 任务书 | 未进行编码验收 | 多处现状与代码不符 |
| 2026-11-05 | 计划修订 | 结合当前仓库修订为 v2.0；未修改技能实现 | 任务书结构与现有路径静态核对 | T0–T5 均未开始编码 |
| 2026-11-06 | 计划修订 | 修订为 v2.1：确认 6 套主题与默认刷新；新增令牌规范文档 | 仅静态核对色值、对比度与代码位置，未改技能实现 | 令牌规范中的字体/渲染结论待实现时实测 |
| 2026-11-06 | 计划修订 | 修订为 v2.3：移除 HTML 固定模板/内容 schema 优先路径；明确 HTML 只做静态审计和用户截图回传；默认主题须在基线与批准后切换；补充历史浏览器脚本不属于默认交付路径 | `git diff --check` 通过；任务书与主题规范静态交叉核对 | T0–T5 均未开始编码；HTML 视觉验收仍依赖用户截图或本地人工检查 |
| 2026-11-09 | T0.1、本分支计划对齐 | 从另一分支移入 v2.3 决策与主题规范，移除不属于本分支的结构化工具完成记录；建立六技能本地合成输入、静态基线和隔离规则；图示生成一份旧版 SVG | 六输入 JSON 校验通过；`diagram.sh check` / `make` / `self-test` 成功（3 节点、2 连线）；再次生成字节一致，SVG XML 和中文节点校验通过；Git 忽略检查及 `git diff --check` 通过 | 当时仅在未加载项目启动环境的交互式 shell 中观察到四项依赖未就绪及 Renderer URL 为空；不能据此判断应用环境不可用。T0.2/T0.3 待进一步实测；旧版三份 fixture 仍在 Git 索引中 |
| 2026-11-09 | T0.2、T0.3 部分实测 | 按 `scripts/start-local.sh` 的环境加载 `scripts/config.env` 和项目缓存；在本地忽略目录生成 DOCX/PPTX/XLSX/PDF 样张及预览，查看图示 SVG 原比例 PNG；分别用实际用户要求和产物实际结构运行 PPTX/XLSX `deliver`；纠正 T1a0 字体路径描述。未改技能生成代码 | 五项 `check` 通过，Renderer `/health` HTTP 200；DOCX/PPTX/XLSX/PDF `make` 成功；DOCX/PDF 各 1 页、PPTX 4 页、XLSX 1 表 1 页；PPTX/XLSX 用户条件 `deliver` 拒绝（3 页期望 vs 4 页；`观察记录` vs `Sheet1`），实际结构条件 `deliver` 通过；预览 PNG 已逐张查看；哈希、CLI、QA 路径见本地 `tests/skill-e2e/local-fixtures/t0/baseline.md` | Renderer `/health` 不报告版本；XLSX `37.0` 显示为 `37`；DOCX 有二级标题起始警告。HTML 无确定性 `make` 命令，真实 Agent 样本尚未跑；未在 Microsoft Office 等目标软件复核，T0.3 和默认观感刷新批准仍未完成 |
| 2026-11-09 | T0.3 续测 | 在本地隔离的 Agent 网关用合成材料尝试 HTML 生成（默认和显式主模型各一次）；在 macOS Microsoft Word、PowerPoint、Excel 中打开对应冻结样张并查看 Word 1 页、PPTX 4 页、XLSX 1 表。未改技能生成代码 | 两次 HTML 尝试均在模型连接 30 秒超时后结束，零工具调用、零 HTML 文件，记 `UNTESTABLE` 而非通过；Word/PowerPoint/Excel 均可打开，抽样画面未见明显裁切；本地基线记下逐页观察，原样张哈希不变 | PPTX 仍为 4 页而非要求的 3 页；XLSX 页签仍是 `Sheet1`、`37.0` 显示为 `37`；HTML 真实视觉基线仍缺，T0.3 暂不勾选、默认观感刷新仍待对照与批准 |
| 2026-11-09 | T1a.1/T1a.2，T1a.3 部分 | 增加共享主题 JSON/schema、Node/Python 纯读取器、数据门禁及跨语言测试；另用本地合成 Markdown 保存旧 `vital` 四页配色对照。未改 PPTX/DOCX/PDF/HTML/XLSX/图示生成路径或默认主题 | `node scripts/check-skill-tokens.mjs` 通过（8 色板，0 错误/告警）；`node --test tests/skills/theme-tokens.test.mjs` 3/3 通过；Node/Python 六主题名称、别名、色值一致，缺文件/损坏文件/版本错误、别名与对比度回归均有测试；旧 `vital` 样张 4 页，审计零错误/告警，哈希见本地基线；T1a 后默认 PPTX 仍为 4 页，四张幻灯片 XML 均与旧基线一致 | `--check-package` 预期失败：缺少 `NotoSerifSC-VF.ttf` 和声明的 HTML 字体文件；T1a.3 包完整性未通过。旧技能仍使用旧主题文件；`vital` 映射仅在新读取器生效。T0.3 HTML 基线与默认观感刷新批准仍未完成 |
| 2026-11-09 | T1a0.1/T1a0.2（显式主题试验） | 构建器显式中文主题读取共享无衬线字体及深底/浅底语义色；布局仅在令牌存在时替换浅蓝灰，默认与 `vital` 保留旧值；补充 XML 与缺失共享模块回退测试、字体说明 | `node --test tests/skills/pptx-fonts.test.mjs tests/skills/theme-tokens.test.mjs` 5/5；构建器旧默认 4/4 幻灯片 XML 与改前逐张一致；显式 `academic` 中文样张远程 Renderer 4/4 页成功且已目视检查；审计 0 错误、1 个测试样本故意设置的重复单位告警；`git diff --check` 通过 | 封面副标题末字单独成行在改前旧样张也存在，留待版式任务；尚未验证目标 PowerPoint 的字体替换；仅旧主题中的显式项参与试验，六主题接入/默认刷新/T1a.3 均未完成 |
| 2026-11-09 | T1b.1 PPTX 六主题接入 | 新增 `lib/themes.mjs` 连接共享读取器：`make`/`build`/`themes` 支持六套主题的 ID、中文名与别名；语义色映射回旧布局键，显式主题应用字体角色与字号/行距乘数；隐藏旧色板 `clinical-legacy`/`vital-legacy` 不注入深底色，保持旧硬编码效果；返回 `themeLabel`/`themeWarning` | `node --test tests/skills/*.test.mjs` 8/8；`clinical-legacy` 与未指定主题产物逐页 XML 完全一致，默认 `make` 仍与 T0 冻结基线 4/4 页一致；`青黛循证`/`学术`/`academic` 三者一致；`archive` 写入 `Noto Serif CJK SC`；六主题构建器样张远程 Renderer 各 4/4 页成功并逐张查看；`themes` 列出 6 套公开主题且隐藏项不出现；`pptx.sh self-test` 顶层通过（交付、改稿、旧 PPT 转换、损坏文件拒绝均符合预期） | 未指定主题仍为旧观感，默认刷新需对照与批准；`vital` 迁移会改变旧用户显式配色（有 warning 与 `vital-legacy` 回退）；图表系列色、签名版式属 T4；目标 PowerPoint 字体替换未验证；字体包门禁仍缺 5 个文件 |
| 2026-11-09 | T1a.3 包完整性 | 补入 `NotoSerifSC-Regular.ttf`（上游 VF 用 fontTools 实例化 `wght=400`；VF 默认实例为 ExtraLight，ReportLab 无法选字重）；`fontRoles.*.htmlBundle` 置空，声明“清单只写已交付资源”，HTML 分片由 T2.1 定义后回填；更新 `SOURCE.txt`、字体预算和待实测结论 | `node scripts/check-skill-tokens.mjs --check-package` 通过（8 色板，0 错误）；`node --test tests/skills/*.test.mjs` 8/8；ReportLab 注册 14.9 MB 衬线字体 0.02 s，样张嵌字子集 19 KB、`pdftotext` 提取正确、正值渲染色重正常；PDF `make` 回归 1 页通过 | HTML 字体分片尚未交付；未在 Word/医院环境复验；新增字体使离线包 +14.9 MB，需随包提交；20 页长 PDF 的体积与分页未测 |
| 2026-11-09 | T1b.2/T1b.3 DOCX `themed-v1` | 新增 `docxlib/design_theme.py`，从共享令牌解析主题；`style_policy` 支持 `themed-v1 + theme`，主题名在规范化时收敛为 ID；`make` 与 `prepare` 增加 `--design-theme`；标题/各级标题=`primary`、正文=`ink`、表头=`primary`+`onPrimary`、边框=`rule`、提示块=`soft`+`accent`；中性模板继续拒绝主题，user 模式也拒绝主题；`preflight` 的中性专属彩色门禁只作用于 `neutral-document-v1` | `docx.sh self-test` 全步骤通过；`node --test tests/skills/*.test.mjs` 12/12；六套主题的 ID/中文名/别名生成的 DOCX 文本色仅为 `primary`/`onPrimary`，正文 `ink` 写入 Normal 样式，未知主题/中性加主题/缺主题/user 加主题均按预期报错；`prepare --design-theme 青黛循证` 冻结为 `academic` 且 `create` 通过一致性校验；远程 Renderer 六主题各 1 页成功并目视检查表头、提示块与标题对比度；中性默认仍为黑白 | DOCX 只做令牌级配色：`archive` 的衬线角色未在 DOCX 启用（沿用 `Noto Sans SC`，与现行基线一致，是否切衬线需单独评审）；主题只影响标题/正文/表头/提示块，不改变版式几何；未在目标 Word/WPS 复验；`make` 快捷路径成功不代表完成交付门，仍需按 T3 走 preflight/deliver |
| 2026-11-09 | T2.1 HTML 主题令牌与静态审计 | 新增 `_shared/theme-css.mjs` 生成 `frontend-slides/assets/themes/pd-themes.css`（六主题、16 颜色令牌、4 组语义浅底、3 字体角色、A/B/C 桥接）；`build-theme-css.mjs` 支持 `--check`；`check-skill-tokens --check-package` 增加逐字节一致性检查；新增 `html_audit.py`（stdlib、无浏览器）：外链资源/脚本/字体、`file://`、绝对路径、目录穿越、缺资源、重复 `id`、未闭合标签、主题令牌缺失/漂移、空 `alt`、空 section、标题/lang/charset/体积；新增 `references/themes.md` 与 SKILL.md 主题流程；合成样例覆盖正常、外链、结构错误、未知主题、令牌漂移、越界引用 | `node --test tests/skills/html-audit.test.mjs` 8/8；六主题样例均 `status=ok` 且 `theme.scope=selector`；`build-theme-css --check` 与 `check-skill-tokens --check-package` 通过（0 错误 0 告警）；`archive` 标题/正文为衬线栈；审计输出对同一文件两次运行完全一致；坏样例分别报出预期错误码 | 仅事实类检查，不做浏览器渲染与截图，`visual_acceptance=not_performed`；HTML WOFF2 分片与 `htmlBundle` 未交付，随 T2.2/T2.3 文件夹交付补齐；审计依赖共享令牌文件，缺失时降级为 `theme-tokens-unavailable` 告警；未改变既有 A/B/C 密度与自由布局规则 |
| 2026-11-09 | T2.2 `html.sh` 与文件夹交付 | 新增 `html.sh`（`check`/`audit`/`package`，无第三方依赖）；`html_package.py` 复制页面实际引用的文件、按 SHA-256 去重并改为 `assets/<stem>-<hash8>.<ext>`、改写 `src`/`href`/`url()`；默认输出 `exports/<页面短名>_<YYYYMMDD-HHmm>/`（院内默认 `Asia/Shanghai`），同分钟撞名加 `-2/-3`；`--update` 仅替换 `index.html` 与新增资源，不删除用户文件；缺图写成「图片未提供（原文件：…）」并返回 `delivered_with_missing_assets`；外链、`file://`、绝对路径、目录穿越、非图片缺资源直接阻止 | `node --test tests/skills/html-package.test.mjs` 7/7；打包后 `html.sh audit` 为 `ok`；两次打包 `index.html` 字节一致且第二次目录带 `-2`；缺图样例生成占位文本且审计通过；外链/越界引用被阻止；`--update` 保留用户自建 `notes.txt`；工作区外输出目录被拒绝 | 未做整包下载/入口预览（T2.3）；`--update` 不清理旧版本遗留的资源文件（有意保守，避免误删）；资源可解码性仅做文件头签名检查，不做完整解码；打包只复制资源，不复制页面互链的其他 HTML；未在 Windows 路径环境验证 |
| 2026-11-09 | T2.3 整包下载与交付验收 | `package` 默认生成同名确定性 zip（条目排序、固定 1980 时间戳、固定权限），`--no-zip` 可关；新增 `html.sh verify <dir>`：入口页存在、静态审计、zip CRC、zip 与磁盘逐文件哈希一致；审计新增 `<base>` 拒绝（破坏相对路径）；用真实 `FileArtifactCollector` + tsx 验证产物收集器把 `index.html`（`text/html`）、`assets/*.png`（`image/png`）、`.zip`（`application/zip`）分别登记为可下载文件卡，目录本身不成为卡片 | `node --test tests/skills/html-package.test.mjs` 10/10、`html-audit.test.mjs` 9/9；同一输入两次打包 `zip_sha256` 与文件字节完全一致；`verify` 对正常包返回 `ok`（2 个条目）；删掉资源后报 `missing-resource`；篡改资源后报 `zip-entry-mismatch`；`--no-zip` 时 `verify` 返回 `warning/zip-missing`；收集器实测输出 zip 的 MIME 为 `application/zip` | 未在本机启动完整 Web UI 验证点击预览的渲染效果（宿主实现不在本仓库）；文件夹内每个资源仍会各自成为文件卡，靠 zip 提供“一次拿走”；zip 未做加密与压缩率优化；未在 Windows 解压验证中文文件名；HTML 不内嵌字体，仍用系统字体栈 |
| 2026-11-09 | T2.4 SKILL.md 收口 | 明确“没有 HTML 生成器”，脚本只承担审计/打包；保留 Phase 0–4、三档密度、自由布局、内容与图源约束；补充主题四步、交付形态、缺图话术、`verify` 与自然引导，不引入固定模板或强制区块 | 与 T2.1–T2.3 的脚本入口逐条对照，命令与参数一致；旧流程（单文件、预览、PPT→HTML）未被删除；`node --test tests/skills/*.test.mjs` 32/32 | 文档描述无法自动测试；旧 `STYLE_PRESETS.md`、`export-pdf.sh` 仍保留但继续标记为非默认路径；未做真实 Agent 端到端生成验证（T5） |
| 2026-11-09 | T2.5 安全、降级与耗时 | 审计新增：`javascript:` URL、可执行 `data:`（`text/html`、`image/svg+xml`、JS）、外网 `meta refresh` 判错；内联 `on*`、外网表单 `action`、缺 viewport 判警告；`data:image/png|jpeg|gif|webp|avif|bmp` 与 `data:font/*` 允许；打包同样拒绝 `javascript:` 与不安全 `data:`；审计/打包/验收输出分段 `timing_ms`；三处结果固定 `visual_acceptance=not_performed`，不依赖任何浏览器 | `node --test tests/skills/*.test.mjs` 34/34；`unsafe.html` 报出 `javascript-url`、`unsafe-data-url`、`external-redirect`、`inline-event-handler`、`external-form-action`、`missing-viewport`；特殊字符与 emoji 样例审计 `ok`；审计报告除 `timing_ms` 外两次运行完全一致；打包产物 `timing_ms` 含 scan/collect/copy/write/zip/total；`verify` 含 `visual_acceptance=not_performed` | 页面生成耗时由 Agent 侧决定，脚本只记录审计/复制/打包；`on*` 与 `fetch` 只告警不阻断（避免误伤合法交互）；未做 CSP 注入；`data:` 白名单按 MIME 前缀判断，不解析载荷内容；未启动 Web UI 验证预览 |
| 2026-11-09 | T2.6 静态预算（估算类） | 仅对显式 `data-pd-block` 的 section/table/callout/figure-grid 做字符宽度模型：高度 >1350px、表宽 >1440px、图组宽 >1440px 各出警告；`data-pd-columns` 控制图组列数；`--no-estimate` 可关；估算只进内部报告，不阻断交付，不写入页面 | `node --test tests/skills/*.test.mjs` 35/35；长区块/20 列表格/8 列图组分别报 `estimate-tall-block`、`estimate-wide-table`、`estimate-figure-overflow`；`--no-estimate` 后无估算告警且状态 `ok`；两次运行前后 HTML 字节完全一致；未标记页面零估算输出 | 模型是启发式，只能提示不能代表浏览器布局；未做字体度量、换行与缩放计算；阈值固定，未按主题字号调整；不检查横向溢出在真实窗口中的表现 |
| 2026-11-09 | T3a.1 QA 协议 v1 | 新增 `skills/_shared/qa/`：acceptance / review / report 三个 schema（`pilotdeck-qa/*-v1`）、README 状态机、Python 校验与构建器 `qa_protocol.py`、三份样例；硬规则：评审绑定产物 SHA-256、页码 1..N 连续唯一、任一页未评审只能 `passed_with_warnings`、视觉失败或结构失败即 `failed`、缺资源单列 `delivered_with_missing_assets`；对旧 DOCX/PPTX/XLSX 报告只做映射、不替换 | `node --test tests/skills/qa-protocol.test.mjs` 8/8；全量评审 → `passed`；含 `not_performed` → `passed_with_warnings`；页面失败/结构失败 → `failed`；哈希不一致 → `review-artifact-mismatch`；缺页 → `review-incomplete`；重复页 → `review-duplicate-page`；缺资源 → `delivered_with_missing_assets`；伪造 `passed` 报告被 `report-status-conflict` 拒绝；固定时间戳两次构建完全一致；样例 acceptance/report 通过校验 | 协议只定义记录与判定，不生成截图；没有评审时 `visual=not_performed`；未接入真实 DOCX/PPTX/XLSX 报告（T3a.2）；`generatedAt` 由调用方固定才能复现；未与 Web UI 展示打通 |
| 2026-11-09 | T3a.2 旧报告适配器 | 新增 `skills/_shared/qa/adapters/`（`adapt.py` + `common.py` + 三个映射器）：只读旧报告，输出统一 `qa-report.json`，旧命令、旧报告字段与落盘位置不变；未给 `--acceptance` 时把旧门**已经执行过**的要求回读为 `acceptance.derived.json`（`derivedFrom.report` 记来源）；DOCX 把覆盖类错误归 `content`、包与审计错误归 `structural`，图片少于要求归 `delivered_with_missing_assets` 而非失败；PPTX 把 `coverage_required` 归 `content`，完整性、交付门、审计 error、渲染失败归 `structural`，`visual` 恒为 `not_performed`；XLSX 把 `requirement_not_met` 归 `content`，公式/包结构失败与空白打印页归 `structural`；三者都比对报告内的产物 SHA-256（不一致 → `artifact-changed-since-*`）；有 `--review` 时由页矩阵决定 `visual`，但旧 `failed` 不被新评审升级；删除两份与 schema 不符的历史样例 | `node --test tests/skills/qa-adapters.test.mjs` 12/12（用真实 `docx make` + `preflight`、`pptx make` + `deliver`、`spreadsheet make` + `deliver`/`audit` 产物回归）；全量 `tests/skills/*.test.mjs` 55/55；DOCX：无评审 → `passed_with_warnings`（`visual=not_performed`），逐页评审 → `passed`，页数不符 → `review-page-count-mismatch`，图片不足 → `delivered_with_missing_assets`；PPTX：渲染成功仍记 `visual=not_performed`，评审后 `passed`，改一字节 → `failed` + `artifact-changed-since-delivery`；XLSX：通过 → `passed_with_warnings`，缺表 → `failed(content)` 且 `structural=passed`；适配前后旧报告 SHA-256 字节一致 | 适配器只是附加层，不改变任何旧交付门；渲染成功不等于视觉通过，`visual` 仍需人工/模型逐页评审；本机回归依赖三套 pinned runtime 与内网 Office Renderer，缺失时用例如实跳过；旧报告没有分段耗时，`timingsMs` 暂为空；尚未在 DOCX/PPTX/XLSX 的 SKILL.md 生成流程里串入（T3b.2/T3b.3） |
| 2026-11-09 | T3b.1 PDF 交付审计及降级 | 新增 `pdf.sh deliver`：结构审计 + 要求覆盖（`--require-text`/`--min-pages`/`--max-pages`/`--acceptance`）+ 可选渲染 + 可选 `--visual-review`（校验产物 SHA、页数、1..N 页、可选逐页图片哈希）→ 默认 `$PILOTDECK_WORK_DIR/pdf/qa/delivery.json`（未设置该变量时 `<PDF>/.pdf-qa/<stem>/delivery.json`），`failed` 退出码 3；`--require-render` 让“没有渲染”成为失败而不是降级；Poppler 从**全局硬拦截**改为**能力降级**：`pdf.sh` 不再因缺 `pdfinfo`/`pdftoppm` 拒绝所有命令，`check` 返回 `degraded`+`usable`+`render_available`，`make` 在缺 Poppler 时仍生成 PDF 并标 `visualAcceptance=not_performed`，`render` 报 `render-unavailable`；审计中 `pdfinfo` 失败降为警告（pypdf/pdfplumber 仍是结构权威）并新增 `capabilities`；协议新增 `visualEvidence`：技能自己的评审门（DOCX/PDF）可作为证据带入，`visual=passed` 必须有页矩阵或该证据，`passed` 报告无证据一律拒绝；新增 `from_pdf_delivery.py` 适配器 | `node --test tests/skills/*.test.mjs` 63/63（含 PDF 6 项、协议新增 2 项）；PDF：有要求无评审 → `passed_with_warnings`，带评审 → `passed`（`visualEvidence.pagesReviewed=[1]` 且绑定产物哈希），缺文本 → `failed(content)` 且 `structural=passed`，改动文件后评审失效 → `failed(visual)`，`PDF_SKILL_PDFINFO=`/`PDF_SKILL_PDFTOPPM=` 空值模拟缺 Poppler：`make` 仍成功、`deliver` → `passed_with_warnings`+`render=skipped`、`--require-render` → `failed`；协议：`visual=passed` 无证据 → `visual-evidence-missing`，证据哈希不符 → `visual-evidence-artifact-mismatch`，`passed` 报告删掉 `review` → `report-evidence-missing` | Poppler 仍是页面渲染的硬依赖，只是不再阻断新建/审计/交付；无 Poppler 时无法做任何视觉验收，报告最多 `passed_with_warnings`；`--visual-review` 的 `imageSha256` 用的是 PNG 文件哈希（DOCX 用像素哈希），两者不可互换；PDF 适配器依赖 `deliver` 的 `--report`，`make` 自带的 `.pdf-qa/audit.json` 不参与统一报告；尚未在 Web UI 展示 `visualEvidence` |
| 2026-11-09 | T3b.2 HTML/图示审计与视觉状态 | **HTML 要求覆盖：** `html_audit.py` 新增 `--require-text` / `--require-heading`（重复传入即可多条），在去掉标签、忽略空白的正文/标题池里匹配，未命中记 `requirement-not-met:text|heading`（error）；报告新增 `document.headingTexts` 与 `requirements{text,headings,results}`，`visual_acceptance` 仍恒为 `not_performed`。**图示几何审计：** `diagram_cli.py` 新增 `audit` 子命令（`--input` 或 `--body/--markdown/--spec`、`--max-width` 默认 1200、`--report`）：检查 `viewBox` 缺失、节点矩形越出画布、文字估算横向越界（warning）、宽度超报告正文预算（warning）；带原始输入时额外检查**节点文案超过三行上限被截断**（error），并核对成品文字是否与来源一致（`label-not-rendered`，即 SVG 生成于改稿之前）；`make` 返回值新增 `warnings`（`label-truncated`）与 `visual_acceptance=not_performed`，原有字段与退出码不变。**适配器：** 新增 `from_html_audit.py`（缺图从 `issues` 挪进 `missingAssets`，结构性仍 `passed`；要求缺失记 `content=failed`）、`from_html_package.py`（`blocked` → `structural=failed`，缺图 → `missingAssets` 并保留 `replaced`）、`from_diagram_report.py`（越界/脚本/文案未渲染 → `structural=failed`，截断 → `content=failed`）；`adapt.py` 新增 `html`（按报告结构自动识别 audit/package，可用 `--kind` 指定）与 `diagram`；`derived_acceptance` 支持各技能自定义 `derivedFrom.note`，HTML/图示不把产物自身内容回填成要求；两份 SKILL.md 补 `audit` 与 `--require-*` 用法 | `node --test tests/skills/*.test.mjs` 73/73（T3b.1 为 63，新增 10 项）；`node --test tests/skills/qa-adapters.test.mjs` 28/28；HTML：带 `--require-text/--require-heading` 且命中 → 适配 `passed_with_warnings`+`content=passed`，要求缺失 → `failed`+`structural=passed`+`content=failed`，缺图经 audit → `delivered_with_missing_assets`+`assets=missing`+`structural=passed`，经 package → `content=not_checked`+`missingAssets[0].replaced=true`+`legacy.kind=package`；图示：干净流程 → `passed_with_warnings`+`content=not_checked`，58 字长文案 → audit 退出码 1、`warnings[0].code=label-truncated`、适配 `failed`+`content=failed`，六节点流程 → `budget.exceeded=true` 但仅 warning、适配仍 `passed_with_warnings`，手写越界 SVG → `node-outside-viewbox`+`structural=failed`，成品早于改稿 → `label-not-rendered`+`structural=failed`；`make` 旧字段（`status/output/format/nodes/edges/direction/theme`）与退出码未变，`diagram.sh self-test` 与 `html.sh verify` 复验正常 | HTML/图示**没有服务端渲染**，`visual` 永远 `not_performed`，`passed` 对这两种格式不可达（最高 `passed_with_warnings`）；要求匹配只证明文字在页面里，不证明位置、顺序、字号或没被遮挡，块边界处忽略空白可能误判；图示文字宽度是按 CJK/ASCII 字符数估算，不能替代真实换行，边与节点重叠、箭头方向、连线交叉未检查；`make` 遇到截断只给 `warnings` 不失败（强制门在 `audit`），"先 audit 再交付"目前只写在 SKILL.md，尚未在流程里强制（T3b.3）；图示 `audit` 仅给 `--input` 时不做文案截断与成品一致性检查（`content=not_checked`） |
| 2026-11-09 | T3b.3 四类回归 + DOCX 渲染降级 | **回归集：** 新增 `tests/skills/qa-regression.test.mjs`，六个格式各一组「正例 / 反例 / 降级 / 旧流程」子测试（共 34 项）。**DOCX 降级修复：** `preflight` 原来在 Office Renderer 不可达时直接抛错、连报告都不写（`office-renderer-unreachable`，退出码 3，零证据）；现在把 Renderer 故障归为能力降级：`checks.render=skipped`、`text_coverage`/`coverage.status=not_checked`、页数上下限与 `rendered-text-empty`/`rendered-text-coverage` 在无渲染时不再误判，新增 `render-unavailable` 警告，报告照常落盘（`status=partial`）；`deliver` 仍要求 preflight 全通过（含视觉评审），未放宽。**证据绑定补口：** `html_audit` 与 `diagram.sh audit` 报告新增产物 `sha256`，HTML/图示适配器据此报 `artifact-changed-since-audit|package`，与 DOCX/PPTX/PDF/XLSX 的 `artifact-changed-since-*` 对齐。**文档：** DOCX SKILL.md 增「渲染不可用时的 preflight」、QA README 增降级映射行与第 6 条固定语义 | `node --test tests/skills/*.test.mjs` 107/107（T3b.2 为 73，新增 34）；`node --test tests/skills/qa-regression.test.mjs` 34/34；DOCX：正例 → `passed_with_warnings` 且报告哈希=文件哈希，缺必含文本 → `failed(content)+structural=passed`，改一字节 → `artifact-changed-since-preflight`，坏 Renderer → preflight 退出 3 但报告完整（`render=skipped`/`coverage=not_checked`/`render-unavailable`）且适配 `passed_with_warnings`，删掉 `visual_review` 的旧报告仍能映射且字节不变；PPTX：正例、需求不满足 → `failed`、改字节失效、坏 Renderer 仍交付 `passed_with_warnings`、删 `render` 的旧报告可读；XLSX：正例、缺表 → `content=failed`、改字节失效、坏 Renderer 仍交付、删 `render/preview` 可读；PDF：正例、缺文本 → `content=failed`、改字节失效、空 `pdfinfo/pdftoppm` 仍交付、删 `visualReview` 可读；HTML：要求命中 `passed_with_warnings`+打包 `ok`+`legacy.kind=package`、缺要求 `content=failed`、改页面 `artifact-changed-since-audit`、删 `requirements/sha256` 可读；图示：几何通过、文案截断 `content=failed`、改 SVG 失效、删 `content/budget/sha256` 可读；每例均断言适配器不改写旧报告字节 | DOCX 降级后 `preflight` 仍以退出码 3 表示「未完成」，调用方需读报告而不是只看退出码；无渲染时必含文本与页数无法判定（`not_checked`），只能到 `passed_with_warnings`；`deliver` 的门没放宽，Renderer 不可用期间 DOCX 只能走 `make` 交付；PPTX 反例的失败落在交付门（`structural=failed`）而非 `content`，因为覆盖不足先被门拦下；旧按钮读取用的是「从现行报告里删掉新字段」的模拟，不是历史版本的真报告文件；DOCX 报告里 `unresolved.warnings` 只保留计数（`limit=0`），单条审计警告不进统一报告，靠 `gate_issues` 兜底 |
| 2026-11-09 | T4.1 六格式能力矩阵 + 已有默认回归 | **新增文档：** `docs/format-capability-matrix.zh.md`，只写“代码已经跑通且被测试验证”的能力，文末 `capability-matrix` 机读 JSON 片段由测试逐条比对。**新增测试：** `tests/skills/format-capability.test.mjs`（6 个 test / 8 个断言），主题 ID 顺序与 `listThemes()` 一致、PPTX `themes` 六套齐全、DOCX 六主题可生成、PDF/XLSX/图示拒绝未实现的 `--design-theme`、DOCX `--spec` 的原生表格/图片/目录、XLSX 原生图表 + 条件格式进 audit、PPTX timeline/chart/table 版式、PDF Markdown 表格限制。**顺手修的真实缺陷 1（PPTX 丢内容）：** `--markdown` 中带正文的 H1 被当作 section 版式，分节页不画正文，整段内容静默消失；`parseMarkdown.flushSlide()` 现在把有正文的 H1 降级为 content 版式，纯分节 H1 仍是分节页。**顺手修的真实缺陷 2（XLSX 吞参数）：** `parseArgs` 保留未知 `--flag` 从不报错，`make --design-theme academic` 曾静默生成无主题文件；现在 `design-theme`/`designTheme`/`theme` 显式报错退出 1，提示 T4.3 才支持。**文档如实记录**：XLSX 图表需求必须带 `sourceRanges`(≥2) 与 `minPoints`，否则 `native_chart_requirement_floor` 失败（这是内容溯源门，不是 bug） | `node --test tests/skills/*.test.mjs` 115/115（T3b.3 为 107，新增 8）；`node --test tests/skills/format-capability.test.mjs` 8/8；实测 PPTX `# 病史` + 正文两行都在（`['病史','患者男性，58岁，胸痛3小时。']`），纯分节 H1 仍无正文页；XLSX `make --design-theme academic` 退出 1 并打印 `does not support --design-theme`，正常 `make` 仍 `status=ok`；DOCX `--spec` 含 table/image/callout/toc → `inspect` 得 `table_count=1`、`image_parts>=1`、`headings` 含标题与目录；XLSX `--spec` 含 column 图表+条件格式 → `audit` 退出 0（要求带 `minPoints:2`、`sourceRanges:["A2:A3","B2:B3"]`），删掉溯源字段则退出非 0 且报 `native_chart_requirement_floor`；PPTX `--spec` timeline/chart/table → 生成 4 页（封面 + 3 版式）；PDF Markdown 表格仍按 `| 指标 | 值 |` 原样排出 | 矩阵只覆盖已实测能力，未验证的不写；PPTX/PDF/DOCX 的 `--markdown` 都不解析 Markdown 表格（T4.2/T4.3 待补）；PDF 与图示 `make` 仍直接拒绝 `--design-theme`；HTML/图示 `visual` 恒为 `not_performed`；DOCX 内置策略禁止 `callout.accent` 等直接颜色覆盖；PPTX `--body` 是纯文本；默认观感未变，T0.3 HTML 视觉基线与默认刷新批准仍未完成 |
| 2026-11-09 | T4.2 PDF 主题化、管道表格与目录 | **主题：** `pdf.sh make` 新增 `--design-theme`（ID / 中文名 / 别名，spec 亦可写 `designTheme`）；接入 `skills/_shared` 读取器，得到六套色板 + 字体角色 + 字号/行距乘数；标题与各级标题用 `primary`、正文 `ink`、图注 `muted`、页眉页脚 `rule`/`muted`；主题模式加页顶细线 + 强调色方块、章前强调短横线、浅纸色底（`paper`）；`archive` 自动切到随包 `NotoSerifSC-Regular.ttf`（新增 `bundled_serif_font_name`）。**表格：** `--markdown` / `--body` / `--spec` 里的标准管道表格（表头 + `| --- |` 分隔行）转成原生 `LongTable`：表头用 `primary`/`onPrimary`、隔行 `surface`、网格 `rule`、数值列右对齐、`repeatRows=1` 跨页重复表头；没有分隔行的 `a | b` 仍按段落输出。**目录：** `--toc` / spec `"toc": true`，用 `TableOfContents` + `multiBuild`，按二级标题生成带点线的目录页。**取值能力：** `inspect` 新增 `fonts[]`（名称/子类型/是否嵌入），让「中文字体是否嵌入」可被断言而不是靠肉眼。`make` 返回 `theme.id`/`theme.label`（未指定主题时不出现该键）。**透明图：** `prepare_image_flowables` 现在按主题 `paper` 色合成透明 PNG，浅色纸面不再出现白框（默认仍合成白色，基线像素不变）。**默认不变：** 未指定主题时走原代码路径 | `node --test tests/skills/pdf-theme.test.mjs` 9/9；`node --test tests/skills/format-capability.test.mjs` 8/8；`node --test tests/skills/*.test.mjs` 124/124；**像素回归：** 用 T0 的 `pdf-content.md` 重新 `make` 并 144dpi 渲染，与冻结的 `pdf-baseline` 第 1 页逐像素比对，差异 bbox = None、最大像素差 0；六套主题均 `status=ok` 且 `theme.id`/`theme.label` 正确，`archive` 的 `inspect.fonts` 只嵌入 `NotoSerifSC`，其余嵌入 `NotoSansSC`；中文名/别名（宣纸病案→archive、临床→clinical、循证→academic）解析一致；未知主题退出码 2 并列出六套中文名；管道表格 `inspect --tables-out` 检出 1 张表、列值 `["白细胞","12.3","3.5-9.5"]` 正确，正文不再含 `|` 语法；60 行长表跨 2 页且第 2 页表头重复；`--toc` 首页出现「目录」与三个标题；无分隔行的 `收缩压 | 舒张压` 仍是段落（检出 0 张表） | 主题只覆盖配色/字体角色/字号乘数，版式几何不变（`layoutVariant`、影像底板、页数控制未做）；PDF 正文仍用 `NotoSansSC-VF` 的默认实例（Thin），改 400 需再加约 10 MB 字体，留待 T4.5 评估；目录不可点击、无页码对齐以外的排版优化；管道表格要求表格前有空行；未在院内 Linux + 目标阅读器复验；XLSX/图示仍无主题 |
| 2026-11-09 | T4.3 PPTX/XLSX 表格、主题图表与医学版式 | **PPTX 管道表格：** `parseMarkdown` 识别表头 + `| --- |` 分隔行，生成 `table` 版式页；表格正上方的标题直接成为该页标题，表格后的正文另起一页。**图表（含一处真 bug）：** 原来 `chartSlide` 用 `content.type` 当图表种类，而 `type` 是版式名 `chart`，加上 pptxgenjs 4.x 移除了实例级 `ChartType`，导致**所有 chart 页只生成空图框**；现在改用 `chartType`（`column`→`bar`+`barDir=col` 别名），非法值/空 series 直接报错。**主题化图表：** 序列色取 `theme.chart.series`、网格 `chart.grid`、轴标签 `chart.axis`；对比页底色改由 `soft` 与 `accent` 混色（旧主题仍用原硬编码色）。**三个新医学版式：** `case`（顶部 4 个信息卡 + 双栏）、`evidence`（结论卡 + 等级徽章列表）、`imaging`（contain 大图 + 图注 + 所见/结论，缺图给虚线占位）。**XLSX 六主题：** `--design-theme` / spec `designTheme`；标题与表头主色、正文墨色、工作表页签强调色、图表序列与网格取 `theme.chart`；`archive` 把正文字体切到 `SimSun`；`--theme` 仍报歧义错误。**视觉验收又抓到三个真缺陷：** ① ExcelJS 的 solid fill 只写 `fgColor`，LibreOffice 整块丢弃，表头在预览里是白的 → 统一改走 `solidFill()` 同时写 `fgColor`+`bgColor`；② 主题工作簿没重绘 `styleHeader` 写的默认 teal 表头，主题色板里凭空多出一条 teal → 现在按默认填充色识别并重绘；③ 线图的 `<c:smooth/>` 放在了 `marker` 之前，违反 CT_LineSer 的元素顺序（Excel 会提示"修复"）→ 移到 `val` 之后。**另发现一处限制（非 bug）：** XLSX 图表是浮动对象，LibreOffice 导出 PDF 时按页边裁切不缩放，默认锚点 `G2:N18` 有一半在 A4 纵向页外，看起来像"图表坏了"，因此写进能力矩阵与 SKILL.md 的锚点建议。原生 Excel 表格样式不能表达自定义色板，改用**单元格直接格式**覆盖表头，因此在 Excel 里看到的就是主题色 | `node --test tests/skills/pptx-content.test.mjs` 6/6；`node --test tests/skills/xlsx-theme.test.mjs` 5/5；`node --test tests/skills/format-capability.test.mjs` 8/8；`node --test tests/skills/*.test.mjs` 137/137（新增 2 个：`solidFill` 双色断言、line ser 元素顺序）；管道表格生成 3 页（封面 + 表格 + 结论），slide XML 含 `<a:tbl>`；`chartType` 默认/`line`/`column` 分别生成 `<c:barChart>`/`<c:lineChart>`/`barDir=col`，`donut-hole` 与空 series 均非零退出；`archive` 主题图表 XML 含 `2B2A26`/`9C3B2E` 与网格 `E6DFD0`；病例/影像/证据三页远程 Renderer 各 1 页成功并逐张目视检查（信息卡、CT 居中、等级徽章与分隔线正常），审计 0 错误 0 重叠；XLSX 主题文件含 `<tabColor rgb="FF9C3B2E">`、`FF2B2A26` 表头与 `SimSun`，图表 `1A3A5F` + 网格 `DCE1E8`；无主题工作簿无 `tabColor`、图表仍是 `4472C4`；主题工作簿 `deliver` 不被拒；两个旧自检（`pptx.sh self-test`、`spreadsheet.sh self-test`）与 HEAD 干净 worktree 逐项对照，`status`/`checks` 一致（CJK 审计 2 warning、XLSX `audit: warning` 均为 HEAD 既有现象，非本轮引入）；`node scripts/check-skill-tokens.mjs` → `{"status":"ok","themes":8,"errors":0}`；`git diff --check` 无输出；XLSX 视觉复核（Office Renderer，110dpi）：`archive` 主题表头为 `2B2A26` 深底 + 米色字、图表线 `2B2A26`、网格 `E6DFD0`；无主题表头仍是 teal `0F766E`（此前在 LibreOffice 里根本不显示，现在能显示，属修正）；图表锚点收进 `A7:H24` 后标题/刻度/图例/折线全部正常 | 主题不改版式几何、列宽与数字格式；XLSX 不含主题的“版式”，只有颜色与字体角色；PPTX 列表项目符号在 LibreOffice 渲染下偏淡（既有现象，未在本次改动）；新增版式只做了结构断言与一次 Renderer 目视，未在真实 PowerPoint/医院模板复验；`case`/`evidence` 超长文案靠 `fit: shrink` 兜底，未测极端长度 |
| 2026-11-09 | T4.4 HTML 签名组件与图示配色主题 | **图示两条轴解耦：** `--theme clean|architecture` 只决定布局与节点形状（数据库圆柱、外部系统虚线框），新增 `--design-theme` 只决定颜色与字体；两者可任意组合，spec 亦支持 `designTheme`，命令行参数优先。新增 `scripts/design_theme.py` 复用 `skills/_shared/tokens.py`（与 DOCX 的 `themed-v1` 同一读取器），把主题映射成背景 `paper`、标题 `primary`、连线/边框/次级文字 `muted`、分组框 `rule`、风险节点 `semantic.danger.bg`、节点填充按 `kind` 取 `soft`/`support`/`accent` 的浅色调（保证 `ink` 文字可读），字体取 `typography.headingRole`/`bodyRole` 的 `htmlStack`（`archive` 衬线）。**不写 `--design-theme` 时输出与 HEAD 逐字节一致**（用干净 worktree 对 `--body` 与分支 `--markdown` 两份输入各 diff 一次）。主题名写错退出码 2 并列出六套中文名。**HTML 签名组件：** `theme-css.mjs` 新增 `componentCss()`，按每套主题的 `surface` 令牌生成可选的 `.pd-masthead`、`.pd-section-marker`、`.pd-table thead th`、`.pd-callout`、`.pd-imaging`、`.pd-footer` 与主题无关的 `.pd-stamp`，只引用已有令牌、不新增颜色，页面不用这些类时与 T2 的纯令牌版本完全一致。| `node --test tests/skills/diagram-theme.test.mjs` 6/6（默认输出不变、换主题不改几何、两轴独立、未知主题退出 2、spec 与 CLI 优先级、audit 带主题）；`node --test tests/skills/html-audit.test.mjs` 14/14（新增 surface 组件断言与 `html.sh themes` 列表，并把“6 个主题块”的正则从 `html[data-pd-theme="` 收紧为带空格大括号，避免把组件选择器算进去）；`node --test tests/skills/format-capability.test.mjs` 8/8（图示改为接受 `--design-theme`）；`node --test tests/skills/*.test.mjs` 145/145；`node skills/frontend-slides/scripts/build-theme-css.mjs --check` 通过（10075 字节）；`bash skills/frontend-slides/scripts/html.sh themes` 列出六套主题与 surface 槽位；目视：`archive`/`academic`/`edu` 三套 HTML 组件样张（qlmanage 缩略图），分别看到衬线+细线框、实心色带+主色表头、圆角卡+浅底表头；图示 `松风急救 + architecture` 样张看到圆柱、虚线外部框、风险粉底与绿色主色标题 | 图示与 HTML 都不嵌字体，`archive` 衬线在缺 `Noto Serif CJK` 的机器上回落 `SimSun`/系统 `serif`；图示主题不改坐标与画布尺寸，也不改连线走向；HTML 组件只覆盖六个槽位，未做响应式/窄屏专项验证；两者 `visual_acceptance` 仍是 `not_performed`（用户回传截图后再定位区块修正） |
| 2026-11-09 | T4.5 目标平台字体、溢出、跨页与图片复验 | **实测（Office Renderer → PDF → `pdffonts`）：** DOCX `w:eastAsia="Noto Sans SC"` 与 PPTX `typeface="Noto Sans SC"` 在 LibreOffice 基线上都被换成 `NotoSansCJKjp-Regular`；XLSX `archive` 的 `SimSun` 同样落到 `NotoSansCJKjp`，衬线因此丢失。Debian 12 只装 fontconfig 时全部落到 DejaVu（中文豆腐块）。PDF 因为随包嵌字体不受影响。**新增 `scripts/platform-preflight.mjs`：** 在部署机上一次跑完 —— 用 `fc-match` 解析六个字体名并分五档判定（`font-exact` / `font-substituted` / `cjk-variant-mismatch` / `serif-lost` / `no-cjk-face`+`fontconfig-missing`）、检查 node/python3/pdffonts、探测 Office Renderer 可达性；`ok`/`warning` 退出 0，`error` 退出 2，缺渲染器只记 `skipped` 而不是失败。**新增 `docs/target-platform.zh.md`：** 实测替换表、`fonts-noto-cjk` 安装 + `LANG=zh_CN.UTF-8` 或 fontconfig 别名配方（别名同时修掉 SimSun 丢衬线）、自检用法与五类判定含义，以及溢出/跨页/图片的现状清单与"现场才能闭环"的三项边界。 | `node --test tests/skills/platform-preflight.test.mjs` 9/9（正确配置→ok、JP 回退→警告、无中文字体→逐项警告、缺 python3→error、无 fc-match→unknown 不算通过、渲染器 skipped/可达/不可达三态、字体清单覆盖、衬线丢失、CLI 退出码）；本机实跑 `node scripts/platform-preflight.mjs` → `warning（error 0 / warning 5）`，正确指出 macOS 本机没有那五套字体；Docker `debian:bookworm-slim` 只装 fontconfig 的对照组确认四个字体名全部落到 DejaVu | `fonts-noto-cjk` 完整容器验证因镜像下载过慢中止（已停容器清理），改用 Office Renderer 的等价证据；医院真机字体安装、浏览器版本、真实 PowerPoint/WPS 版式差异仍只能现场确认——这正是 `platform-preflight.mjs` 存在的原因，不代表功能缺口 |
| 2026-11-10 | T4.6 换用目标机自带字体名（微软雅黑 + 宋体） | **问题：** OOXML 只写字体名不嵌字体，此前 PPTX 写的是 `Noto Sans CJK SC`、DOCX 写 `Noto Sans SC`、XLSX `cross-platform` 写 `Noto Sans SC`——这三个名字 Windows 和 macOS 都没有，医生打开即被静默替换；实测 archive（衬线主题）在 PowerPoint 里被换成 `MicrosoftYaHei`，衬线等于没做。**改动：** ①`themes.mjs` 改用 `fontRoles.*.officeWindows`（`Microsoft YaHei` / `SimSun` / `Consolas`），这三者 Windows 自带、Office for Mac 在 app 内自带同名文件；②`toolkit.mjs` 的缺包回退与 `make.mjs` 的无主题路径改 `Microsoft YaHei`（legacy `build` 路径仍写 Arial，旧文件逐字节不变）；③DOCX `resolve_fonts` 不再按生成机平台取字体（Mac 写 PingFang、服务器写 Noto 都是错的），改为按 `cjk_family` 写 `Microsoft YaHei` / `SimSun`，并让 `--design-theme archive` 真正把 `cjk_family=serif` 传下来（此前 DOCX 的衬线主题从来没生效）；④XLSX `cross-platform` 档案改 `Microsoft YaHei`（显式 `--font-platform linux` 仍写 Noto）；⑤`typography.mjs` 新增 `OFFICE_PORTABLE_CJK`：两平台 Office 都带的字体名不再报 `platform_specific_font`（否则交付门会因 warning 拦截）；⑥`platform-preflight.mjs` 探测清单从 6 项改为「3 个写入名 + 2 个渲染名」。| `node --test tests/skills/*.test.mjs` 156/156；六套主题 12 页 `make` + `audit` 全部 `passed`、`typographyWarnings: 0`（改前 `Microsoft YaHei` 会触发 1 条 warning 导致交付门失败）；slide1 字体：clinical/academic/trauma/edu/mono = `Microsoft YaHei`，archive = `SimSun`；DOCX `w:eastAsia` = `Microsoft YaHei`，`--design-theme archive` = `SimSun`（改前两处都是 `Noto Sans SC`）；XLSX 默认 = `Microsoft YaHei`，archive = `SimSun`；PowerPoint 导 PDF 后读字体表：archive = `SimSun`（衬线真实出现），其余 = `MicrosoftYaHei`；`check-skill-tokens --check-package` 与 `build-theme-css --check` 通过 | 新字体名在 LibreOffice Renderer 上尚未复验（离线渲染器不可用），需按 `docs/target-platform.zh.md` 3.2 的 fontconfig 别名把 `Microsoft YaHei`/`SimSun` 指到 Noto；只装 Keynote/快速预览的 Mac 仍会替换，这类用户应交付 PDF；PDF 仍嵌入 Noto（与 PPTX 的雅黑观感接近但不完全相同）；HTML 的 `htmlStack` 未调整（栈内回落已能命中雅黑/苹方）；`pptx.sh build --builder`（legacy 路径）仍写 Arial，未随本决策变更 |
| 2026-11-10 | T4.7 PDF 目录重写 + DOCX 勾选框 + T5.3 矩阵 | **PDF `--toc`（真 bug，两处）：** ①ReportLab `TableOfContents` 的条目是带 `<onDraw>` 点线回调的 Paragraph，配上随包可变字体后文字进了文本层却画不出来（poppler 与 Quartz 一致只显示点线），旧测试只断言文本层所以一直绿灯；②目录后没有 `PageBreak`，目录与正文挤在同一页、页码全是 1。改为自实现的 `_TocFlowable` 直接画在画布上（两遍式：`beforeBuild` 发布上一轮条目、`isSatisfied` 比对页码），目录独立成页、`##` 一级 / `###` 二级缩进 / `####` 不收录、点线按剩余宽度计算、超页自动 `split` 续页；`make` 返回 `tocEntries[{level,text,page}]`；标题样式加 `keepWithNext=1`，消除页底孤行标题。**DOCX 勾选框（真 bug）：** `☒`/`☐`（U+2612/U+2610）在微软雅黑、宋体、随包 Noto Sans SC 里都没有字形，Word 只能回落成两个一模一样的空框；改用 Word 原生 `<w:sym w:font="Wingdings" w:char="F0FE|F0A8"/>`（勾选框 / 空框）。**T5.3 起步：** 新增 `tests/skills/theme-sample-matrix.test.mjs`，六主题 × 四格式共 24 组逐组构建并断言主题真的落地。 | `node --test tests/skills/*.test.mjs` 161/161（156 → 161，新增 5）；PDF 新增 3 条：目录独立成页（首页不含正文）、层级与页码（`##`→0、`###`→1、`####` 不收录、正文从第 2 页起）、40 条目录跨页续排；目视：clinical/archive/neutral 三套主题的目录页 17 行点线+右对齐页码正常，长目录第 1 页 27 行 + 第 2 页续排；DOCX 断言 XML 中只有 `Wingdings:F0FE` / `F0A8` 且不含 U+2610–2612，`docx.sh` audit `ok`；主题矩阵 24/24（PPTX 用 `--theme`、其余 `--design-theme`），archive 在 PDF 里仍嵌入 `NotoSerifSC` | **Pages/LibreOffice 不渲染 `w:sym`**，勾选框在这两个软件里不显示（条目正文仍在），必须在 Word 里核对；PDF 目录条目不可点击（未做内链）；PDF 正文标题层级变了（`###` 由原来的 H2 字号改为 H3 字号），旧样张若按像素比对会与 T0 基线不同（未指定主题且无 `###` 的文档不受影响）；T5 的 HTML/图示两技能、缺项与内容溯源断言仍未覆盖 |
| 2026-11-10 | T1b.4 默认主题刷新（D1，用户批准「三个默认全部变新观感」） | **PPTX：** `toolkit.mjs` 的 `buildToolkit` 改为无条件调用 `resolveSharedTheme(themeName)`（未传 `--theme` 时 `themeName` 回退 `DEFAULT_THEME='clinical'`），共享读取器不可用时仍回退旧内置色板；`pptx_cli.mjs` 的 `themes` 输出把 `defaultRefresh` 从 `pending-approval` 改为 `approved-2026-11-10`。**PDF：** `pdf_cli.py` 新增 `NEUTRAL_THEME_NAMES`（`none`/`neutral`/`off`/`无`/`中性`）：显式写这些 → `palette=None` 走旧纯黑白；写其他主题名 → 解析该主题；**不写**且共享令牌可用 → `resolve_pdf_theme('')` 取默认 `clinical`；不写且缺 `_shared` → `palette=None` 保持可构建。**HTML：** 无生成器，默认值只能写在指令层 —— `frontend-slides/SKILL.md` 主题章节由“可选”改为“默认 `clinical` 临床晨光”，`references/themes.md` 同步“未指定时一律用 `clinical`”；`html.sh themes` 输出新增 `default` 字段；`html_audit.py` 新增 `theme-attribute-missing` 告警（内联了 `--pd-paper` 令牌却没写 `data-pd-theme` 时所有选择器都不生效，以前静默通过）。**共享读取器：** Node/Python 的 `list_themes` 每项补 `default` 布尔。**文档同步：** 能力矩阵新增“未指定主题时的默认”表与机读 `defaults` 块；`pptx`/`pdf` SKILL.md 的默认语、`design-theme-tokens.zh.md` 状态行与默认行为段、本文件 §0/§0.1/§2/§7 一并改写。 | `node --test tests/skills/*.test.mjs` **165/165**（改前 161/161，新增 4：矩阵默认主题探针、HTML 默认声明、`theme-attribute-missing`、PDF `none` 分支）；`node scripts/check-skill-tokens.mjs --check-package` → `{"status":"ok","themes":8,"errors":0,"warnings":0}`；`git diff --check` 无输出。**PPTX 实测：** 不带 `--theme` → `theme=clinical / themeLabel=临床晨光`，与显式 `--theme clinical` 逐页 XML 完全相同；`--theme clinical-legacy` → `临床通用（旧版）`，slide1 仍含旧主色 `102A43`，与新默认不同。**PDF 实测：** 不带 `--design-theme`（含 `--spec` 路径）→ `{'id':'clinical','label':'临床晨光'}`；`--design-theme none` → JSON 无 `theme` 键；100dpi 渲染第 1 页，默认 vs 显式 `clinical` 像素差异 bbox = `None`，默认 vs `none` 有差异。**HTML 实测：** `html.sh themes` 返回 `default=clinical` 且只有一项 `default=true`；把主题令牌内联但删掉 `data-pd-theme` 的样张 → 审计给出 `theme-attribute-missing`。**旧基线：** 改版前后对照样张（PDF/PPTX 拼图）在本地 `/tmp/skill-samples/`，不进仓库。 | HTML 的默认值**无法硬断言**：没有生成器，只能靠 SKILL.md 指令 + 审计告警兜底，模型仍可能不照做（审计会报警但不会失败，因为纯文本页面本就不需要主题）；旧观感回退从“默认”变成“显式”：PPTX 需 `--theme clinical-legacy`，PDF 需 `--design-theme none`，任何依赖“不传参数即旧样张”的外部脚本/像素基线都会失败（本仓库内相关断言已同步改写）；DOCX/XLSX/图示本次按 D4/D5 不刷新，仍为旧默认；未在真实 PowerPoint / 目标阅读器上复验新版默认观感（仅本地渲染）。 |
| 2026-11-10 | T4.8 图示几何三修（承接 D1 目视时发现的问题） | **先纠错：** D1 目视时按缩略图判断「菱形文字溢出」「边标签压住院内 HIS 框」，用 Chrome 1:1 重渲染后两者都不成立——单行判断文案本来就在菱形内，标签也没碰到那个节点。真实缺陷是另外三个。**① 判断节点不再固定 184px：** 菱形只有腰部是全宽，两行文案（如「是否满足急诊介入指征」）会溢出斜边；新增 `node_width()`，按最长一行与文字带高度反算所需宽度（`(text+2*pad)/(1-band/(h/2))`），单行短文案仍返回 184 保持旧观感。**② 边标签不再压在连线上：** 折线连接器的中段是竖线（LR）/横线（TB），旧代码把标签按两端中心取中点，正好落在这一段的轴上，halo 把线截成两截；新增 `edge_label_placement()`：直线边标签放在线上方居中，折线边先试竖线左侧、再右侧、最后拐角上方，逐个与「节点框 + 已放置标签」做碰撞检测，取第一个不冲突的位置。**③ 超宽单链自动转纵向：** 新增 `Diagram.direction_explicit` 与 `rotate_if_too_wide()`——只有「没显式指定方向 + 每层只有一个节点 + 横向超过 1200px」才转 `TB`，并在 JSON 返回 `directionNote` 说明原因；显式 `--direction` / Mermaid 表头 / spec `direction` 一律不改写，有分支的图也不转。为此把 `--direction` 的 CLI 默认从 `"LR"` 改为 `None`，`parse_body`/`parse_spec`/`parse_mermaid` 分别记录方向是否来自调用方。**顺带：** `layout()` 改为按层最大宽度/高度做累计偏移，菱形变宽后同层节点仍居中对齐、纵向排布不会与下一层重叠（等宽等高的旧图坐标不变：3 节点 `--body` 仍为 900×280、x=64/358/652）。 | `node --test tests/skills/*.test.mjs` **171/171**（D1 后 165，新增 6 条 `tests/skills/diagram-layout.test.mjs`）；其中 `qa-adapters` 的「超宽图只是警告」用例改为显式 `--direction LR` 并注明原因（否则 6 节点单链会自动转 TB）。实测：8 字两行判断节点菱形由 184 加宽到 223，文字两侧各留约 14px；1:1 Chrome 渲染确认「同步抽血」在线之上、「是」在线上方、「否 → 观察」在竖线左侧 8px、「登记」移到拐角处不再压线；6 节点链 `一→…→六` 自动 `TB`（480×1104，`directionNote` 说明 1782px > 1200px），显式 `--direction LR` 仍为 1782 宽且无 note；7 节点带分支样张仍 `LR`（1488px，审计照旧给 `too-wide-for-report-width` 警告）。`node scripts/check-skill-tokens.mjs --check-package` 与 `git diff --check` 通过。 | 自动转排只覆盖「单链」；分支图超宽仍只能靠 audit 警告 + 人工拆图，未做折行/分区布局。菱形宽度按字符数估算（CJK 1、ASCII 0.55），极端中西混排仍可能估偏；节点文案仍受三行上限约束（超限是 `label-truncated` 错误，未改）。`--direction` 默认值改为 `None` 属于 CLI 语义变化：依赖「不传就是 LR」的外部脚本在超宽单链上会拿到 TB，需要时显式传 `--direction LR`。未在 Word/浏览器里复验转排后的纵图观感。 |
| 2026-11-10 | T5.1/T5.2/T5.3 完成，T5.4 记为不可测 | **T5.1：** `theme-sample-matrix` 补 `html`（含 viewport 的页面 + `html.sh audit`）与 `diagram` wrapper，六格式齐；新增 `tests/skill-e2e/fixtures/PROVENANCE.md` 登记三份公开素材的来源/许可/隐私与决定，并登记测试内自撰合成素材所在文件。**T5.2：** 新增 `scripts/check-test-assets.mjs`（`npm run check:test-assets`）检查「local-fixtures 是否被提交」「两个 ignore 文件是否真的生效（`git check-ignore`）」「离线包 staging 是否把 `tests/` 带进交付包」，公开素材隐私只告警不拦构建；新增 `tests/skills/check-test-assets.test.mjs` 5 条（真实仓库 + 临时 git 仓库复现三种失败）。**T5.3：** 新增 `tests/skills/regression-missing-assets.test.mjs` 5 条钉住缺项行为（DOCX 报错、PDF 载荷报错但退出码 0、PPTX 无 `image` 字段是占位、PPTX 坏路径失败、HTML 审计 `missing-resource`）。**T5.4：** `scripts/run-skill-e2e.ts` 新增 `--probe` 与不可测退出码 78，网关地址按 `PILOTDECK_GATEWAY_URL`→`PILOTDECK_GATEWAY_PORT`→`scripts/config.env`→18789 解析。 | `node --test tests/skills/*.test.mjs` **181/181**（171 → 181，新增 10）；`node scripts/check-test-assets.mjs` → `{"status":"ok","errors":0,"warnings":1}`（1 条告警=三份公开素材仍在 Docker 构建上下文，属已登记人工项）；`node scripts/check-skill-tokens.mjs --check-package` → `{"status":"ok","themes":8,"errors":0,"warnings":0}`；`git diff --check` 无输出；`npx tsc --noEmit` 通过。`npx tsx scripts/run-skill-e2e.ts --probe` → `untestable`：11 个用例**可测 0 个**，六套运行时与三个 fixture 就绪，阻塞为网关 `http://127.0.0.1:18800` 未监听（token 缺失）与两个模型端点均无 HTTP 响应（`qwen=10.31.112.47:18001` 处于 `listening-but-silent`，TCP 可连、HTTP 超时；`qwen-backup=10.31.112.13:8040` 不可达）；`npm run test:skills` 退出 78，未产生伪造的 PASS/FAIL。 | T5.4 的真实 Agent 会话与视觉矩阵**仍未执行**，需模型端点恢复 + `bash scripts/start-local.sh` 后重跑；`wse_0820_00_injury.jpg` 的来源与许可仍待人工补齐；公开素材 PHI 未做机器扫描（按用户决定暂不处理 DICOM）；`--probe` 的模型探测对慢启动的 vLLM 严格（5 s 无响应即判 `listening-but-silent`），冷启动时需要重试。 |

## 10. 变更记录

| 日期 | 内容 |
| --- | --- |
| 2026-11-10 | v2.6：T5.1–T5.3 完成、T5.4 记为不可测。六格式主题矩阵（48 组）；缺项行为测试 5 条（含 PDF「载荷报错但退出码 0」这一坑）；新增打包自检 `check-test-assets`（含负向 5 条）；新增 `PROVENANCE.md` 素材来源/许可登记；E2E runner 增加 `--probe` 与退出码 78（不可测≠失败），并把网关端口解析改为跟随 `scripts/config.env`。PHI DICOM 按用户决定只登记不改动。 |
| 2026-11-06 | v2.1：按 D1–D5 更新主题方案——默认主题允许一次性刷新并保留 `clinical-legacy`；月白影像并入临床晨光成为影像组件；最终 5 展示 + 1 灰阶共 6 套；DOCX 默认中性、显式才上色；HTML/PDF/PPTX 全量、DOCX/XLSX/图示令牌级；新增 `docs/design-theme-tokens.zh.md` 作为可实现规范；T1 增加“先修中文 ea 字体”前置项。 |
| 2026-11-06 | v2.2：按 D6 取消 T2b 服务端 HTML 渲染（含 Playwright/Chromium 依赖），改为 T2c：生成后静态预算（事实类准确、估算类仅告警、不限制设计）+ 用户截图回传闭环；不新增模板硬约束；内部 QA 如实记录 `not_performed`，面向用户不输出固定免责声明（仅在用户要求验收、追问或发现具体问题时说明）。 |
| 2026-11-06 | v2.3：进一步消除计划冲突：HTML 保留 `write_file` / `edit_file` 自由生成，不强制内容 schema、区块模板或生成器；静态检查不冒充浏览器视觉验收；单文件不强制写入系统字体说明；默认主题切换改为基线、对照和批准后的阶段动作；仓库已有浏览器导出脚本不纳入 HTML 默认链路。 |
| 2026-11-09 | v2.4：适配 `feat/permission-arch-v2`；不沿用另一分支的结构化工具完成记录；仅新增测试材料使用本地隔离目录，原有三份跟踪素材保留；T0.1 建立合成输入，T0.2/T0.3 暂不算通过。 |
| 2026-11-09 | v2.4.1：补 `vital-legacy` 隐藏回退色板；共享令牌不重复旧 PPTX 键，后续由适配器映射。当前只实现数据和读取器，生成器与默认主题均不变。 |
| 2026-11-10 | v2.5：D1 执行完毕——PPTX/PDF/HTML 未指定主题即 `clinical`（PPTX 与显式 `--theme clinical` 逐页 XML 一致，PDF 旧黑白改用 `--design-theme none`，HTML 由 SKILL 指令默认并在 `html.sh themes` 暴露 `default`）；DOCX/XLSX/图示按 D4/D5 不刷新。文档把“批准前保持旧默认”的表述全部改为已执行口径。 |
| 2026-11-05 | v2.0：增加 T0 和可选 T2b；T1 只统一主题意图与语义色，不改旧默认；T3 适配现有交付门；QA 用每轮工作目录；HTML 缺图可说明后交付；增加整包下载与全部测试材料本地隔离验收。旧版“所有技能同值”“无交付门”“缺图必须拦截”“现有远程 HTML 截图接口”等说法不再作为实施依据。 |
| 2026-11-04 | v1.2：HTML 文件夹用 `<页面短名>_<YYYYMMDD-HHmm>`，入口 `index.html`，不覆盖、支持明确的原地更新。 |
| 2026-11-04 | v1.1：HTML 支持带图文件夹；主题对外中文名、内部 ASCII ID。 |
| 2026-11-04 | 初版：T1–T5 和进度记录。 |
