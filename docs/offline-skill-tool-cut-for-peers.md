# PilotDeck 离线化：内置 Skill / 内置工具对照

## 1. 先分清三层，避免砍错


| 层                     | 是什么                                                                          | 谁加载                           |
| --------------------- | ---------------------------------------------------------------------------- | ----------------------------- |
| **内置 Skill**          | `skills/<name>/SKILL.md` 配方。模型用 `read_skill` 读全文，再按配方去调工具（常见是 `bash` 跑捆绑脚本）。 | 仓库 `skills/`，也可被用户目录 / 项目目录覆盖 |
| **内置工具**              | Gateway 注册给模型直接调用的函数（`read_file`、`web_search` 等）。                            | `createBuiltinRegistry`       |
| **插件 Skill / MCP 工具** | 业务插件自带的配方和工具，例如本仓库把领域能力放在 `plugins/<name>`。                                  | 插件系统，**不是**上表「内置」             |


插件这层与是否离线无关：你的领域能力（办公、运维、某行业）应留在插件里，**不要复制进根目录** `skills/`。本仓库的医学三条 Skill 就是这个模式。

ClawHub、browser-use、IM 适配器、遥测，也不是「内置工具」，但同样是公网入口，见第 4.1 节与第 6 节。

---



## 2. 原厂内置 Skill：各自干什么

上游捆绑在仓库 `skills/` 里。名称以目录名为准。

### 2.1 本地文档 / 图示（通常可离线）


| Skill           | 作用                                               |
| --------------- | ------------------------------------------------ |
| `pdf`           | 本地读、建、改、合并、渲染、校验 PDF（捆绑 `pdf.sh` + 隔离 Python 环境） |
| `docx`          | 本地读、建、改 Word                                     |
| `pptx`          | 本地读、建、改 PowerPoint                               |
| `spreadsheets`  | 本地读、建、改 xlsx/csv 等                               |
| `diagram-maker` | 在工作区生成 SVG / HTML / Excalidraw 图                 |


这五个**不要求公网**。系统依赖（LibreOffice、Poppler 等）需打进离线包或在目标机预装。文档类 Skill 如何调用 `*.sh`、为何必须留 `bash` 并做加固，见 6.1。

### 2.2 明确依赖公网或云 SaaS


| Skill                        | 作用               | 为何出网                          |
| ---------------------------- | ---------------- | ----------------------------- |
| `weather`                    | 查天气              | `curl wttr.in`                |
| `github`                     | 仓库/Issue/PR 操作   | GitHub API / `gh`             |
| `browser-use`                | 用浏览器操作任意页面       | Playwright，任意 URL             |
| `notion`                     | Notion 读写        | 云 SaaS                        |
| `trello`                     | Trello 看板        | 云 SaaS                        |
| `1password`                  | 密码库              | 云 SaaS                        |
| `gog`                        | Google Workspace | OAuth + 谷歌 API                |
| `himalaya`                   | 邮件               | IMAP/SMTP（通常公网邮箱）             |
| `blogwatcher`                | 盯 RSS / 博客更新     | 公网 RSS；安装也常需联网                |
| `find-skills`                | 发现并安装更多 Skill    | `npx skills`、skills.sh 一类公网目录 |
| `summarize`                  | 摘要网页或视频          | 公网 URL / YouTube              |
| `meeting-recorder-assistant` | 录音、转写、出会议纪要      | 转写默认走 **Google 公网语音识别**（见下）   |




#### `meeting-recorder-assistant`：必须出网，不适合离线

这不是 Gateway 内置录音，而是捆绑的 Python 小脚本：

1. `pyaudio` 从麦克风录成 WAV
2. `speech_recognition.recognize_google(..., language='zh-CN')` **把音频发到 Google 语音识别**
3. 再在转写文本上抽纪要、待办

`requirements.txt` 里还有 `openai`。Skill 文案写了说话人分离、情感分析，脚本并没有自带离线 Whisper / 本地 ASR。

因此：看起来像本地会议助手，**转写这一步默认打公网 Google**。离线现场必须删除。若以后要会议纪要，应接现场 ASR，不要把这个 Skill 加回来。

### 2.3 不一定依赖公网（本仓库现场：其中 coding / 桌面项建议删，见 4.2）


| Skill                                                                                         | 作用               | 说明                                                           |
| --------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| `apple-notes` / `apple-reminders` / `bear-notes`                                              | 苹果生态笔记/提醒        | 绑 macOS / 账号                                                 |
| `powershell`                                                                                  | Windows 脚本       | 非 Linux 现场                                                   |
| `tmux`                                                                                        | 终端会话             | 本地，但是终端工作站场景                                                 |
| `obsidian`                                                                                    | 对接 Obsidian 桌面笔记 | 笔记文件可在本地，但 **依赖正在运行的 Obsidian App + 官方 CLI**，不适合无桌面的离线现场（见下） |
| `frontend-design` / `frontend-slides` / `web-design-guidelines` / `react-next-best-practices` | 做网站 / 前端规范       | 本地配方，偏开发 Agent                                               |
| `karpathy-guidelines` / `skill-creator` / `pilotdeck-skills-migration` / `spike`              | 写 Skill、迁移、试探    | 开发向                                                          |




#### Obsidian Skill 在做什么（不适合离线现场）

[Obsidian](https://obsidian.md) 是一款桌面笔记软件：一个「库」就是本机一棵以 Markdown 为主的文件夹（双向链接、日记、待办）。文件可以只存在本地，**不等于** PilotDeck 内置了一套知识库或向量检索。

原厂 `obsidian` Skill 只是教模型去调 **Obsidian 官方 CLI**（`obsidian search` / `create` / `read` 等）。硬性前提：

- 本机已安装 Obsidian 桌面版，并打开「Command line interface」
- `obsidian` 在 PATH 上
- **桌面 App 必须正在运行**（CLI 连的是这个进程，不是独立引擎）

Linux 离线包通常没有这套图形环境和操作员工作流。即使 `.md` 在磁盘上，没有正在运行的 Obsidian，该 Skill 也不能用。离线交付应删除，不要把它当成「可离线的本地知识库」。

---



## 3. 原厂内置工具：各自干什么

注册名以 Gateway `createBuiltinRegistry` 为准。`write_file` 与 `edit_file` 是两个工具、同一类能力。

### 3.1 本地工作区（通常可离线）


| 工具                  | 作用                                                        |
| ------------------- | --------------------------------------------------------- |
| `read_file`         | 读工作区文件                                                    |
| `write_file`        | 新建文件                                                      |
| `edit_file`         | 按片段改已有文件                                                  |
| `glob`              | 按文件名模式列目录                                                 |
| `grep`              | 文件内容搜索                                                    |
| `bash`              | 在工作目录执行一条本机 shell。文档类 Skill 的 `*.sh` 靠它启动（见 6.1，**必须加固**） |
| `read_skill`        | 把指定 Skill 的 `SKILL.md` 读进上下文                              |
| `todo_write`        | 多步任务清单（给模型自己用，不出网）                                        |
| `ask_user_question` | 向用户弹出结构化提问                                                |
| `get_current_time`  | 本机时区时间                                                    |




### 3.2 明确出网


| 工具           | 作用                                                     |
| ------------ | ------------------------------------------------------ |
| `web_search` | 公网搜索                                                   |
| `web_fetch`  | 抓任意 URL。注意：只关 Search 开关时，`web_fetch` **仍可能被注册**，必须一起处理 |




### 3.3 不一定出网，但会放大失控面或绑定开发场景


| 工具                                                                      | 作用                     | 备注                                                                                     |
| ----------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `execute_code`                                                          | Python 沙箱              | 沙箱本身可本地跑；**原实现可回调** `web_search` **/** `web_fetch`                                     |
| `agent`                                                                 | 主对话再 fork 一个子 Agent 会话 | 对话产品用一个会话、主模型逐步调 MCP/文件工具就够。`todo_write` 足够标「先解析附件、再出方案」。没有「同时跑两个业务任务」的产品需求时，**建议删除**。 |
| `enter_plan_mode` / `exit_plan_mode`                                    | 计划模式                   | 偏写代码工作流                                                                                |
| `task_create` / `task_list` / `task_output` / `task_wait` / `task_stop` | 后台长任务                  | 本地，但是运维/构建场景                                                                           |
| `edit_notebook`                                                         | 改 Jupyter              | 本地，数据科学场景                                                                              |
| `structured_output`                                                     | 非交互宿主的 JSON 终态         | 本地，给程序调用而不是给人聊                                                                         |
| `send_attachment`                                                       | 把文件发回当前频道              | 主要为 IM（飞书/企微等），不是对话页刚需                                                                 |


插件 MCP 工具（`mcp__<plugin>__<tool>`）不算内置工具，按你的业务插件保留即可。

---



## 4. 建议怎么砍：两栏

先按出网砍死（4.1），再按本仓库产品形态砍 coding（4.2）。只有另做编程助手时，才把 4.2 删除列改回保留。

### 4.1 离线必须去掉（公网 / SaaS / 任意网页）

**Skill（整目录从交付包的** `skills/` **删掉，并确保** `$PILOT_HOME/skills` **没有旧副本）：**

`weather`，`github`，`browser-use`，`notion`，`trello`，`1password`，`gog`，`himalaya`，`blogwatcher`，`find-skills`，`summarize`，`meeting-recorder-assistant`（Google 语音识别）

无桌面 Obsidian 的离线现场也应删除 `obsidian`（见 2.3），不要把它算成「可离线的本地知识库」。

**内置工具（停止注册；建议连实现一并删，避免测试或配置又挂回去）：**

`web_search`，`web_fetch`

**相关公网入口（不是工具，但同等必须关）：**

- ClawHub 搜索/安装（公网装 Skill）——步骤 2 已藏 UI；**管道删除见 6.2**
- Skills 页「从网上 import / 新建后再去下 SaaS 配方」一类入口
- `install:browser` / 内置 `browser-use` 插件
- 默认遥测上报（原厂可能打到公网遥测域名）
- 默认 IM 适配器（飞书/企微/微信等到公有云）
- Onboarding 默认指向 OpenRouter / OpenAI 公网 Key；应改成「只填自定义 OpenAI 兼容 URL」——**模型目录 UI 口径见 6.3**

只关 `tools.webSearch.enabled` **不够**：`web_fetch` 仍可能在。要以「模型工具列表里根本没有这两个名字」为准。

### 4.2 本仓库建议（对话 + 本地文档 + 领域插件，不是编程 Agent）

现场产品不是「写代码的 Agent」。**凡跟 coding / 开发工作流相关的，一律建议删除。** 只有当你另交付一套编程助手，才回头看 2.3 / 3.3 里「什么时候留」。

**建议保留（本地办公，不要求公网）：**


| 项        | 例子                                                                                                                                           | 说明                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 文档 Skill | `pdf` `docx` `pptx` `spreadsheets` `diagram-maker`                                                                                           | 对话里读/改/生成 Office 与 PDF。底层脚本是本机 Python，见 6.1   |
| 3.1 本地工具 | `read_file` / `write_file` / `edit_file` / `glob` / `grep` / `bash` / `read_skill` / `todo_write` / `ask_user_question` / `get_current_time` | 文档 Skill 目前靠 `bash` 调 `*.sh`；领域能力走插件 MCP，不走这些 |


**建议删除（coding、开发工作站、放大失控面）：**


| 项                   | 例子                                                                                                                                                                 | 原因                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 前端 / 开发 Skill       | `frontend-design` `frontend-slides` `web-design-guidelines` `react-next-best-practices` `karpathy-guidelines` `skill-creator` `pilotdeck-skills-migration` `spike` | 写网站、写 Skill、试探仓库，现场操作员不需要                              |
| 平台 / 桌面 Skill       | `tmux` `powershell` `apple-notes` `apple-reminders` `bear-notes` `obsidian`                                                                                        | 不是 Linux 无桌面现场；`obsidian` 见 2.3                        |
| `execute_code`      | Python 沙箱                                                                                                                                                          | 编程沙箱；原实现还能回调 `web_search` / `web_fetch`                |
| `agent` 子 Agent     | 主模型再 fork 一套 Agent 循环                                                                                                                                              | 编程助手「去探索仓库 / 去写计划」用；不是多聊天窗口。对话产品一个会话 + `todo_write` 即可 |
| 计划模式 / 后台任务         | `enter_plan_mode` `exit_plan_mode` `task_*`                                                                                                                        | 编码与后台构建工作流                                             |
| `edit_notebook`     | Jupyter                                                                                                                                                            | 数据科学写代码                                                |
| `structured_output` | 非交互 JSON 终态                                                                                                                                                        | 给程序宿主，不是给人聊                                            |
| `send_attachment`   | IM 发文件                                                                                                                                                             | 只留 Web/CLI 对话时不需要                                      |


本仓库默认砍法与上表一致：通用 Skill 只留 5 个文档类；内置工具只留 3.1 那 10 个名字；上表「建议删除」整列从交付包拿掉。

---



## 6. 步骤 2 收尾改造（已完成，2026-08-20）

步骤 2 已把公网 Skill / `web_*` / coding 工具从交付面拿掉。下面几项是**已确认、已在代码中落地**的收尾（2026-08-20）。

### 6.1 `bash` 出网：命令黑名单 + 提示层补充 — **已完成**

- `src/tool/builtin/bash/permissions.ts`：deny `curl` / `wget` / `pip install` / `npm install` 等
- `PromptAssembler.ts`：离线部署策略块（无 `web_search`/`web_fetch` 时）
- `bash.ts` 工具描述：写明禁止出网命令
- 5 个文档 Skill 文案已扫（无 curl/pip 等出网表述）

### 6.2 ClawHub 管道 — **已完成**

- 删除 `/api/skills/clawhub/*`（`ui/server/routes/skills.js`）
- 删除 `/skill_install` 命令与 handler（`ui/server/routes/commands.js`）
- 删除 SkillsV2 New/ClawHub/Import/Create 死代码
- 删除 chat `skillInstall` 分支

### 6.3 模型目录 UI（方案 B）— **已完成**

- Onboarding / Settings 模型 UI 以 `pilotdeck.yaml` 已配置 provider 为主展示
- 仍允许添加自定义 OpenAI 兼容 URL；不再展示 OpenRouter 等公网厂商目录网格

### 6.4 `autoOrchestrate.allowedTools` — **已完成**

- bootstrap 与 `.pilotdeck-home/pilotdeck.yaml` 已从 `allowedTools` 去掉 `agent`
- `autoOrchestrate.enabled: false` 保持不变

### 6.5 `$PILOT_HOME/skill-backups` — **已确认**

- Skill 加载不扫描 `skill-backups/`（`SkillManager` 仅 builtin/user/project/medical）
- 交付 tar 排除该目录（见 `offline-deployment-plan.md` 步骤 5）

### 参考：文档 Skill 为何仍保留 `bash`

文档类 Skill 通过包内 `*.sh` 调本机 Python（如 `skills/pdf/scripts/pdf.sh`），不是操作员手敲命令，也不是现场 `pip install`。出网风险来自通用 shell，因此用命令黑名单 + 提示词双层加固，而不是删除 `bash` 工具。