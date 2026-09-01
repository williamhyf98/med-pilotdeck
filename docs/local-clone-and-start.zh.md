# 克隆到本地后的部署与启动

本文说明 **med-pilotdeck** 从 Git 拉到本机后，如何按平台装依赖、生成配置并启动。同事联调、开发机日常启动都走这条路径。

上游 README 里的 `install.sh` / `install.ps1` 会把状态写到用户主目录 `~/.pilotdeck`，并假设网页 Onboarding。本仓库的开发启动 **不走那条路**：家目录固定在仓库内 `.pilotdeck-home/`，模型要写在 yaml 里（首次会自动生成模板）。

| 方式 | 适合 | 家目录 | 入口 |
|------|------|--------|------|
| **本文：`bootstrap-runtime` + `start-local`** | 克隆本仓库后本地开发 | `<仓库>/.pilotdeck-home` | 下文 |
| 上游一键安装 | 安装官方/发行版 PilotDeck | `~/.pilotdeck` | [README.zh.md](../README.zh.md) |
| Docker | 不想在本机装 Node | 容器内 `/root/.pilotdeck` | [README_DOCKER.zh.md](../README_DOCKER.zh.md) |
| 纯 pnpm + `npm run dev` | 已有系统 Node 22，且接受 `~/.pilotdeck` | 默认 `~/.pilotdeck` | [README_SOURCE_INSTALL.zh.md](../README_SOURCE_INSTALL.zh.md)（配置段已过时，模型请仍按本文改 yaml） |

## 1. 启动后长什么样

`start-local.sh` 会起三个进程：

| 进程 | 默认端口 | 作用 |
|------|----------|------|
| UI（Vite） | `5173` | 浏览器打开这个 |
| API（Express） | `3010` | 前端调的 HTTP API |
| Gateway | `18795`（见 `scripts/config.env`；未占用时可改成 `18789`） | Agent / WebSocket |

端口写在 `scripts/config.env`。已被占用时脚本会直接失败，改文件或停掉占用进程后再启。环境变量若已设置，优先级高于该文件。

状态目录（均在仓库内，已 gitignore）：

- `.runtime/` — 便携 Node/Python、pnpm 缓存、启动 pid 与日志
- `.pilotdeck-home/` — `pilotdeck.yaml`、会话、记忆、插件软链
- `node_modules/`、`plugins/med-tools/.venv/` — JS / 医疗插件 Python 依赖

## 2. 各平台都要准备的东西

- **Git**，以及 **Git LFS**（战创伤 RAG 的 `.npy` / `.jsonl` 超过 GitHub 普通文件限制）。
- **能访问模型服务的网络**（内网 vLLM / OpenAI 兼容网关等）。启动前会探测主模型，连不上会失败。
- Linux / macOS：**不必先装系统 Node**。`bootstrap-runtime` 会把 Node 22 和便携 CPython 装进 `.runtime/`。
- Windows：**必须先装系统 Node.js 22**（`bootstrap-runtime-select.sh` 在 Git Bash 下**不会**下载便携运行时）。

中国大陆访问 GitHub / npm 慢时，可配镜像或代理后再执行第 4 步。例如：

```bash
npm config set registry https://registry.npmmirror.com
# 仅当前 shell；原生包回退编译时还可：
export npm_config_disturl=https://npmmirror.com/mirrors/node
```

## 3. 克隆

把下面的 `<仓库 URL>` 换成实际地址（SSH 或 HTTPS 均可）。

```bash
git lfs install
git clone <仓库 URL>
cd med-pilotdeck
git lfs pull
```

没有 `git-lfs` 时，`plugins/med-tools/data/rag/` 里大文件会是指针桩，战创伤 RAG 不可用；主对话仍可启动。

若仓库默认不是你要的分支：

```bash
git checkout <分支名>
git lfs pull
```

## 4. 按操作系统装依赖

在**仓库根目录**执行。只需成功跑一次；以后改代码一般不用重跑。强制重装：

```bash
PILOTDECK_BOOTSTRAP_FORCE=1 bash scripts/bootstrap-runtime-select.sh
```

### 4.1 Linux

发行版包（Debian / Ubuntu 示例，无 sudo 可跳过 `build-essential`，多数情况用预编译原生包即可）：

```bash
sudo apt-get update
sudo apt-get install -y git git-lfs curl tar
# 原生 npm 包若要本地编译再装：
# sudo apt-get install -y build-essential python3
```

```bash
bash scripts/bootstrap-runtime-select.sh
```

脚本会识别 Linux，调用 `scripts/bootstrap-runtime.sh`：下载/复用 Node 22、便携 Python 3.12、`pnpm install`、`plugins/med-tools` 的 venv，并预热 pdf/docx 等 Skill 运行时。

架构支持 `x86_64` 与 `aarch64`。

### 4.2 macOS

需要 Xcode Command Line Tools（原生 Node 依赖编译时用）：

```bash
xcode-select --install
xcrun --find clang   # 应打印 clang 路径
```

可选：`brew install git git-lfs`

确认架构与 Node 不要混用（Apple Silicon 不要用 Intel 的 `node_modules` 拷贝）：

```bash
uname -m    # arm64 或 x86_64
```

```bash
bash scripts/bootstrap-runtime-select.sh
```

会走 `scripts/bootstrap-runtime-darwin.sh`（darwin 的 Node / CPython 包）。

若 `xcrun` 失败：`sudo xcode-select --reset` 或重装 CLT。Intel Mac 上 `node -p "process.arch"` 应为 `x64`。

### 4.3 Windows

推荐顺序：**WSL2 当 Linux 用** → **Git Bash** → 纯 PowerShell（摩擦最多）。

#### 路径 A：WSL2（最省事）

1. 安装 [WSL2](https://learn.microsoft.com/windows/wsl/install) 与 Ubuntu。
2. 在 Ubuntu 终端里按 **§4.1 Linux** 克隆并 `bootstrap-runtime-select.sh`。
3. 浏览器访问 WSL 打印的 `http://localhost:5173`（Windows 会转发 localhost）。

代码若放在 `/mnt/c/...`，I/O 较慢，尽量把仓库放在 Linux 家目录（如 `~/med-pilotdeck`）。

#### 路径 B：Git Bash（本机 Windows 开发）

1. 安装 [Git for Windows](https://git-scm.com/download/win)（自带 Git Bash）。
2. 安装 **Node.js 22.x**（[nodejs.org](https://nodejs.org/) x64，不要 23+）。新开终端后：

   ```bash
   node -v          # v22.x
   node -p "process.arch"   # 应为 x64
   ```

3. 安装 **真实 Python 3**（不要用 Microsoft Store 的 `python3` 打开应用商店的那种桩）。可用官方安装包或 conda。
4. 原生依赖若要从源码编译：安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 的 C++ 工作负载。
5. 在 **Git Bash**（不要用 PowerShell 跑 `.sh`）进入仓库：

   ```bash
   git lfs install
   git clone <仓库 URL>
   cd med-pilotdeck
   git lfs pull
   bash scripts/bootstrap-runtime-select.sh
   ```

   Windows 上该脚本**只检查系统 Node，不会下载 `.runtime`**。需要自己装 JS 依赖和医疗 venv：

   ```bash
   corepack enable
   corepack pnpm install --frozen-lockfile
   # 若没有 corepack：
   # npm install -g pnpm@10.32.1 && pnpm install --frozen-lockfile

   PYTHON_BIN='/c/Path/To/python.exe' bash plugins/med-tools/setup.sh
   ```

   `PYTHON_BIN` 换成本机真实解释器，例如 conda：`PYTHON_BIN='D:/miniconda3/envs/med/python.exe'`。

PowerShell 若拦截 `npm.ps1`，改用 `npm.cmd`。不要用 `npm install` 替代 `pnpm install --frozen-lockfile`。

#### 路径 C：Docker Desktop

见 [README_DOCKER.zh.md](../README_DOCKER.zh.md)。先启动 Docker Desktop，再 `docker compose up`。这与 `start-local.sh` 的端口/家目录约定不同。

## 5. 配置模型（所有平台相同）

家目录和 yaml **不会进 Git**。第一次启动会自动创建 `.pilotdeck-home/` 和带占位 Key 的 `pilotdeck.yaml`。

```bash
bash scripts/start-local.sh
```

预期：生成配置后 **LLM 检查失败**，提示把 `PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE` 换成真实凭证。这是正常的。

编辑：

`<仓库>/.pilotdeck-home/pilotdeck.yaml`

至少改：

1. `model.providers.<id>.url` — OpenAI 兼容基址，一般以 `/v1` 结尾  
2. `model.providers.<id>.apiKey` — 真实 Key；服务不校验时可填 `EMPTY`  
3. `model.providers.<id>.models` — 键名必须是真实模型 id（不要留 `your-model-id`）  
4. `agent.model` 与 `router.scenarios.default` — 格式 `providerId/modelId`，且与上面一致  

示例（本地 vLLM，无鉴权）：

```yaml
agent:
  model: qwen/Qwen3.8-27B
model:
  providers:
    qwen:
      protocol: openai
      url: http://127.0.0.1:8040/v1
      apiKey: EMPTY
      models:
        Qwen3.8-27B: {}
router:
  scenarios:
    default: qwen/Qwen3.8-27B
```

已有一台能跑的机器时，可把对方的 `.pilotdeck-home/pilotdeck.yaml` 拷过来（注意 Key 与内网 URL 是否在本机可达）。**不要**指望 `~/.pilotdeck/pilotdeck.yaml`：`start-local.sh` 不会读它。

医疗插件还会读同一份 yaml 里的 `agent.model` 作为 G9 失败时的兜底。G9 地址也可在 `plugins/med-tools/plugin.json` 的 `MED_VLM_*` 里配。济南内网示例见 [jinan-model-config.zh.md](./jinan-model-config.zh.md)。

## 6. 启动与停止

```bash
bash scripts/start-local.sh          # 后台
bash scripts/stop-local.sh           # 停止本仓库这次拉起的进程
tail -f .runtime/logs/pilotdeck-dev.log
```

前台调试：

```bash
bash scripts/start-local.sh --fg
```

浏览器打开脚本打印的 UI 地址（默认 <http://localhost:5173>）。

`start-local` 会：确保 `.pilotdeck-home` 布局、把 `plugins/med-tools` 链到家目录（Windows 用目录 junction）、探测 yaml 里的主模型，再 `npm run dev`。

仅调试、模型暂时不通时（对话仍会失败）：

```bash
SKIP_LLM_CHECK=1 bash scripts/start-local.sh
```

## 7. 启动是否成功

- 日志里 Vite ready、Gateway listening、bridge connected。  
- `http://127.0.0.1:<VITE_PORT>/` 返回页面。  
- 在 UI 里发一句问候，应走到 yaml 里的 `agent.model`。  
- 医疗解析：聊天框文件夹上传；需 G9 或已配置的主模型兜底。  
- RAG：`git lfs pull` 成功且 embedding 服务按 yaml `embedding` 段可达（`enabled: false` 时跳过探测）。

## 8. 常见问题

| 现象 | 处理 |
|------|------|
| `pilotdeck.yaml not found` | 旧脚本才会只警告不创建。请更新到会自动写模板的 `scripts/bootstrap-pilotdeck-config.mjs`，再跑 `start-local`。 |
| `placeholder apiKey` | 编辑 `.pilotdeck-home/pilotdeck.yaml`，不要用占位字符串当 Key。 |
| 主模型 probe 失败 | 检查 url、模型 id、本机到推理服务的网络；或临时 `SKIP_LLM_CHECK=1`。 |
| `port(s) already in use` | 改 `scripts/config.env`，或 `stop-local` / 杀掉占用进程。 |
| `PilotDeck needs Node.js 22` | Linux/mac 先跑 bootstrap；Windows 安装系统 Node 22 并保证 Git Bash 的 `PATH` 能找到。 |
| Windows 上 med-tools 起不来 | 不要用 Store 的 python 桩；设置 `PYTHON_BIN` 后跑 `setup.sh`。 |
| RAG 文件很小 / 打不开 | 未装 LFS 或未 `git lfs pull`。 |
| 对话进了错误的家目录 | 必须用 `start-local.sh`，不要裸 `npm run dev`（后者默认 `~/.pilotdeck`）。 |
| bootstrap 下载 CPython/Node 失败 | 网络或代理；可重试，或 `PILOTDECK_BOOTSTRAP_FORCE=1`。Linux 若本机已有 `~/.local/node-v<版本>` 会优先拷贝。 |

## 9. 和「只装依赖、不启动」

同事若已经跑过 bootstrap，只需：

```bash
bash scripts/start-local.sh
# 按提示改 yaml 后再执行一次
```

不要把别人的 `node_modules` / `.runtime` 跨系统、跨 CPU 架构拷贝（Windows ↔ Linux、arm64 ↔ x64 都不行）。
