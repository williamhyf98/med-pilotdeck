# 离线工作站：已删 Skill / 工具对照与改版清单

本文是后续实现的对照文档。裁剪背景见 [`offline-deployment-plan.md`](./offline-deployment-plan.md) 步骤 2、[`offline-skill-tool-cut-for-peers.md`](./offline-skill-tool-cut-for-peers.md)。原厂完整配方与工具实现以 GitHub `origin/master` 为准；本地 `.pilotdeck-home/skill-backups/legacy-bundled-v1` 只有部分备份。

**当前产品：** Linux 离线医疗工作站。允许的网络只有现场配置的模型 HTTP（vLLM / embedding）。Agent 不应被 skill/工具诱导访问公网。

**当前已保留（本文不改）：**

| 层 | 项 |
| --- | --- |
| 通用 Skill | `pdf` `docx` `pptx` `spreadsheets` `diagram-maker` `frontend-slides` |
| 医学 Skill | `med-medical` `med-case-report` `med-trauma-assist` `med-trauma-stage-plan`（插件目录，不复制进根 `skills/`） |
| 内置工具 | `read_file` `write_file` `edit_file` `glob` `grep` `bash` `read_skill` `todo_write` `ask_user_question` `get_current_time` |
| 插件 MCP | `mcp__med-tools__*` 全部保留 |

实现原则：一次只做一个阶段；能用配方/文案解决的不要上 Playwright 或 Python 沙箱；禁止把公网版 skill 原样拷回。

---

## 0. 三层不要砍错

| 层 | 是什么 | 加载位置 |
| --- | --- | --- |
| 内置 Skill | `SKILL.md` 配方。模型 `read_skill` 后按配方调工具 | 仓库 `skills/` |
| 内置工具 | Gateway 直接给模型调的函数 | `createBuiltinRegistry` |
| 插件 Skill / MCP | 业务能力 | `plugins/med-tools` 等 |

Skill **不是**新引擎：没有独立「总结服务」或「幻灯片渲染器」。改版 Skill = 改配方与触发条件。改版工具 = 改注册、权限与文案。

---

## 1. 已删除、本轮不恢复

来源：`origin/master:skills/` 相对当前 `feat/offline` 所缺目录，以及 `createBuiltinRegistry` 已拿掉的注册。

### 1.1 内置 Skill（不恢复）

**必须联网 / 云 SaaS**

| Skill | 原功能 | 不恢复原因 |
| --- | --- | --- |
| `weather` | `curl wttr.in` 查天气 | 公网；医疗现场无价值 |
| `github` | GitHub API / `gh` | 公网；本地 Git 面板已覆盖源码操作 |
| `notion` / `trello` / `1password` | 云笔记、看板、密码库 | 对方云 API |
| `gog` | Google Workspace | OAuth + 谷歌 |
| `blogwatcher` | 公网 RSS | 公网 |
| `find-skills` | `npx skills` / skills.sh | 公网 skill 市场；ClawHub 已关 |
| `summarize`（原厂） | `summarize.sh`：URL / YouTube / 公网 LLM Key / Firecrawl / Apify | 与现场 vLLM 不是一条链路。用户要的「总结本地文档」见 §4.1，**不要拷回本 skill** |

**看起来本地、实际出网或绑桌面**

| Skill | 原功能 | 不恢复原因 |
| --- | --- | --- |
| `meeting-recorder-assistant` | `pyaudio` 录音 + **Google 公网语音识别** + 抽纪要 | **已确认本轮不做。** 无现场 ASR 则无可交付离线形态。服务器通常无麦克风；原脚本不能加回 |
| `obsidian` | 调正在运行的 Obsidian 桌面 CLI | 无桌面 App；本地 md 用 `read_file`/`grep` 即可 |
| `himalaya` | 本机 Himalaya CLI，IMAP/SMTP 邮件 | **等有内网邮箱再单独立项。** 届时需预置二进制与账号配置，不是拷回 skill 目录 |

**平台不对**

| Skill | 原功能 |
| --- | --- |
| `apple-notes` / `apple-reminders` / `bear-notes` | macOS / iOS |
| `powershell` | Windows |
| `tmux` | 本地终端复用；已有终端页 |

**开发向（本地能跑，产品不需要）**

| Skill | 原功能 |
| --- | --- |
| `web-design-guidelines` | 通用前端审查清单（与医学展示重复且偏网站） |
| `react-next-best-practices` | React/Next 工程规范 |
| `karpathy-guidelines` | 减少乱改代码 |
| `skill-creator` | 编写/评测 skill |
| `pilotdeck-skills-migration` | 一次性迁移 |
| `spike` | 丢弃式原型 |

`frontend-design` / `frontend-slides` **不是**本表「永不恢复」，见 §2。

### 1.2 内置工具（不恢复）

| 工具 | 原功能 | 不恢复原因 |
| --- | --- | --- |
| `web_search` | 公网搜索（GLM/Z.AI 或 Tavily） | 检索走战创伤 RAG / 本地语料 |
| `web_fetch` | 抓任意 URL | 任意出网 |
| `send_attachment` | 往 IM 频道发文件 | 只留 Web 对话时不需要 |
| `agent` | fork 子 Agent | 单会话 + `todo_write` 即可 |
| `task_create` / `task_list` / `task_output` / `task_wait` / `task_stop` | 后台长任务 | 常驻 / Cron 已覆盖 |
| `edit_notebook` | 改 Jupyter | 无数据科学笔记本场景 |
| `structured_output` | 程序宿主 JSON 终态 | 给人聊，不是给程序宿主 |

`enter_plan_mode` / `exit_plan_mode` 见 §2。`execute_code` 见 §3。

### 1.3 同批公网入口（不是工具，也不恢复）

- 内置 `browser-use` **插件**的公网版（任意 URL、安装时下载 Chrome）——白名单本地版见 §3
- ClawHub / 从网上 import skill
- 默认遥测、默认公网 IM、onboarding 默认 OpenRouter

---

## 2. 本轮要做：保留能力但必须改版

按实现顺序。做完 2.1 再做 2.2。

### 2.1 阶段 A — 医学 HTML 展示 Skill（只改 `frontend-slides`）

**目标：** 一条通用、只读 skill（目录名仍为 `frontend-slides`）。模型按用户需求写出**医学风格、单文件、零 npm** 的 HTML，用现有 Files 预览 / 新标签打开。可编辑 PPT 仍走 `pptx`。

**布局：默认自由布局。** 不设「投屏 / 病例页 / 仪表盘」三选一。那三种只是自由布局里常见的排法，用户口头要求投屏或一览时，在同一套硬约束上追加几条规则即可。

**不要：** 恢复 `frontend-design` 目录；不要依赖 `browser-use`；不要默认 100vh 幻灯片；不要公网字体/CDN/`fetch`。

#### 原厂 `frontend-slides` 是怎么写的（`origin/master`）

这是给「前端演示 Agent」用的长配方，不是捆绑 `*.sh` 生成器（和 `pptx.sh` 不同）。模型读完后自己 `write_file` 出 HTML。

| 文件 | 原作用 |
| --- | --- |
| `SKILL.md`（约 320 行） | 触发词（只要 HTML/浏览器演示、不要可编辑 pptx）→ 原则（单文件、零依赖）→ 设计美学（避免 AI slop、个性字体）→ **强制 viewport 一屏一页** → Phase 0–6：新建 / 改已有 deck / 从 pptx 转 HTML / 交付 / **Vercel 部署与导出 PDF** |
| `html-template.md` | 幻灯片 HTML 骨架；原模板用深色主题、**Fontshare/Google Fonts 外链**、accent 高饱和 |
| `viewport-base.css` | 每个 `.slide` 锁 `100vh`、`overflow: hidden`、scroll-snap |
| `STYLE_PRESETS.md` / `animation-patterns.md` | 风格预设与动效，偏演示/营销 |
| `scripts/deploy.sh` | 部署到 **Vercel 公网** |
| `scripts/export-pdf.sh` / `extract-pptx.py` | 导出 PDF、从 pptx 抽内容转网页 |

`frontend-design` 在 master 上只有一份短 `SKILL.md`（视觉层次、去 AI 味），没有脚本。阶段 A **不恢复该目录**，把「克制、可读、别做成营销页」收进 slides 的视觉参考即可。

#### 能否在原有基础上改？——可以，也应当这样

实现路径：**从 `origin/master` 整目录恢复 `skills/frontend-slides/`，再改配方与附件，不要从零另写一套。** 保留有用的骨架（单文件、改已有 HTML、可选从 pptx 转网页、`viewport-base.css` 仅在用户要投屏时引用），改掉产品与离线都不允许的部分。

| 原结构 | 阶段 A 怎么处理 |
| --- | --- |
| description / When to use | 改为医学 HTML 展示；排除官网、React、可编辑 pptx |
| 零依赖、单文件 | **保留** |
| 强制每页 100vh + 密度表 | **改为可选**：仅当用户要投屏/全屏翻页时采用 `viewport-base.css` 与密度限制 |
| Phase 1–3 内容发现 + 三套风格预览 | **保留核心流程，改成医学问项与医学三套预览**（见下节）；不要删「先预览再生成」 |
| 设计美学（Clash Display、禁止系统字体） | **换成** `references/med-visual.md`：neutral + 蓝、系统字体栈（含中文回退）、禁止 CDN 字体 |
| `html-template.md` | **改一版**：浅色工作站变量、无外链字体；骨架不要写死只能 `.slide` |
| Phase 4 pptx→HTML | **可保留**（本地脚本，不与 `pptx` skill 抢「做可编辑 PPT」） |
| Phase 6 Vercel `deploy.sh` | **删除**（公网） |
| 导出 PDF | 若依赖本机无头 Chrome 再评估；阶段 A 可不强调，交付物就是 HTML |
| 输出位置 | 与办公 skill 对齐：`$PWD/exports/`；草稿 `$PWD/scratch/` |

#### Phase 1–3 如何改版（保留核心，换掉营销问项）

原流程要保留：**先问清楚再出三套可见预览，用户点选后再生成全文。** 人很难用语言描述「要哪种好看」，三套预览仍然值得留。

改的是问什么、预览长什么样、文件放哪，不是把 Phase 1–3 整段删掉。

**Phase 1 内容发现（一次 `ask_user_question` 问完，用户已说清的项可跳过）**

| 原问题 | 改版 |
| --- | --- |
| Purpose：Pitch / 教程 / 会议 / 内部 | **用途：** 病例展示 / 救治方案 / 数据一览 / 教学或交班 / 其它（自由说明）——这是内容用途，**不是**三种强制版式 |
| Length：5–10 / 10–20 / 20+ 页幻灯片 | **篇幅：** 一屏摘要 / 中等（可滚动或数屏） / 较长完整材料 |
| Content：材料是否齐 | **保留** |
| Inline editing + localStorage | **保留为可选**；默认「否」（共用机器避免串数据）。选「是」时只写在本机浏览器，配方写明不要当云同步 |
| 工作区图片扫描与取舍 | **保留**；预览里的小图可用相对路径或小图 base64，定稿默认相对路径 |

用户一句话已经包含用途和材料时，不要再把四问走完。

**Phase 2 风格预览（保留「先看后定」，2026-08-31 按实测收敛为一份三段）**

- 生成 **一份** `$PWD/exports/preview/风格预览.html`，内含三段并列变体，用户看完选 A/B/C 或「混合」。**不再**写三份独立文件：本机模型逐份生成四个完整 HTML 太慢。
- 三段共用同一骨架与同一段示例内容，只有 CSS 变量不同（`.v-a` / `.v-b` / `.v-c`）；整份约 150 行内，无注释、无脚本、无图。
- **必须放在 `exports/` 下**：对话文件卡片只收集 `inbox/` 与 `exports/`（`VISIBLE_ARTIFACT_ROOTS`），写到 `scratch/` 用户在对话里看不到，只能去 Files 面板翻。
- **不要**再用 `STYLE_PRESETS.md` 里的 Neon Cyber、Pitch 营销预设。三套变量写进 `references/med-visual.md`，按信息密度/阅读距离命名（不用主题名、不用办公词）：  
  - **A 信息密（近读）：** 浅底、蓝强调，单屏信息更多  
  - **B 高对比大字（远看）：** 同为浅底，字号与对比更大、装饰更少；投屏用这套  
  - **C 深色低亮（暗光）：** 深底高对比，仍禁止霓虹/紫渐变  
- **不要**用 browser-use 自动弹窗；给路径即可（卡片可一键预览）。
- 「我知道要哪套」：Phase 1 的一次提问里就含「风格怎么定」，选直接用某套则整段跳过 Phase 2。

**Phase 3 生成全文**

- 用 Phase 1 的内容 + Phase 2 选中的风格，写交付 HTML 到 `exports/`。
- **不要**无条件塞入整份 `viewport-base.css`。仅当用户要投屏/全屏翻页，或选了「高对比大字（远看）」时再引用。
- 用户提局部意见时用 `edit_file` 改片段，不要整页重写（本机模型重写一页很慢）。
- 字体走系统栈，禁止 Fontshare / Google Fonts。
- 自由布局：不要因为出过三套预览就把定稿锁成幻灯片翻页。

#### 与 `pptx` 分流（必须写进配方）

| 用户说法 | 用 |
| --- | --- |
| PPT、幻灯片文件、可编辑、打印、带走 `.pptx` | **只** `pptx` |
| 网页、浏览器打开、投屏、展示页、HTML | **只** `frontend-slides` |
| 「两个都要」 | 可以各出一份；不要默认各出一份 |

#### 硬约束（自由布局也必须遵守）

- 视觉：PilotDeck 工作站（浅色 `neutral`、蓝强调、高对比）；禁止紫渐变、无信息装饰、禁止外链字体与脚本。
- 内容：只用来自 `$WS`、本轮用户口述、已调用 med-tools 的事实。禁止编造检验值、影像结论、剂量。缺项写「未提供」。
- 路径：交付 `$PWD/exports/`；禁止写仓库 `src/` / `ui/`。
- 图：默认相对路径指向工作区内文件；仅当用户明确要求「单文件拷走也能看」才 base64。
- 交互：允许翻页、目录锚点、Tab、折叠；禁止 `fetch`、公网、把数据写回 Gateway。
- 投屏（仅用户要求时）：一屏一块、页内不滚动、字号能投屏。
- 一览/看数（仅用户要求时）：优先卡片和表，少动效，禁止假图表库。

#### 落地步骤

1. `git checkout origin/master -- skills/frontend-slides`
2. 改 `SKILL.md`：触发、分流 pptx、自由布局默认、硬约束；**改版保留 Phase 1–3**（医学问项 + 三套预览）；投屏 CSS 按需；删 Phase 6 部署。
3. 新增 `references/med-visual.md`（含三套预览的色板/字号差）；改 `html-template.md`；`STYLE_PRESETS.md` 换成医学三套或删掉改引用 med-visual。
4. 删除或停用 `scripts/deploy.sh`；不要在配方里出现 Vercel / Google Fonts / Fontshare。
5. **不要**恢复 `skills/frontend-design/`。
6. 确认 Skills 页只有一条 `frontend-slides`，通用技能、只读、`global`。
7. 自测：要 PPT → `pptx`；要网页 → 先出现 scratch 下三套预览再出 `exports/*.html`；断网可打开；未说投屏时允许长页滚动。

**实施记录（2026-08-31）：** 已从 `origin/master` 恢复 `skills/frontend-slides/` 并按上表改配方；删除 `scripts/deploy.sh`；新增 `references/med-visual.md`；未恢复 `frontend-design`。对话产物收集已包含 `.html`。

**首轮实测后的修正（同日）：** 三份预览合成一份 `exports/preview/风格预览.html`；三套风格改按密度/距离命名；Phase 1 一次问完（含风格选法），选定即跳过预览；定稿微调走 `edit_file`。原因：本机 `Qwen3.8-27B` 上「四份完整 HTML + 两轮提问」耗时过长，且 `scratch/` 下的预览不进对话卡片、用户看不到。

### 2.2 阶段 B — Plan 模式工具（改 `enter_plan_mode` / `exit_plan_mode`）

**目标：** 多需求任务（例如：解析附件 → 出方案 → 再出 HTML/PPT）时，同一对话模型先进入只读计划，写清步骤与依赖，**用户确认后再执行**。不是换「plan 模型」，不是路由里的第二套 LLM。

**原机制（保持）：**

1. `enter_plan_mode` → `permissionMode = plan`。
2. 只读：`read_file` / `grep` / `glob`；只允许在计划目录写 markdown；禁止用 bash 改业务文件。
3. `exit_plan_mode(plan_file_path)` → 问用户：继续改计划 / **开始执行** / 取消。
4. 用户选执行 → 恢复可写工具，并应先 `todo_write` 再动手。

**必须改的文案与批准后行为（相对 master）：**

| 原厂（编码 Agent） | 本产品 |
| --- | --- |
| 探索代码库、设计实现 | 探索工作区附件、exports、医学/办公 skill 是否适用 |
| 批准后 *start coding* | 批准后按计划 `read_skill`、调 `mcp__med-tools__*`、写 `$WS` |
| 计划目录偏 `.pilotdeck/plans` | 保持现有计划目录机制即可；确保 Files 能看到计划文件 |

**不要：** 批准后仍保持只读（那就永远不执行）；也不要在未改文案时直接注册，否则模型会按改代码来用。

#### 建议落地方式

1. 从 `origin/master` 恢复 `planMode.ts` 及 `createBuiltinRegistry` 中的注册（`planMode !== false` 默认打开）。
2. 改 `ENTER_PLAN_MODE_DESCRIPTION` / 激活后「What To Do」/ `buildApprovedPlanResult`：去掉 coding，改成医学工作站多步骤。
3. 提示词（`PromptAssembler`）在无 web 工具的离线策略块中：多文件、多步骤、多种产物时优先 `enter_plan_mode`。
4. 自测：多需求一句话 → 进入 plan → 只出现计划文件 → 点执行后才出现解析/写文件；点继续规划则不写业务文件。

**实施记录（2026-09-01）：** 已从 `origin/master` 恢复 `src/tool/builtin/planMode.ts`，并在离线 `createBuiltinRegistry` 中默认注册 `enter_plan_mode` / `exit_plan_mode`（受限 host 可传 `planMode: false`）。Web 对话允许模型主动提出进入计划模式；IM 频道原有的禁用策略不变。工具描述、计划中提醒、运行时拦截提示和审核面板文案均已改为「查看工作区材料 → 判断医学 MCP / RAG / 办公 skill → 用户批准后处理业务产物」，去掉探索代码库与 start coding。多材料 + 医学处理 + 多交付物时优先规划，简单问答和单一明确产物直接执行。

**缺陷修复（2026-09-01，`exit_plan_mode` 被自身规则拦截）：** 首次实测中模型写完计划后调用 `exit_plan_mode`，得到 `TOOL_ERROR[plan_mode_violation]`。原因是离线化裁剪 `PLAN_MODE_ALLOWED_TOOLS` 时，连同 `web_search` / `web_fetch` / `agent` / `task_*` 一起把 `exit_plan_mode` 也删掉了（当时 plan 工具尚未恢复）。后果是审核卡片永远不会出现，模型只能在正文里自称"已提交审核"，下一轮恢复成 agent 模式后直接开始执行，等于绕过了整个批准闸门。已把 `exit_plan_mode` 加回白名单，并在 `tests/tool/plan-mode-medical.spec.ts` 增加断言。`enter_plan_mode` 与上游一致不在白名单内（plan 模式下重复调用由运行时拦截提示处理）。

**补充实施（2026-09-01，输出语言）：** 实测本地模型的思考过程仍是英文。原因不在 plan 工具文案（已中文化并已生效），而在两点：一是整条提示词没有任何语言约束，二是内置工具描述与参数说明仍是英文，token 量远超已中文化的部分，把模型带回英文推理。处理办法：

1. `systemPromptCopy.ts` 新增 `languageTitle` / `languageBody`，由 `PromptAssembler.buildDefaultSystemPrompt` 紧跟身份两行注入，明确要求思考过程、回复、待办、提问、计划与文档一律用简体中文，并声明工具说明或工具返回为英文不改变输出语言；工具名、参数名、路径、命令、代码、引用原文保持原样不译。EN 备份同步给出对应英文版本（跟随用户语言）。
2. 中文化 8 个高频内置工具的 description 与 inputSchema 字段说明：`read_file`、`write_file`、`edit_file`、`bash`、`grep`、`glob`、`todo_write`、`ask_user_question`。只译自然语言，保留工具名、参数名、枚举值、`BASH_RESULT[...]`、`- [x]` 等字面量与阈值。
3. 回归：新增 `tests/context/prompt-output-language.spec.ts`（校验提示词含语言约束、8 个工具描述为中文且不再保留英文 Usage 块）；`tests/context/prompt-automation-policy.spec.ts` 的 `declarative` 断言放宽为 `声明式|declarative`。`tests/tool/tool-result-workspace-path.spec.ts` 在干净分支上同样失败，属沙箱 HOME 布局导致的既有问题，与本次无关。

**补充实施（2026-09-01，CDA 结构解析 + 主 Agent 续跑）：** 实测批准计划后 `med_parse_medical` 一成功就停，病例报告/HTML 未做。根因不是 G9「默认结束任务」，而是 `PluginToToolBridge` 对 `med_parse_medical` 写死 `endTurn: true`：`ok+report` → `directFinalAssistantText` → `AgentLoop` 硬 return。同时 CDA 检验 XML 只有裸 value 串，模型靠 grep/python 补解析且撞上自动化策略。处理办法：

1. 在现有 `med-tools` 增加 `server/cda_parser.py`，由 `parsers.py` 的 `ClinicalDocument` 分支调用；抽取 CLUSTER 化验项（`检验项目代码` / `检验定量结果` / `检验结果代码`）、observation 配对、BATTERY 血压等。优先用 CD `code`（如 `cTnI`）；仅有院内码时标注「项目名称未提供」，禁止按顺序猜测。不新增 MCP 工具。
2. `med_parse_medical` 增加显式 `continuation_mode`：`terminal`（默认，纯解读可终局）/ `material`（多步骤材料，流式后继续主 Agent）。`agent_continue` 仍只表示「G9 未形成报告需主 Agent 接手解读」。
3. `PluginToToolBridge` 按入参/返回的 `continuation_mode` 动态决定是否设 `directFinalAssistantText`；`med-medical` 用 terminal，`med-case-report` / `med-trauma-stage-plan` 先 parse 时用 material；计划批准提示强调 material 后继续未完成项。
4. 回归：`tests/test_cda_parser.py`、continuation payload 测试、`plugin-to-tool-bridge-continuation.spec.ts`、AgentLoop material 续跑测试；8 份附件 batch `skip_vlm` 验收 CDA 为 `ready` 且 summary 含 `cTnI`。

### 2.3 阶段 C — 用户自创 Skill（对话 + Skills 页 → `$PILOT_HOME/skills/`）

**排期：** 阶段 B 完成后再做。本阶段不是恢复 `skill-creator`。

**目标：** 用户把本机重复流程沉淀成 **user skill**，落盘 `$PILOT_HOME/skills/<slug>/`，与仓库内置 skill、医学插件 skill 一起出现在 `<available-skills>`，下一轮对话可 `read_skill`。不从 ClawHub / 公网 skill 市场安装。

**存储与加载（已有，阶段 C 只补入口与纪律）：**

- `SkillManager` user 范围 = `$PILOT_HOME/skills/`
- `PluginRuntime` 已扫描 `globalSkillsDir`；同名 user 覆盖 builtin
- HTTP `POST /api/skills/create`、Gateway `skill_create` 已有
- 对话里的 `write_file` **不能**直接写 `$PILOT_HOME`（默认工作区沙箱）。创建必须走 SkillManager，然后 `reloadExtensions`

**两个入口，同一落盘：**

| 入口 | 做什么 |
| --- | --- |
| Skills 页 | 新建向导：名称、何时触发（`description`）、步骤正文、归属；保存即 create + 刷新。这是主入口。不要用 `frontend-slides` 的 HTML 当安装界面（那是工作区 `exports/`，不是 skill 目录） |
| 对话 | 短配方：访谈 → 预览 `SKILL.md` → 用户确认 → 调创建 RPC。例如「把刚才出交班页的步骤做成我的技能」 |

**不要**从 `origin/master` 的 `skill-creator` 改版恢复。那是评测工厂（子 Agent、对照实验、浏览器评测页、`claude` CLI）。本产品只借文案原则：`description` 写清触发、先确认再写盘、禁止误导性 skill。不拷脚本、eval-viewer、打包 `.skill`。

#### 代码策略（已定）：允许本地代码，禁止任何下载

自创 skill **可以**带脚本（如 `scripts/*.py`），由现有 `bash` 在工作区执行。硬约束：

- **禁止联网获取任何东西：** `curl` / `wget`、`pip install` / `npm install` / `npx`、克隆仓库、拉模型、热加载远程配置。缺依赖就停并告诉用户，不要下场下载。
- **只准用镜像/本机已有的解释器与库：** 系统 `python3`、标准库、离线包预装的白名单（若有）、以及已有办公 skill 的捆绑入口（`pdf.sh` 等）。**不要**假定用户脚本自动进办公 skill 的隔离 venv。
- **禁止新二进制、禁止覆盖系统 slug**（`pdf`、`med-medical` 等只能走显式「用户覆盖」）。
- 配方不得诱导出网、不得替代 `med_parse_medical`、不得让 Agent 改仓库 `src/` / `ui/`。
- 导入/创建时继续拦危险扩展名与体积上限；脚本须可在断网环境跑通。

**在这种约束下能不能做出好用的 skill？——可以，但好用的形态是「流程胶水」，不是「新引擎」。**

| 能做好 | 做不好（不要引导用户去做） |
| --- | --- |
| 纯配方：固定问项、固定 `exports/` 命名、固定先解析再出 HTML/PPT | 新的医学解析器、新的 Office 内核（那是捆绑环境 + 产品 skill） |
| 小脚本：把已有 `med-tools` JSON/CSV 转成科室表头、按本地模板填数、批量改名 | 运行时 `pip`/`npm` 才能跑的库、新浏览器、新 ASR |
| 编排已有工具：`read_skill pdf` + 本地 Python 拼目录 | 需要公网字体、CDN、在线 API 的页面生成 |

现场重复劳动（交班页结构、某类表格清洗、固定检查清单）用配方 + 可选本地脚本就够。办公五件套那种隔离运行时，继续用内置 skill，自创 skill 去 **调用** 它们，不要重写。

#### 建议落地方式

1. Skills 页补「新建」向导（调现有 create API），创建后 `reloadExtensions`。
2. 新增一条很短的 user-scope 配方（名称另定，不要叫 `skill-creator`）：只负责访谈/预览/确认/调用创建；写明无网、可带本地脚本、禁止安装包。
3. 创建路径校验：slug、禁覆盖内置、脚本无出网、无危险扩展名。
4. 自测：页上新建一条「交班 HTML 固定结构」→ 新对话能 `read_skill` 并按配方出 `exports/`；带 `scripts/foo.py` 的 skill 断网可跑；配方里写 `pip install` 的应被拒或执行失败且不下载。

---

## 3. 建议观察后再做（本轮文档只登记，不实现）

两件都是增强，依赖阶段 A 或真实痛点出现。

### 3.1 白名单版 `browser-use`（Agent 检查本地 HTML 排版）

**可能的价值：** 阶段 A 生成 HTML 后，模型自己打开页面、截图、改 CSS，减少操作员来回预览。

**不是：** 给用户新开浏览器标签。那件事 Files 已经做了（`window.open` 预览 HTML）。

**若做，硬条件：**

- URL 只允许 `file://` 工作区 HTML，或本机 Files 预览 origin；禁止公网。
- Chromium 打进离线包，禁止运行时 `install:browser`。
- 与 frontend skill 搭配：先写 HTML，再用浏览器检查，再 `edit_file`。

**何时做：** 阶段 A 上线后，若明显出现「模型看不见版式、改不准」。未出现则不做。

### 3.2 受限版 `execute_code`

**它是什么：** 模型提交一段 Python，Gateway 在工作区起**一个进程**跑完。可 `for` 循环许多文件。默认把源码放在工具参数里执行，不必落盘 `.py`。

**它不是：**

- 并行两个 Agent（不会同时「解析」+「处理」）。
- 医学解析器。原白名单**不含 MCP**，不能替代 `med_parse_medical`。
- 比 bash 更安全的保险箱。无网、无 bash helper、限可写路径之后，仍是任意 Python。

**若做，硬条件：**

- 无网；`pilotdeck_tools` **不要** `web_search` / `web_fetch` / `bash`。
- 可写路径仅 `$WS`。
- 预装白名单库（如 pandas、json、pathlib），禁止 `pip install`。

**适合：** 解析结果已在工作区后，对多份 JSON/CSV 做同一套清洗、汇总、出表。  
**不适合：** 「一次很多检查要逐个医学解析」——应做批处理 MCP 或主循环多次 `med_parse_medical`。

**何时做：** 阶段 A/B 之后，若 bash 处理多表/多 JSON 明显笨。未出现则不做。

---

## 4. 明确不做的「改版想法」

### 4.1 新 summarize Skill（只工作区、现场模型、禁 URL）

不单独做。Skill 不会新增总结引擎，只是纪律条款。

单份病历：`med-medical` + 主模型已在解读。整包工作区摘要：用户说「总结当前工作区」或系统提示里几条规则即可（只扫 `$WS`、禁止 URL）。等出现「经常漏文件 / 乱总结网页 / 结构不稳定」再写「工作区目录摘要」配方。

**禁止**恢复原厂 `summarize`（公网 CLI）。

### 4.2 会议助手

不做。见 §1.1。若将来做：浏览器录音上传 + 现场 ASR，新写，不还原 Google 版。

### 4.3 himalaya

不做。有内网 IMAP/SMTP 再立项。

---

## 5. 实现顺序与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **A** | **配方已落地（2026-08-31）** | 见 `skills/frontend-slides/`；对话验收需重启 gateway 后试一轮 |
| **B** | **已落地（2026-09-01）** | 多需求先计划；确认前仅可查看材料并写 `.pilotdeck/plans/*.md`；确认后先 `todo_write`，再按计划调医学/办公工具 |
| **C** | 用户自创 skill（Skills 页 + 对话；可本地脚本、禁止下载） | `$PILOT_HOME/skills/` 出现新目录；刷新后模型能 `read_skill`；断网可跑；不恢复 `skill-creator` |
| D（观察） | 白名单 browser-use | 仅本地 HTML；离线包含浏览器 |
| E（观察） | 受限 execute_code | 无网无 bash helper；不能当医学解析批处理 |

每阶段自测通过再开下一阶段。A/B 完成后在本文「状态」处改为已完成，并回写 [`offline-deployment-plan.md`](./offline-deployment-plan.md) 若有偏差。

---

## 6. 对照速查

| 项 | 处置 |
| --- | --- |
| 办公 5 skill、`frontend-slides`、医学 skill、9 类本地工具、med-tools MCP | 保持 |
| SaaS / 公网 skill、原 summarize、会议助手、himalaya、github、browser-use 公网版 | 不恢复 |
| `web_*` `agent` `task_*` `edit_notebook` `structured_output` `send_attachment` | 不恢复 |
| `frontend-slides` | **阶段 A 已改版落地**（一条、通用、自由布局、三套医学预览） |
| `frontend-design` | **不恢复**（视觉并进 slides 的 `med-visual.md`） |
| `enter_plan_mode` `exit_plan_mode` | **阶段 B 已改版恢复**（2026-09-01） |
| 用户自创 skill（`$PILOT_HOME/skills/`） | **阶段 C**（页 + 对话；可本地代码、禁止任何下载；不恢复 `skill-creator`） |
| 白名单 browser-use、受限 execute_code | 观察（阶段 D / E） |
| 新 summarize skill | 不做（用现有读文件 + 提示） |
