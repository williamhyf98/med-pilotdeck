# med-pilotdeck 离线化改造方案

本文是后续逐步实施的唯一对照清单。目标：系统可压缩打包，部署到另一台 **x86_64 Linux** 机器；除模型权重与 vLLM 外，运行时不依赖仓库外路径、不依赖公网；现场只需改模型服务的 URL/端口。

**当前约定（已确认）**

- 医疗后端以旧路径为准：[`plugins/med-tools`](../plugins/med-tools)。
- 已删除新路径 `products/medical-integration`，以及整个 `products/`（仅剩的 `_example` 模板无运行时依赖）。
- 不再保留专用医疗 UI（医学对话页、创伤助手页及 `/api/medical/*`）。
- 模型在另一台机器上，hostname 未知；禁止再写死 `10.31.112.13`。
- `dist/` 与 `ui/dist/` 在打包机预构建；裸机目录包与 Docker 镜像都带上同一份产物。
- 交付形态：**裸机打包 + Docker Compose 都要**，同一条构建流水线，两种启动外壳。
- Skills：内置只留 `pdf` / `docx` / `pptx` / `spreadsheets` / `diagram-maker`；医学 skill 全部留在 `plugins/med-tools`；前端 Skills 列表分「通用技能 / 医学技能」两块。
- Gateway 内置工具只保留读/写/改文件、glob、grep、bash、`read_skill`、`todo_write`、`ask_user_question`、`get_current_time`；其余内置工具删除（含 `web_search` / `web_fetch` / `execute_code` 等）。

**实施原则**

1. 一次只做一个步骤，做完再进入下一步。
2. 每步以「可运行的对话 UI + med-tools MCP」为回归底线。
3. 能删交付物就删；Gateway 内核里体积大、测试多的联网模块，优先「不再注册 / 默认关闭 / 不打包」，必要时再物理删除源码。
4. 不把 vLLM、模型权重打进本仓库包。

---

## 目标架构

```text
操作员浏览器
    → UI :3001（通用对话，无专用医疗页）
        → Gateway
            → 内置本地工具（仅文件读写检索、bash、read_skill、todo、提问、时间）
            → plugins/med-tools（stdio MCP）
                  → 本地解析 DICOM/PDF/…
                  → HTTP 调用现场配置的 vLLM / embedding

现场唯一配置：config/deploy.env（或等价 yaml）
    MED_VLM_API_BASE=http://<模型机>:<端口>/v1
    MED_EMBEDDING_API_BASE=http://<模型机>:<端口>/v1
    PILOTDECK_API_URL=同上或主对话模型地址
```

Docker 与裸机共用上述配置契约。Docker 不在目标机 `build`，只 `docker load` + `compose up`。

Compose **不能替代预下载依赖**；目标机还需要已安装 Docker Engine（这是宿主机软件，不在业务目录内）。裸机包则把 Node/Python 打进目录，更接近「解压即用」。

---

## 步骤总览

| 步骤 | 内容 | 状态 |
|------|------|------|
| 1 | 删除新路径与专用医疗 UI | 已完成（2026-08-19） |
| 2 | 裁剪 skill/工具、Skills 分栏、去掉联网入口 | 已完成（2026-08-19） |
| 3 | 配置去硬编码，统一现场配置入口 | 未开始 |
| 4 | 生产启动脚本（预构建 dist，不起 Vite） | 未开始 |
| 5 | 裸机离线依赖预置与打包脚本 | 未开始 |
| 6 | Docker 离线镜像与 compose | 未开始 |
| 7 | 离线文档与验收 | 未开始 |

---

## 步骤 1：删除新路径与专用医疗 UI

### 1.1 目标

离线产品只保留：

- 通用 PilotDeck 对话 UI
- Gateway
- [`plugins/med-tools`](../plugins/med-tools)（Skill + MCP 工具）

不再存在 sidecar、`medical-tools` 插件、专用医疗页面。

聊天里的医疗文件夹上传（给 med-tools 用）**保留**，那不是专用医疗 UI。

### 1.2 整目录删除

- [`products/medical-integration/`](../products/medical-integration/)（sidecar、compose、preset、demo 数据、reference-ui、medical-tools 插件）
- 若根仓库仅为此产品服务，可同时核对并删除过时文档：
  - [`docs/medical-native-ui-acceptance.md`](medical-native-ui-acceptance.md)
  - [`docs/pilotdeck-medical-integration-research.md`](pilotdeck-medical-integration-research.md)
  - [`docs/PILOTDECK_MEDICAL_TRANSFORMATION_REPORT.md`](PILOTDECK_MEDICAL_TRANSFORMATION_REPORT.md)
  - 其它明确只描述 sidecar/专用页的文档

不要删除：

- [`plugins/med-tools/`](../plugins/med-tools/)
- [`plugins/med-tools/data/rag/`](../plugins/med-tools/data/rag/)（战创伤 RAG，LFS）
- 通用聊天相关的 `medicalFolderUpload` 工具

### 1.3 前端：去掉专用页入口与实现

删除目录：

- [`ui/src/features/medical/`](../ui/src/features/medical/)

改接线（删除引用，避免残留路由）：

- [`ui/src/components/main-content/view/MainContent.tsx`](../ui/src/components/main-content/view/MainContent.tsx)：去掉 `DialoguePage` / `MedTraumaPage` lazy import，`activeTab === 'medical-dialogue'` 分支，创伤页渲染
- [`ui/src/hooks/useProjectsState.ts`](../ui/src/hooks/useProjectsState.ts)、[`ui/src/types/app.ts`](../ui/src/types/app.ts)：去掉 `'medical-dialogue'`
- 侧栏/顶栏若有「医学对话 / 创伤助手」入口，一并删除
- [`ui/e2e/medical-*.spec.mjs`](../ui/e2e/) 等专用页 E2E

保留（若仍被通用聊天使用）：

- `ui/src/components/chat/utils/medicalFolderUpload.ts`
- 相关 chat hooks / FilesV2 上传逻辑

### 1.4 后端：去掉 `/api/medical`

删除或停止挂载：

- [`ui/server/routes/medical.js`](../ui/server/routes/medical.js)
- [`ui/server/routes/medicalResources.js`](../ui/server/routes/medicalResources.js)
- [`ui/server/services/medicalSidecar.js`](../ui/server/services/medicalSidecar.js)
- [`ui/server/services/medicalPreset.js`](../ui/server/services/medicalPreset.js)
- [`ui/server/services/medicalStaticData.js`](../ui/server/services/medicalStaticData.js)
- [`ui/server/services/medicalCatalog.js`](../ui/server/services/medicalCatalog.js)
- [`ui/server/services/medicalTraumaPipeline.js`](../ui/server/services/medicalTraumaPipeline.js)
- [`ui/server/services/medicalStore.js`](../ui/server/services/medicalStore.js)
- [`ui/server/services/medicalSafetyRails.js`](../ui/server/services/medicalSafetyRails.js)
- 对应 `*.test.js`

在 [`ui/server/index.js`](../ui/server/index.js)（及任何 router 装配处）去掉 `/api/medical` 挂载与 `PILOTDECK_MEDICAL_*` 环境变量。

### 1.5 启动与 Docker 中的新路径残留

- 启动脚本、README 中的 `PILOTDECK_MEDICAL_*`、`docker-compose.medical.yml` 引用
- 根 [`Dockerfile`](../Dockerfile) 若 COPY 了 `products/medical-integration`，去掉
- [`scripts/lib-local-runtime.sh`](../scripts/lib-local-runtime.sh) 只保留对 **med-tools** 的 symlink，不要再链 `medical-tools`

### 1.6 步骤 1 验收

- 仓库内无 `products/medical-integration`
- UI 无法进入专用医疗页
- `/api/medical/*` 不存在
- `npm test` / UI 单测中与 sidecar、专用页相关的用例已删或改掉
- **对话 UI 仍能启动**；med-tools 插件目录仍在

**实施记录（2026-08-19）**

- 已删除 `products/medical-integration/`、`ui/src/features/medical/`、`/api/medical` 路由与 sidecar 相关 server 服务、专用页 E2E、三篇 sidecar 调研/验收文档。
- 已删除 `products/` 全目录（含事后确认无用的 `_example` 产品模板）。
- 已从 App 壳层去掉 `medical-dialogue` / `medical-trauma` tab 与 `/medical/*` 路由。
- 保留 `plugins/med-tools` 与聊天里的医疗文件夹上传（`medicalFolderUpload`）。
- 聊天工具展示里的 `mcp__medical-sidecar__*` 配置已去掉。
- 历史文档 `merge-checklist-and-startup.zh.md`、`work-split-med-pilotdeck.zh.md` 仅加了过时说明，未整篇改写。

---

## 步骤 2：裁剪 skill / 内置工具，Skills 分栏，去掉联网入口

原则：离线包里的 Agent **不能**被 skill/工具诱导去访问公网。允许保留的网络只有：**现场配置的模型 HTTP 接口**（vLLM / embedding，OpenAI 兼容）。

本步一次做完（已确认，不再分「建议留 / 可留」）：

1. 裁剪 bundled skill，只留 5 个通用文档类。
2. 保留全部 `med-tools` skill，并在前端 Skills 列表与通用 skill 分两栏展示。
3. Gateway 内置工具只保留下面 9 类；其余删除。
4. 去掉 browser-use、ClawHub、公网搜索/抓取；遥测与 IM 默认关闭。

### 2.1 保留的 skill

**通用技能（仓库 [`skills/`](../skills/)，只读内置）**

| Skill | 作用 |
|-------|------|
| `pdf` | 本地读写、合并、渲染 PDF |
| `docx` | 本地读写 Word |
| `pptx` | 本地读写 PowerPoint |
| `spreadsheets` | 本地读写 xlsx/csv 等 |
| `diagram-maker` | 生成本地 SVG/流程图 |

**医学技能（[`plugins/med-tools/skills/`](../plugins/med-tools/skills/)，只读）**

| Skill | 作用 |
|-------|------|
| `med-medical` | 医疗附件/文件夹解读 → `med_parse_medical` |
| `med-trauma-assist` | 战创伤知识点问答 → RAG |
| `med-trauma-stage-plan` | 六阶段正式救治方案 |

不要把医学 skill 复制进根目录 `skills/`；继续由插件加载，但 **必须出现在前端 Skills 列表**（见 2.5）。

### 2.2 删除的 bundled skills（`skills/` 整目录删）

**必须联网或诱导出网**

| Skill | 原因 |
|-------|------|
| `weather` | `curl wttr.in` |
| `github` | GitHub API / `gh` |
| `browser-use` | Playwright，任意网页 |
| `notion` / `trello` / `1password` | 云 SaaS |
| `gog` | Google Workspace OAuth |
| `himalaya` | 邮件 IMAP/SMTP |
| `blogwatcher` | 公网 RSS；安装需联网 |
| `find-skills` | `npx skills` + skills.sh |
| `summarize` | 摘要公网 URL / YouTube |

**非 Linux 离线医学场景**

| Skill | 原因 |
|-------|------|
| `apple-notes` / `apple-reminders` / `bear-notes` | macOS / 账号 |
| `powershell` | Windows |
| `tmux` / `obsidian` | 现场不是终端/知识库工作站 |
| `frontend-design` / `frontend-slides` / `web-design-guidelines` / `react-next-best-practices` | 做网站，带偏 Agent |
| `karpathy-guidelines` / `skill-creator` / `pilotdeck-skills-migration` / `spike` | 开发向 |
| `meeting-recorder-assistant` | 无本地转写引擎，易误解为可录音上网 |

删除后确认：Gateway 只从裁剪后的 `skills/` 与 `plugins/med-tools/skills/` 加载；`$PILOT_HOME/skills` 若有旧副本需忽略或清空，避免「删了仓库仍能出网」。

### 2.3 内置工具：只保留 9 类

注册名以 [`src/tool/registry/createBuiltinRegistry.ts`](../src/tool/registry/createBuiltinRegistry.ts) 为准。`write_file` 与 `edit_file` 同属「写文件」这一类，**两个都留**。

| 工具 | 作用 |
|------|------|
| `read_file` | 读工作区文件 |
| `write_file` | 新建文件 |
| `edit_file` | 按片段改已有文件 |
| `glob` | 按文件名模式列目录 |
| `grep` | 文件内容搜索 |
| `bash` | 本机 shell（文档 skill 脚本依赖它） |
| `read_skill` | 把指定 skill 全文读进上下文 |
| `todo_write` | 多步任务清单 |
| `ask_user_question` | 向用户弹出结构化提问 |
| `get_current_time` | 本机时区时间 |

`med-tools` 的 MCP 工具（`med_parse_medical` 等）**不是**这张表里的内置工具，继续由插件注册，全部保留。

**删除（不再注册，并删除实现与专测）**

| 工具 | 原因 |
|------|------|
| `web_search` / `web_fetch` | 公网搜索、抓任意 URL（`web_fetch` 在只关 search 时仍会注册，必须一起删） |
| `execute_code` | Python 沙箱，且可回调 `web_search`/`web_fetch` |
| `send_attachment` | 主要为 IM 频道发附件 |
| `agent` | 子 Agent，路径难控 |
| `enter_plan_mode` / `exit_plan_mode` | 写代码用的计划模式 |
| `task_create` / `task_list` / `task_output` / `task_wait` / `task_stop` | 后台长任务 |
| `edit_notebook` | Jupyter |
| `structured_output` | 非交互宿主 JSON 终态 |

改 [`createBuiltinRegistry`](../src/tool/registry/createBuiltinRegistry.ts) 只注册上表保留项；删 [`src/tool/builtin/webSearch.ts`](../src/tool/builtin/webSearch.ts)、[`webFetch.ts`](../src/tool/builtin/webFetch.ts)、`web/`、`executeCode.ts`、`sendAttachment.ts`、`agent.ts`、`planMode.ts`、`taskTools.ts`、`editNotebook.ts`、`structuredOutput.ts` 及对应 `tests/`。若某核心测试强依赖已删工具，**改测试**，不要为过测试而重新注册。

`bash` 仍可能被模型拿去 `curl`。本步不引入命令黑名单（放到更后的加固）；本步先拆掉会教它出网的 skill 与 `web_*`。

### 2.4 内置插件、遥测、IM

- 删除 [`src/extension/plugins/builtin/browser-use/`](../src/extension/plugins/builtin/browser-use/)
- [`package.json`](../package.json) 去掉 `install:browser`
- 删除 [`tests/gateway/browser-use-args.spec.ts`](../tests/gateway/browser-use-args.spec.ts)
- 遥测：`telemetry.enabled: false`；禁止 `ANALYTICS_ENABLED=1`；配置中不得出现 `tele.pilotdeck.cn`
- 飞书/企微/微信：yaml 默认 `enabled: false`；Skills/设置里的 IM、ClawHub 安装入口去掉。适配器源码可本步先留、步骤 3 后再删，避免与工具裁剪抢冲突面

锚点：[`src/cli/createLocalGateway.ts`](../src/cli/createLocalGateway.ts)、[`scripts/bootstrap-pilotdeck-config.mjs`](../scripts/bootstrap-pilotdeck-config.mjs)

### 2.5 前端 Skills 列表：通用 / 医学 两栏

现状：[`/api/skills/list`](../ui/server/routes/skills.js) 只返回 builtin / user / project，**不含**插件 skill，所以 `med-tools` 的三条不会出现在 [`SkillsV2`](../ui/src/components/main-content-v2/SkillsV2.tsx)。

要做到：

```text
通用技能
  pdf, docx, pptx, spreadsheets, diagram-maker
  （若仍有 user/project 下非医学 skill，也归这一栏）

医学技能
  med-medical, med-trauma-assist, med-trauma-stage-plan
```

- 列表 API 合并 `plugins/med-tools/skills/`（或等价的插件 skill 枚举），带 `category: general | medical`（或独立 `medical` 数组）。
- 医学 skill **只读**（与 builtin 相同：可看说明，UI 不可改/删）。
- 去掉 Skills 页的 **ClawHub 搜索/安装**（公网装 skill）。
- 新建 skill、从网上 import 的入口：本步隐藏或删除，避免离线包再装 SaaS skill。

### 2.6 公网 Provider 目录（本步最低要求）

[`ui/src/shared/catalogProviders.ts`](../ui/src/shared/catalogProviders.ts)、[`src/model/catalog/providers.ts`](../src/model/catalog/providers.ts) 仍含 OpenAI / OpenRouter 等。

本步：onboarding / 默认配置**不要引导去填这些公网地址**。完整改成「只填自定义 OpenAI 兼容 URL」放到 **步骤 3**（与去掉 `10.31.112.13` 一起）。

### 2.7 步骤 2 验收

- `skills/` 仅剩 `pdf` `docx` `pptx` `spreadsheets` `diagram-maker`
- 前端 Skills 页可见两栏；医学三栏来自 med-tools，只读
- 无 ClawHub / browser-use / `install:browser`
- Agent 可调用的内置工具只有 2.3 保留列表 + `mcp__med-tools__*`
- 无 `web_search` / `web_fetch` / `execute_code` / `agent` / 计划模式 / 后台 task / `edit_notebook` / `structured_output` / `send_attachment`
- 默认配置下不会向 `tele.pilotdeck.cn`、z.ai、tavily、openrouter、skills.sh 发请求
- 对话里医学 skill 仍能分流到 med-tools MCP

**实施记录（2026-08-19）**

- `skills/` 只保留 `pdf` / `docx` / `pptx` / `spreadsheets` / `diagram-maker`。
- 已删除 browser-use 插件、`install:browser`，以及 `web_search` / `web_fetch` / `execute_code` / `agent` / 计划模式 / task / notebook / structured_output / send_attachment 实现。
- `createBuiltinRegistry` 只注册 2.3 保留工具；Gateway 仍会额外挂上 cron / always-on / `mcp__med-tools__*`。
- Skills 列表 API 增加 `medical` 数组，来源 `plugins/med-tools/skills/`；Skills 页分「通用技能 / 医学技能」，医学只读，已隐藏 New / ClawHub。
- 默认 yaml：`telemetry.enabled: false`、`tools.webSearch.enabled: false`、IM adapter `enabled: false`；onboarding 默认 Custom，不再默认 OpenRouter。
- 设置里已隐藏搜索配置与 IM 集成入口（源码仍保留，步骤 3 再删）。

---

## 步骤 3：配置去硬编码（下一步，本步做完再做）

现场只改一份配置，禁止仓库默认写死 IP。

1. [`plugins/med-tools/plugin.json`](../plugins/med-tools/plugin.json) 中 `MED_VLM_API_BASE` / `MED_EMBEDDING_*` 改为读环境变量；示例文件用 `http://127.0.0.1:8030/v1` 这类占位，**不要** `10.31.112.13`。
2. 新增 `config/deploy.env.example`（包内），启动脚本 `set -a; source config/deploy.env`。
3. `PILOT_HOME` 固定为仓库内 `.pilotdeck-home`，不要默认 `~/.pilotdeck`。
4. [`scripts/dev-launcher.mjs`](../scripts/dev-launcher.mjs) 的 `NO_PROXY` 根据 `deploy.env` 里的模型 host 生成，不写死济南 IP。
5. [`docs/jinan-model-config.zh.md`](jinan-model-config.zh.md) 改为「示例，需替换」，或并入离线 README。
6. [`docker-entrypoint.sh`](../docker-entrypoint.sh) 禁止默认 `https://openrouter.ai/api/v1`。

验收：全库搜索 `10.31.112.13` 仅允许出现在历史文档的「已废弃」说明中，或不出现。

---

## 步骤 4：生产模式启动（预构建产物）

打包机执行：

```bash
pnpm install --frozen-lockfile
npm run build          # Gateway → dist/
cd ui && npm run build # 前端 → ui/dist/
```

目标机 / 离线启动：

- Gateway：`node dist/src/cli/pilotdeck.js server`（或仓库现有等价入口）
- UI：Express 提供 **已构建的** `ui/dist`，**不启动 Vite :5173**
- 新增 `scripts/start-offline.sh` / `stop-offline.sh`，与现在的 `start-local.sh`（dev）分开

`dist/`、`ui/dist/` 进入裸机包，也 `COPY` 进 Docker 镜像。

---

## 步骤 5：裸机离线依赖与打包

在 **linux x86_64、有网** 的打包机一次下全，打进目录：

| 内容 | 建议位置 |
|------|----------|
| 便携 Node 22 | `.runtime/node` 或 `vendor/node` |
| 便携 CPython 3.12 | `.runtime/python` |
| `node_modules`（含 native 模块，必须在 linux-x64 编译） | 仓库根 / `ui/` |
| med-tools `.venv` | `plugins/med-tools/.venv`，用 `pip download` + `--no-index` 安装，目标机不再访问 pypi |
| RAG 实体文件 | `plugins/med-tools/data/rag/`（Git LFS 必须 checkout 成真实 `.npy`/`.jsonl`） |
| 构建产物 | `dist/`、`ui/dist/` |

提供 `scripts/package-offline.sh`：校验无 LFS 指针、无 `10.31.112.13`、存在 `deploy.env.example`，然后 `tar czf med-pilotdeck-offline-linux-x64.tar.gz …`。

**排除项：** 不要把 `$PILOT_HOME/skill-backups/`（迁移备份，如 `legacy-bundled-v1`）打进 tar。Skill 加载路径不扫描该目录，但备份体积大且对离线运行无用。

目标机：

```bash
tar xf med-pilotdeck-offline-linux-x64.tar.gz
cd med-pilotdeck-offline
cp config/deploy.env.example config/deploy.env
# 填写模型 URL
./scripts/start-offline.sh
```

目标机脚本**禁止**调用 `bootstrap-runtime.sh`、`plugins/med-tools/setup.sh` 的联网安装、`pnpm install`。

---

## 步骤 6：Docker Compose 离线交付

与步骤 5 **同一构建产物**，再包一层镜像。

有网打包机：

```bash
docker build -t pilotdeck-offline:<version> .
docker save pilotdeck-offline:<version> -o docker/images/pilotdeck-offline.tar
```

镜像内包含：Node 运行时、`dist`、`ui/dist`、`skills`（已裁剪）、`plugins/med-tools`（含 venv 与 RAG）。**不要**再放 sidecar。

`docker/docker-compose.offline.yml`：

- `image: pilotdeck-offline:<version>`，目标机 **无 `build:`**
- 端口 `3001:3001`
- 环境文件 `config/deploy.env`
- volume 仅持久化 `.pilotdeck-home` 会话（可选）

无网目标机（需已装 Docker Engine）：

```bash
docker load -i docker/images/pilotdeck-offline.tar
docker compose -f docker/docker-compose.offline.yml up -d
```

容器访问另一台模型机：在 `deploy.env` 填模型机 IP（与 hostname 无关）。访问「宿主机上的 vLLM」时由现场填 `172.17.0.1` 或 `host.docker.internal`，不写死。

根目录现有 [`docker-compose.yml`](../docker-compose.yml) 仍会 `build` 且默认 OpenRouter，离线交付不要用它。原医疗 sidecar compose 已随步骤 1 删除。

---

## 步骤 7：文档与验收清单

新增 `README-OFFLINE.md`（面向现场）：

- 两种启动方式
- 只改哪些字段
- 模型服务必须 OpenAI 兼容、网络可达
- 明确不包含 GPU/权重

回归：

- 无网环境启动 UI，打开通用对话
- 配置错误的模型 URL 时失败信息清晰，而不是去公网重试
- med-tools：`med_tools_health`、附件解读、RAG 查询（embedding 可达时）
- 抓包或断外公网：除模型 IP 外无出站

---

## 明确不在范围内

- 模型权重、CUDA、vLLM 安装
- 把 Docker Engine 打进业务 tar（目标机若要用 Compose，需自行预装 Docker）
- 把专用医疗 UI / sidecar 再接回 med-tools（已否决）
- Windows / ARM 目标机（当前只保证 linux x86_64）

---

## 建议的执行节奏

1. **步骤 1 已完成。下一步做步骤 2**（skill/工具裁剪、Skills 两栏、去掉联网入口）。
2. 步骤 3：去掉硬编码 IP，现场只改模型 URL；onboarding 只留自定义 OpenAI 兼容地址。
3. 步骤 4–5：才能「解压改 URL 就跑」。
4. 步骤 6：给已有 Docker 的现场。
5. 步骤 7：随 5、6 一起写，避免两套文档。

完成某一步后，把本文「步骤总览」里的状态改成「已完成」，并记下偏差（多删/少删的文件）。
