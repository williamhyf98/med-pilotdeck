# PilotDeck-main(A)→ med-pilotdeck(B)合并清单与启动指南

> **2026-08-19 更新：** 专用医疗 UI 与 `products/medical-integration`（sidecar / medical-tools）已按 [`offline-deployment-plan.md`](./offline-deployment-plan.md) 步骤 1 删除。下文是当时合并记录，其中 sidecar 启动方式不再适用；医疗能力以 `plugins/med-tools` + 通用对话为准。

> 合并日期:2026-08-13
> 合并目标:把 A(`D:\projects\PilotDeck-main`)的医疗开发工作并入 B(`D:\projects\med-pilotdeck`),推送到远程 `feat/add-new-skill` 分支。

---

## 一、合并结果

### 远程状态
- 远程仓库:`git@github.com:williamhyf98/med-pilotdeck.git`
- 分支 `feat/add-new-skill`:`139d62d → 5818ad9`(快进推送,无强推)
- 本地工作区干净(clean)

### 提交记录(3 个)
| 提交 | 说明 |
|---|---|
| `65ae03f` | chore:换行归一化(`* text=auto`)+ 两个大文件的窄范围 Git LFS 规则 |
| `4bfcf91` | feat:合并主体(419 文件,+64,216 / −6,649 行) |
| `5818ad9` | fix:补 `timeoutMs` 到 MCP spec 类型(B 的 McpRuntime 依赖,修复 tsc 编译) |

### 两项目全量差异对比结论
| 类别 | 数量 | 处理结果 |
|---|---|---|
| 共享路径 | 1,377 | — |
| 仅换行符差异(A=LF / B=CRLF) | 1,203 | `* text=auto` 归一,零冲突 |
| 字节完全相同 | 14 | 不动 |
| 真实内容差异 | 147 | 约 110 取 A、约 22 保留 B、15 个手工合并 |
| PNG(A 为 LFS 指针桩,B 为真实字节) | 13 | 保留 B 的字节 |
| 仅 A 有 | 352 | 全部并入(排除产物) |
| 仅 B 有 | 41 | 全部保留;删除多余的 package-lock.json |

### 从 A 并入的内容
- **`products/medical-integration/`**(228 文件,约 295MB):
  - 配置:`config/medical.yaml`、`medical.example.yaml`、`pilotdeck.example.yaml`
  - 客户预设:`customer-presets/`(`_template`、`offline-military` 九格医学辅助平台)
  - 数据:`data/med-trauma/`(战伤评估集,约 120 例图像 + compare_eval_demo10)；战创伤 RAG 语料已迁至 `plugins/med-tools/data/rag/`（不再放在 `products/.../data/rag/`）
  - `plugins/medical-tools/`(4 agents + 4 commands)、`profiles/`(4 个画像)、`skills/`(8 个医疗技能)、`sidecar/`(Python 医学 API/MCP)、`reference-ui/`、`fixtures/`、`docker-compose.medical.yml`、改动清单文档
- **医疗 UI**:`ui/src/features/medical/`(35 文件:dialogue/imaging/table/trauma/eval/translation)
- **医疗服务端**:`ui/server/routes/medical*.js`(5)、`ui/server/services/medical*.js`(10)、`ui/e2e/medical-*.spec.mjs`(3)
- **核心引擎特性**:`src/agent/profile/**`(ProfileRegistry 等)、`src/model/request/samplingParameterSupport.ts`、`PluginAgentProfileLoader.ts`
- **测试**:`tests/agent/profile/*`(4)+ sampling/streaming/thinking(3)
- **文档**:3 篇医疗文档(`PILOTDECK_MEDICAL_TRANSFORMATION_REPORT.md` 等)

### 保留 B 的内容(未被覆盖)
- `plugins/med-tools/`(Python FastMCP:301 种后缀医疗解析 + 本地 G9-V-Med 27B + GPT-5.5 兜底)
- `ui/src/components/chat/utils/medicalFolderUpload.ts` 及 ComposerV2/ChatInterfaceV2/useChatComposerState/FilesV2 中的文件夹上传接线
- 安装器(`install.sh`/`install.ps1`)、`docker-compose.yml`、`docker-entrypoint.sh`、`.github/`、`design-qa/`、英文 README、`LICENSE`
- 本地运行脚本 5 个(`start-local.sh` 等)、`docs/memory-attachment-flow-guide.zh.md`、`tests/router/tokenSaver.spec.ts`

### 手工合并的 15 个冲突文件(合并规则:取 A + 重新套用 B 的独有改动)
| 文件 | 合并方式 |
|---|---|
| `.gitattributes` | `* text=auto` + 仅两个大文件走 LFS,图片保持普通 blob |
| `.gitignore` | 保留 B 版(A 是其子集) |
| `Dockerfile` | 保留 B 版(A 版在合并仓库构建必败:file 依赖缺失 + pnpm 未固定版本) |
| `src/context/DefaultContextRuntime.ts` | 取 A(保留 `memoryPolicy !== "disabled"` 检查) |
| `src/context/attachments/AttachmentResolver.ts` | 取 A,重新排除 `.xml`(医疗 CDA/XML 走 MCP 不内联) |
| `src/router/protocol/decision.ts` | 取 A + B 的 `abortSignal` 字段 |
| `src/router/RouterRuntime.ts` | 取 A(`serverValidatedModelOverride` 守卫)+ B 的 3 处(judge abortSignal、失败事件 judgeProvider/judgeModel/attempts/errorCode/errorMessage、stream abortSignal) |
| `src/mcp/protocol/types.ts` | 取 A + 补 `timeoutMs` 字段(修复 B 的 McpRuntime 编译,提交 `5818ad9`) |
| `ui/server/index.js` | 取 A(`/api/medical` 挂载 + 50MB parser 放开)+ B 的上传改动(64MB/64 文件、relativePaths、pathOnlyIndexes、folderPath、PILOT_HOME 项目目录) |
| `ui/server/pilotdeck-bridge.js(+test)` | 取 A(trusted gateway 安全面)+ B 的 attachment `metadata` 透传 |
| `chat/types/types.ts` | 取 A(ChatTurnOverrides/workspace 覆盖 props)+ B 的 `metadata`/`relativePath` 字段 |
| `chat-v2/ComposerV2.tsx` | 取 A(slot 类 props)+ B 的医疗文件夹 props/chip/警告/选择器 |
| `chat-v2/ChatInterfaceV2.tsx` | 取 A(profileOverride/turnOverrides/欢迎区)+ B 的文件夹接线 |
| `chat/hooks/useChatComposerState.ts` | 取 A(profile/commandPrefix/turnOverrides/syntheticMessages)+ 移植 B 的医疗文件夹 hooks(collectMedicalFilesFromDataTransfer、pathOnlyIndexes、skipContentInline 等) |
| `main-content-v2/FilesV2.tsx` | 取 A + B 的 relativePaths 上传块与 uploadNotice 横幅 |
| `shared/catalogProviders.ts(+test)` | 取 A + B 的 `modelListRequiresApiKey`、moonshot 模型并集(k2.6/k1.5/k2.7-code/k2.7-code-highspeed/k3) |

### 大文件与 LFS
- `plugins/med-tools/data/rag/embedding/war_trauma_books_embedding.npy`(130MB)
- `plugins/med-tools/data/rag/corpus/war_trauma_books_chunks.jsonl`(112MB)
- 两者均超 GitHub 100MB 硬限制,已配置窄范围 Git LFS（原 `products/medical-integration/data/rag/` 副本已删除，避免重复上传）
- **克隆/拉取本仓库需安装 git-lfs**,否则这两个文件是指针 stub

### 排除的产物(未入库)
`pilotdeck.tar`(440MB 备份)、`dist/`、`node_modules/`、`.pilotdeck/`(运行目录)、`.claude/settings.local.json`、sidecar 的 `__pycache__`/`*.egg-info`/`*.pyc`

### 验证结果
- ✅ `pnpm build`(tsc 全量编译)通过
- ✅ `cd ui && pnpm build`(vite)通过(1m25s,仅有无害的 chunk 体积警告)
- ✅ 测试套件:233 个测试,**223 通过、7 失败**;失败集合与 A 原版**逐条一致**(Windows 路径分隔符、网络超时等既有平台问题),**合并零回归**
  - 失败的 7 类:turn-environment(路径)、token-budget/tool-result-reference(4 个)、networkFetch(3 个,超时相关)、read-file-large(2 个)
- ✅ 无 Python 构建产物、无 LFS 指针桩覆盖 PNG、med-tools 插件 15 文件完好、medicalFolderUpload.ts 完好

### ⚠️ 遗留提醒
1. **硬编码 API key**:`plugins/med-tools/plugin.json` 中 `MED_VLM_FALLBACK_API_KEY = sk-93d9...`(GPT-5.5 兜底密钥)已随仓库提交,建议尽快轮换
2. **LFS 配额**:占用仓库所有者的 GitHub LFS 配额(约 250MB;免费 1GB 存储 / 1GB 每月带宽)
3. **推送慢**:实测约 400KB/s,大改动 push 建议后台执行
4. **Dockerfile**:根镜像保留 B 版;`products/medical-integration/docker-compose.medical.yml` 与其兼容(sidecar 独立镜像 + data 卷挂载),但需提供 `PILOTDECK_MODEL`/`PILOTDECK_API_URL`/`PILOTDECK_API_KEY` 或审阅过的 pilotdeck.yaml
5. 本机仓库网络:推送重试时 LFS 对象已断点续传,重试有效

---

## 二、启动指南(B = `D:\projects\med-pilotdeck`)

### 前置条件(本机已就绪)
- Node.js 22.13+ 且 < 23(仓库 `.nvmrc` 固定 v22)
- pnpm 10.32.1、依赖已安装(`pnpm install` 已执行)
- `pnpm build` 已通过(`dist/` 已生成)
- git-lfs 3.7.1 已安装

### 1. 标准启动(核心功能)

```bash
cd /d/projects/med-pilotdeck
npm run dev
# 浏览器打开 http://localhost:5173
```

- 一次启动三个进程:**Gateway**(18789,WebSocket)+ **UI server**(3001,API)+ **Vite**(5173,前端)
- 端口被占用会自动顺延(3002/18790/5174…),启动时打印实际端口映射
- 端口优先级:环境变量硬钉(SERVER_PORT/PILOTDECK_GATEWAY_PORT/VITE_PORT)> 环境变量基址 > `~/.pilotdeck/pilotdeck.yaml` 的 `webui.runtime` > 默认值

**后台运行**:

```bash
bash scripts/start-local.sh          # 后台启动,日志 .runtime/logs/pilotdeck-dev.log
bash scripts/stop-local.sh           # 停止
tail -f .runtime/logs/pilotdeck-dev.log   # 看日志
```

**生产构建模式**(无热更):

```bash
cd ui && npm run start               # = vite build + concurrently gateway+server
```

**模型配置**:首次运行会在 `~/.pilotdeck/pilotdeck.yaml` 生成配置;模型 provider 与 API key 在 UI 的 **Settings** 中配置(内置目录含 deepseek/moonshot/dashscope/zhipu/ollama 等,deepseek 与 moonshot 需要 key 才能拉模型列表)。

### 2. 启用 med-tools 医疗解析插件(同事的功能,可选)

```bash
# ① 安装 Python 依赖(清华镜像,创建 .venv)
bash plugins/med-tools/setup.sh

# ② 把插件安装到 PilotDeck 家目录(plugin.json 按 ${pilotHome}/plugins/med-tools/run.sh 启动)
mkdir -p ~/.pilotdeck/plugins
cp -r plugins/med-tools ~/.pilotdeck/plugins/

# ③ 重启 npm run dev,在聊天框点文件夹图标上传医疗文件夹
```

- 功能:301 种后缀的医疗文件解析(DICOM/PDF/图像/CDA/XML/心电等),调用本地 **G9-V-Med 27B**(`http://127.0.0.1:8030/v1`)生成结构化报告
- 本地模型未启动时自动走 **GPT-5.5 兜底**(`llm-center.modelbest.co`,用 plugin.json 里已提交的 key —— 建议换成自己的)
- 每次最多 64 个文件、单文件 64MB、目录 8 层深度

### 3. 启用医疗产品包 sidecar(你的功能,可选)

```bash
# ① 安装 sidecar Python 依赖(3.11+)
pip install -r products/medical-integration/sidecar/requirements.txt

# ② 一键启动:sidecar API(8765)+ sidecar MCP(8766)+ 整个 dev 环境
powershell -File products/medical-integration/scripts/start-dev.ps1
# Python 不在 PATH 时:$env:MEDICAL_PYTHON = "C:\...\python.exe"
```

- 手动分别启动:
  ```bash
  python -m medical_sidecar.api --config products/medical-integration/config/medical.yaml   # API :8765
  python -m medical_sidecar.mcp --config products/medical-integration/config/medical.yaml   # MCP :8766
  ```
- 启动前导出环境变量(PowerShell 脚本会自动设置):
  ```bash
  export PILOTDECK_MEDICAL_SIDECAR_URL="http://127.0.0.1:8765/"
  export PILOTDECK_MEDICAL_SIDECAR_ALLOWED_PORTS="8765"
  export PILOTDECK_MEDICAL_DATA_ROOT="D:/projects/med-pilotdeck/products/medical-integration/data"
  ```
- 医疗 UI 页面(对话/影像/表格/战伤评估/翻译,入口在 AppTab 的 medical-dialogue / medical-trauma)依赖 sidecar;`config/medical.yaml` 中的 RAG 语料与战伤数据路径指向 `data/` 目录

### 4. Docker 方式

```bash
# 仅主程序(Gateway :18789 + UI :3001,B 的 docker-compose.yml)
docker compose up --build

# 带医疗 sidecar(主程序容器 + 医学 API 容器,data 卷挂载)
docker compose -f products/medical-integration/docker-compose.medical.yml up --build
```

- 需先创建并审阅 `~/.pilotdeck/pilotdeck.yaml`,或提供 `PILOTDECK_MODEL` / `PILOTDECK_API_URL` / `PILOTDECK_API_KEY` 环境变量

### 5. 常用命令速查

| 命令 | 说明 |
|---|---|
| `npm run dev` | 前台开发模式(三进程) |
| `npm run server` | 仅 Gateway(tsx 直跑) |
| `npm run server:built` | 仅 Gateway(编译产物) |
| `npm run build` / `npm test` | 编译 / 完整测试(先 build) |
| `cd ui && npm run dev:concurrent` | 前端三进程(等价 dev) |
| `cd ui && npm run typecheck` | 前端 TS 类型检查 |
| `cd ui && npm test` | 前端 vitest |
| `npm run skills:migrate` | 技能迁移 CLI |
| `bash scripts/start-local.sh` / `stop-local.sh` | 后台启动 / 停止 |

### 6. 建议的日常开发流程
1. 日常开发:`npm run dev` + 浏览器 `http://localhost:5173`
2. 用医疗文件夹上传解析:加第 2 步(med-tools 插件)
3. 用战伤评估/影像/表格等医疗 UI:加第 3 步(sidecar)
4. 改动后提交到 `feat/add-new-skill`,大推送用后台执行(`git push` 超过 10 分钟属正常)
