# 工作区目录重组方案

/status: **已实施（2026-08-27）**。运行时文件迁入 `$HOME/workspaces/<id>/`；旧绝对路径通过软链兼容。

日期：2026-08-27

相关文档：

- 离线 Skill / 工具裁剪：[`offline-skill-tool-cut-for-peers.md`](./offline-skill-tool-cut-for-peers.md)
- 离线交付步骤：[`offline-deployment-plan.md`](./offline-deployment-plan.md)
- 附件与记忆现状：[`memory-attachment-flow-guide.zh.md`](./memory-attachment-flow-guide.zh.md)

---

## 1. 目标

一次重组要同时解决两件事，且必须拆开做：

1. **仓库变干净**：源码、领域插件、运行时数据、临时文件分开；空目录和缓存可扔。
2. **一次会话的文件有家**：用户上传附件和 Agent 产物不要散落在 `PILOT_HOME`、`.tmp`、`exports/`、插件目录里，而是落在「当前工作区」的固定子目录。

**不做的事：** 不把 `plugins/med-tools` 合并进根目录 `skills/`。配方（Skill）和运行时（Plugin）不是一类东西。

---

## 2. 现状：叠了多套「工作区」

| 层 | 实际位置 | 装什么 |
| --- | --- | --- |
| Git 仓库 | 仓库根 | 引擎、`skills/`、`plugins/med-tools` |
| 运行时家目录 | `.pilotdeck-home/`（`PILOT_HOME`） | `pilotdeck.yaml`、会话 jsonl、记忆；通用对话还把这里当 cwd |
| Agent cwd | 通用对话 = **整个 `PILOT_HOME`** | 因此 `exports/`、手写 `.py` 直接堆在配置目录里 |
| 上传附件 | `<cwd>/.tmp/chat-attachments/<批次>/` | 通用对话就在 home 下；multer 还先写系统 tmp |
| 轮次草稿 | `<cwd>/.pilotdeck/work/<session>/<turn>/`（`PILOTDECK_WORK_DIR`） | 文档 Skill 的中间 JSON / QA |
| 记忆工作区 | `$HOME/memory/workspaces/<hash10>/` | 白盒记忆，与磁盘上的用户文件不是同一棵树 |
| Always-On | 另有 worktree / snapshot | 与对话产物无关，本文不合并 |

文档 Skill 默认写 `$PWD/exports/`。通用对话的 `$PWD` 就是 home，所以配置、附件、报告、Agent 手写脚本挤在一起。这是「文件找不到家」的根因，不是 Skill 目录分开放的问题。

---

## 3. 三个根目录（约定）

| 符号 | 含义 | 本仓库现状示例 |
| --- | --- | --- |
| `$REPO` | Git 仓库，只读发布物 | `…/med-pilotdeck` |
| `$HOME` | `PILOT_HOME`：配置 + 会话 + 记忆 | `$REPO/.pilotdeck-home` |
| `$WS` | 当前工作区数据根；**Agent cwd 应指向这里** | `$HOME/workspaces/<id>` |

`<id>`：

- 通用对话：`general`
- 有前端项目：复用现有 `$HOME/projects/<projectId>` 的 slug（例如 `Users-william-Downloads-med-pilotdeck`），不要再编一套 ID

启动后只应依赖这三个根。禁止再把整个 `$HOME` 当作 cwd。

`.cwd` 标记仍可指向真实工程路径，只表示「关联哪个仓」，**不表示**附件和产物堆在仓根。

---

## 4. 不要把 med-tools 放进 `skills/`

| | 根目录 `skills/` | `plugins/med-tools` |
| --- | --- | --- |
| 是什么 | 通用文档配方 + 捆绑脚本 + 字体 | 主题插件：MCP、Python、RAG、venv |
| 怎么跑 | `read_skill` + `bash` 调 `*.sh` | `mcp__med-tools__*`；其中 `skills/med-*` 只是路由说明书 |
| 给谁 | 任何主题的 PilotDeck 都可复用 | 仅医学产品 |

若把 med-tools 整棵树搬进 `skills/`：

- 会破坏插件发现（扫的是 `$HOME/plugins` + 仓库 `plugins/`）
- 五个文档 Skill 的离线转交包会再次带上医学数据和 venv
- SkillManager 的 `builtin` / `medical` 分栏会缠在一起
- 非医学主题无法「只换插件、不动文档 Skill」

**目录策略：** 保持两层，只统一 UI 展示（通用技能 / 主题技能），不统一物理目录。

```text
skills/                      # 仅通用、可转交的文档技能
plugins/<theme>/             # 主题包
  plugin.json
  skills/                    # 只属于这个插件的配方
  server/  data/  .venv
```

主题换皮 = 换 `plugins/<theme>`，`skills/` 原样复用。

若只是嫌仓库根词太多，可以把仓库侧收成 `extensions/document-skills` + `extensions/med-tools`。那是改加载路径的重命名，收益有限，**优先级低于第 5 节的 `$WS`**。

---

## 5. 目标布局

```text
$HOME/                                    # 配置与系统态；Agent 默认不当 cwd
  pilotdeck.yaml
  auth.db
  server-token
  projects/<id>/chats/                    # 会话流水
  projects/<id>/.cwd                      # 可选：关联的真实工程路径
  memory/                                 # 长期记忆（第一期不搬家）
  plugins/med-tools -> $REPO/plugins/…    # 软链可保留
  workspaces/
    general/                              # 通用对话
      inbox/<batch>/                      # 用户上传
      inbox/<batch>/derived/              # 插件派生文件
      exports/                            # 用户交付物
      scratch/qa/                         # 声明式中间输入
      scratch/work/<session>/<turn>/      # 轮次草稿
      scratch/preview/                    # PNG / *-qa
    <projectId>/                          # 形状与 general 相同
      inbox/
      exports/
      scratch/

$REPO/                                    # 不进 git 的会话文件
  skills/{pdf,docx,pptx,spreadsheets,diagram-maker}/
  plugins/med-tools/
  .runtime/cache/xdg/                     # Skill 隔离运行时（与 Gateway 一致）
```

约定：

- 上传只进当前 `$WS/inbox/<batch>/`，不写 `plugins/med-tools/.tmp`，不把系统 tmp 当长期存储
- Skill `make --out` 默认 `$WS/exports/`；中间 spec 进 `$WS/scratch/`
- 文件树 / 下载卡片只扫 `inbox` + `exports`；`scratch` 折叠或默认不进卡片
- 打开真实代码仓时，cwd 仍可以是那个仓，但附件/产物仍建议进 `$HOME/workspaces/<id>/`，避免污染业务 git

记忆目录 `$HOME/memory/workspaces/<hash10>/` 第一期并存：一边是人看的文件，一边是笔记。以后可用同一 `<id>` 做索引，不必第一步合并。

---

## 6. 路径对照

### 6.1 工作区文件（本次要动）

| 用途 | 现状 | 建议 |
| --- | --- | --- |
| Agent cwd（通用对话） | `$HOME` | `$HOME/workspaces/general` |
| Agent cwd（某个项目） | 项目真实路径，或 `$HOME` | `$HOME/workspaces/<projectId>` |
| 用户上传（落盘） | `<cwd>/.tmp/chat-attachments/<batch>/` | `$WS/inbox/<batch>/` |
| 上传 multer 中转 | `os.tmpdir()/pilotdeck-chat-attachments/<userId>/` | 可保留作秒级中转，成功后立刻搬进 `inbox/`，失败即删 |
| 插件派生图/中间图 | 上传目录旁 `.med-tools-derived/`；有时写到 `$REPO/plugins/med-tools/.tmp/` | `$WS/inbox/<batch>/derived/` |
| 用户交付物 | `$PWD/exports/`（通用对话 = `$HOME/exports/`） | `$WS/exports/` |
| Skill 声明式输入 | `$PWD/exports/qa/` 或 `PILOTDECK_WORK_DIR` | `$WS/scratch/qa/` |
| 轮次内部草稿 | `<cwd>/.pilotdeck/work/<session>/<turn>/` | `$WS/scratch/work/<session>/<turn>/` |
| 页面预览 / `*.pdf-qa` | `$HOME/exports/.pdf-qa`、`exports/qa/` | `$WS/scratch/preview/` |
| Agent 手写脚本 | `$HOME/build_bingli_report.py` 等 | **不迁，删除** |
| 文件树 / 下载卡扫描 | 通用对话扫 home + 扩展名白名单 | 只扫 `$WS/inbox` + `$WS/exports` |

### 6.2 配置、会话、记忆（基本不动）

| 用途 | 现状 | 建议 |
| --- | --- | --- |
| 主配置 | `$HOME/pilotdeck.yaml` | 仍在 `$HOME` |
| 登录 / token | `$HOME/auth.db`、`server-token` | 不变 |
| 会话 jsonl | `$HOME/projects/<projectId>/chats/` | 不变；`<projectId>` 与 `$WS` 的 `<id>` 对齐 |
| 项目真实路径标记 | `$HOME/projects/<projectId>/.cwd` | 保留；通用对话不要用「cwd = `$HOME`」冒充项目根 |
| 长期记忆 | `$HOME/memory/workspaces/<hash10>/` | 第一期不变 |
| 插件软链 | `$HOME/plugins/med-tools` → `$REPO/plugins/med-tools` | 保留；运行时文件不要写到链过去的仓库目录 |
| 用户可写 skills | `$HOME/skills/`（现为空） | 离线产品可继续空着；不要复制 bundled skill |
| 仓库根误建的计划目录 | `$REPO/.pilotdeck/plans` | 删除 |

### 6.3 Skill / 插件源码（不合并）

| 用途 | 现状 | 建议 |
| --- | --- | --- |
| 通用文档 Skill | `$REPO/skills/{pdf,docx,pptx,spreadsheets,diagram-maker}/` | **不搬** |
| 文档字体 | `$REPO/skills/pdf/assets/fonts/` | **不搬**（docx/pptx/spreadsheets 相对引用） |
| 医学插件 | `$REPO/plugins/med-tools/` | **不搬进 `skills/`** |
| 医学配方 | `$REPO/plugins/med-tools/skills/med-*/` | 仍跟插件 |
| 医学 MCP / RAG / venv | `server/`、`data/rag/`、`.venv` | 仍跟插件 |
| Skill 隔离运行时 | `$XDG_CACHE_HOME/pilotdeck-*` 或 `$REPO/.runtime/cache/xdg/…` | 固定 `$REPO/.runtime/cache/xdg/pilotdeck-*`，与 Gateway 启动一致 |
| 本机试跑残留 | `$REPO/.runtime/diagram-test/` | 删除，不迁 |

### 6.4 系统临时 / 缓存

| 用途 | 现状 | 建议 |
| --- | --- | --- |
| LibreOffice 预览缓存 | `os.tmpdir()/pilotdeck-office-preview-cache` | 可继续用系统 tmp，或收到 `$HOME/cache/office-preview` |
| e2e 工作目录 | `$REPO/tests/skill-e2e/work/` | 保持 gitignore；定期清空 |
| Python 字节码 | `plugins/med-tools/**/__pycache__/` | 删除；已 ignore |
| 文档 Skill 转交包 | `$REPO/dist/pilotdeck-offline-doc-skills.tar.gz` | 本地产物，不进运行时路径 |

### 6.5 本机示例（通用对话）

| 现在 | 以后 |
| --- | --- |
| `$HOME/.tmp/chat-attachments/<batch>/` | `$HOME/workspaces/general/inbox/<batch>/` |
| 同上目录下 `.med-tools-derived/` | `…/inbox/<batch>/derived/` |
| `$HOME/exports/*.pdf`（及 docx/pptx/xlsx/svg） | `$HOME/workspaces/general/exports/` |
| `$HOME/exports/qa/content.md` | `$HOME/workspaces/general/scratch/qa/content.md` |
| `$HOME/.pilotdeck/work/<session>/<turn>/` | `$HOME/workspaces/general/scratch/work/<session>/<turn>/` |
| `$HOME/build_bingli_report.py` | 删除，无新路径 |
| `$HOME/pilotdeck.yaml` | 仍在 `$HOME/pilotdeck.yaml` |

### 6.6 明确不迁

- `$REPO/skills/` 与 `$REPO/plugins/med-tools/` 的相对关系
- RAG：`$REPO/plugins/med-tools/data/rag/`（home 里看到的是软链同一份）
- 会话与记忆目录第一期不搬家，避免 transcript / sqlite 一起迁移

---

## 7. 清洗清单

### 7.1 本地垃圾（删了不影响源码；多半已 gitignore）

- 仓库根空目录 `.pilotdeck/plans`
- `tests/skill-e2e/work/`
- `plugins/med-tools/.tmp/`、`plugins/med-tools/**/__pycache__/`
- `.DS_Store`
- `.runtime/diagram-test/`
- `$HOME/exports/`、`$HOME/.tmp/chat-attachments/`、home 根上的 `build_bingli_report.py` / `extract_med_reports.py`
- home 里空的 `skills/`、`cron/`、`logs/`（目录可留，内容可清）
- `dist/pilotdeck-offline-doc-skills*`（转交包）

### 7.2 上游完整产品残留（先标废弃，再考虑物理删）

与「workspace 文件根」是另一条线，不要和路径迁移绑死。

- `src/adapters/channel/` 中飞书 / 企微 / 微信 / Telegram 等（yaml 已关）
- `src/always-on/`、`src/telemetry/`、部分 Cron / Taskmaster UI
- `design-qa/`、`design-qa.md`
- 上游安装器：`install.sh`、`install.ps1`、公开 Docker README（若现场只用本仓库启动脚本）
- 过时文档：`merge-checklist-and-startup.zh.md`、`work-split-med-pilotdeck.zh.md`；`jinan-model-config.zh.md` 中的硬编码 IP

### 7.3 不要删

- `.runtime/` 下的 Node / Python 便携运行时
- `plugins/med-tools/data/rag/`、`.venv`
- 五个 `skills/*` 及捆绑字体
- `ui/` 与 `src/` 内核

### 7.4 其它债（重组时顺手对齐，不是搬家）

- `plugin.json` 里的 `10.31.112.13`：现场只应读环境变量
- `plugins/med-tools/agents/`：manifest 已 `agents: []`，确认无加载后再删
- UI `main-content` 与 `main-content-v2` 长期只留对话产品在用的那条
- gitignore 收紧：仓库内若再出现 `exports/`、`**/scratch/`、`.tmp/` 一律忽略

---

## 8. 环境变量（实施后）

| 变量 | 含义 |
| --- | --- |
| `PILOTDECK_WORKSPACE_DIR` | Agent 文件数据根 `$WS`（与 cwd 相同） |
| `PILOTDECK_WORKSPACE_CWD` | 兼容旧 docx 逻辑，同 `$WS` |
| `PILOTDECK_WORK_DIR` | `$WS/scratch/work/<session>/<turn>/` |
| `MED_DERIVED_DIR` / `MED_DICOM_DERIVED_DIR` | 优先 `$WS/inbox/<batch>/derived/` |

迁移脚本：`node scripts/migrate-workspace-layout.mjs [--pilot-home PATH]`。复制到 `workspaces/general/` 后，将 `$HOME/.tmp/chat-attachments` 与 `$HOME/exports` 替换为指向新目录的软链，旧 transcript 绝对路径仍可访问。

---

## 9. 实施顺序

1. 清本地垃圾（e2e work、pyc、空 `.pilotdeck`、home 里的 exports / tmp / 手写 py）。
2. 实现 `$HOME/workspaces/<id>/{inbox,exports,scratch}`，改上传路径、Agent cwd、Skill 默认 `--out`。
3. 文档 Skill 的 `$PWD/exports` 改为 `$WS`；插件派生文件进 `inbox/<batch>/derived/`。
4. 保持 `skills/` 与 `plugins/<theme>/` 分离；最多改 UI 分类命名。
5. 再裁上游 IM / Always-On / 过时 docs。

不要为了好看在 git 仓库里新建业务用的 `workspaces/`。同事克隆仓库不应带上会话附件。

---

## 10. 验收（路径落地后）

- 通用对话上传一份附件，磁盘只出现在 `$HOME/workspaces/general/inbox/<batch>/`
- `pdf.sh make`（及另外四个文档入口）的成功 JSON `output` 在 `$HOME/workspaces/general/exports/`
- `$HOME` 根下不再新增 `exports/`、`.tmp/`、`*.py`
- `plugins/med-tools/` 下不再新增 `.tmp/`
- `$HOME/pilotdeck.yaml`、`projects/*/chats/`、`memory/` 位置不变
- 五个文档 Skill 与 med-tools 插件仍分别从 `skills/` 与 `plugins/` 加载
