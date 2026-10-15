# Gitee 远程 + node12 从拉代码到启动

本文记录 2026-10-15 把 med-pilotdeck 的远程仓库从 GitHub 切到 Gitee 之后，在 node12 上从拉代码到 `start-local.sh` 跑通的实际步骤，以及笔记本 → 服务器 → Gitee 的日常开发流程。平台无关的部署细节仍以 [local-clone-and-start.zh.md](./local-clone-and-start.zh.md) 为准，本文只写差异和现场值。

## 1. 远程仓库约定

| 远程名 | 地址 | 用途 |
|--------|------|------|
| `origin` | `git@gitee.com:qiao-shijiao/med-pilotdeck.git` | 日常 fetch / push，所有分支的 upstream |
| `github` | `git@github.com:williamhyf98/med-pilotdeck.git` | 旧远程，只读备查；需要时 `git fetch github` |

已有 GitHub 克隆改成上面布局：

```bash
git remote rename origin github
git remote add origin git@gitee.com:qiao-shijiao/med-pilotdeck.git
git fetch origin --prune
for b in master develop feat/skill-flow-chat; do
  git branch --set-upstream-to=origin/$b $b
done
git remote -v
```

SSH 连通性检查（笔记本和服务器都要做一次，首次会提示接受 host key）：

```bash
ssh -T git@gitee.com
# 期望: Hi shijiaoqiao(@qiao-shijiao)! You've successfully authenticated ...
```

### 1.1 Gitee 免费版不支持 Git LFS

`.gitattributes` 把战创伤 RAG 的两个大文件交给 LFS：

- `plugins/med-tools/data/rag/corpus/war_trauma_books_chunks.jsonl`（约 117 MB）
- `plugins/med-tools/data/rag/embedding/war_trauma_books_embedding.npy`（约 135 MB）

Gitee 对这个仓库返回 `LFS only supported repository in paid or trial enterprise`，所以 Gitee 上**只有 LFS 指针，没有真实文件**；两个文件又都超过 Gitee 单文件 100 MB 上限，不能改成普通 blob 直接入库。约定如下：

1. 仓库里继续保留 LFS 指针和 `.gitattributes`，**不要**改动或重新提交这两个文件。
2. 真实文件走仓库外分发：node12 上 `~/medpilotdeck/plugins/med-tools/data/rag/` 和 `~/med-pilotdeck/plugins/med-tools/data/rag/` 都有完整副本，新克隆直接 `cp` 过去。
3. 每个克隆里关掉 LFS 自动下载，避免 `git pull` / `git checkout` 时去 Gitee 拉 LFS 报错：

   ```bash
   git config lfs.fetchexclude '*'
   ```

   克隆时用 `GIT_LFS_SKIP_SMUDGE=1 git clone ...`，效果相同。

4. `git status` 若把这两个文件显示为已修改，先 `git lfs status` 看 `LFS:` 和 `File:` 的 OID 是否一致。一致就是 LFS 过滤器的噪音，不要提交。

## 2. node12 从零拉代码到启动

node12 现场信息：

| 项 | 值 |
|----|----|
| 仓库目录 | `/home/qiaoshijiao/med-pilotdeck` |
| 分支 | `feat/skill-flow-chat`（开发），`develop`（集成） |
| 端口（`scripts/config.env`） | API 3020，Gateway 18800，Vite 5170。18789 被别人占用，`~/medpilotdeck` 旧实例占着 3030 / 18799 / 5179 |
| 系统 Node | `/usr/bin/node` 是 v12，不能用。必须靠 `.runtime/node`（v22.23.2） |
| 主模型 / 医疗 VLM | vLLM，`http://10.31.112.13:8030/v1`（G9-V-Med）、`http://10.31.112.13:8040/v1`（Qwen3.8-27B） |
| Embedding | `http://10.31.112.13:65507/v1`，`qwen3-vl-embedding` |
| RAG 检索服务 | `http://127.0.0.1:18080`，由 `~/rag4medpilotdeck/UltraRAG/script/rag_api.py` 提供 |
| RADAR / DeepChest | `https://10.31.112.13:18120` / `:18130`，默认 `MED_SPECIALIZED_CT_ENABLED=0` |

### 2.1 拉代码

```bash
cd ~
GIT_LFS_SKIP_SMUDGE=1 git clone -b feat/skill-flow-chat git@gitee.com:qiao-shijiao/med-pilotdeck.git
cd med-pilotdeck
git config lfs.fetchexclude '*'
git remote add github git@github.com:williamhyf98/med-pilotdeck.git   # 可选
```

### 2.2 补 RAG 大文件（仓库外分发，见 §1.1）

```bash
cp ~/medpilotdeck/plugins/med-tools/data/rag/corpus/war_trauma_books_chunks.jsonl \
   plugins/med-tools/data/rag/corpus/
cp ~/medpilotdeck/plugins/med-tools/data/rag/embedding/war_trauma_books_embedding.npy \
   plugins/med-tools/data/rag/embedding/
ls -la plugins/med-tools/data/rag/*/   # 两个文件应为 1xx MB，不是几百字节的指针
```

### 2.3 装运行时和依赖

node12 上 `~/medpilotdeck/.runtime` 已有同版本的便携 Node / Python 和 1 GB 的 pnpm store，先复制再跑 bootstrap 可以跳过下载：

```bash
mkdir -p .runtime/cache
cp -a ~/medpilotdeck/.runtime/node   .runtime/node
cp -a ~/medpilotdeck/.runtime/python .runtime/python
cp -a ~/medpilotdeck/.runtime/cache/pnpm-store .runtime/cache/pnpm-store

export npm_config_registry=https://registry.npmmirror.com
# node12 到清华 PyPI 镜像时常不通，/etc/pip.conf 还挂着一个解析不了的 NVIDIA 源；
# 用阿里云镜像并跳过系统 pip.conf：
export PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
export PIP_CONFIG_FILE=/dev/null
bash scripts/bootstrap-runtime.sh 2>&1 | tee .runtime/bootstrap.log
```

bootstrap 会：复用 Node / Python → `pnpm install` → 建 `plugins/med-tools/.venv` → 预热 pdf / docx / pptx / spreadsheets / diagram 五个 skill 的 Python 运行时。只需成功跑一次。pip 一直在 `Retrying ... NameResolutionError` 或几分钟才下一个包，就是镜像选错了，按上面换源重跑。

### 2.4 现场配置（两个文件，都不入库）

`config/deploy.env`：从 `config/deploy.env.example` 复制，按 §2 表格填模型地址，端口改成和 `scripts/config.env` 一致（3020 / 18800）。node12 已有一份可直接复用：`~/med-pilotdeck/config/deploy.env`。

`.pilotdeck-home/pilotdeck.yaml`：首次 `start-local.sh` 会生成带占位 Key 的模板。node12 直接拷旧实例的配置并改 webui 段：

```bash
cp ~/medpilotdeck/.pilotdeck-home/pilotdeck.yaml .pilotdeck-home/pilotdeck.yaml
```

然后把 `webui.runtime` 改成：

```yaml
webui:
  runtime:
    host: 0.0.0.0
    serverPort: 3020
    vitePort: 5170
    databasePath: auth.db     # 相对 .pilotdeck-home
    workspacesRoot: "~"
```

旧文件里 `databasePath` / `workspacesRoot` 指向同事的目录，不改会把 auth.db 写到别人家。

### 2.5 启动、验证、停止

```bash
bash scripts/start-local.sh
tail -f .runtime/logs/pilotdeck-dev.log
```

`start-local.sh` 先探测 yaml 里的主模型（`agent.model`）。vLLM 没起来时探测失败会直接退出；只想验证服务本身可以：

```bash
SKIP_LLM_CHECK=1 bash scripts/start-local.sh
```

验证：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5170/      # Vite，200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3020/      # API，200/304
curl -s http://127.0.0.1:18800/health                                # Gateway
```

笔记本浏览器访问时先打隧道：`ssh -L 5170:127.0.0.1:5170 -L 3020:127.0.0.1:3020 node12`，再开 `http://localhost:5170`。

停止：

```bash
bash scripts/stop-local.sh
```

## 3. 日常开发流程（笔记本 ↔ node12 ↔ Gitee）

推荐代码只放在 node12，笔记本用 VS Code Remote-SSH（或任何 ssh 终端）连上去改，提交和推送都在服务器完成，这样不需要在笔记本上装 Node / Git：

```bash
# node12 上
cd ~/med-pilotdeck
git checkout feat/skill-flow-chat        # 或 git checkout -b feat/<新功能> develop
# ... 改代码，start-local / stop-local 验证 ...
git add -A
git status                               # 确认没有带上 RAG 大文件、deploy.env、.pilotdeck-home
git commit -m "feat: ..."
git push origin feat/skill-flow-chat     # 首次新分支: git push -u origin feat/<新功能>
```

合入 develop 时在 Gitee 网页发 Pull Request（feat/* → develop），或本地 `git checkout develop && git merge --no-ff feat/... && git push origin develop`。

拉同事的更新：

```bash
git pull --ff-only          # upstream 已指向 origin/<分支>
bash scripts/stop-local.sh && bash scripts/start-local.sh
```

依赖（`pnpm-lock.yaml`、`plugins/med-tools/requirements.txt`）有变化时重跑一次 `bash scripts/bootstrap-runtime.sh`。

笔记本如果也想本地克隆：Windows 先装 Git for Windows，然后 `ssh -T git@gitee.com` 接受 host key，再按 §2.1 克隆。Windows 不下载便携运行时，按 local-clone-and-start.zh.md §4.3 装 Node 22。

## 4. 常见问题

| 现象 | 处理 |
|------|------|
| bootstrap 一开始就报 `Cannot find module 'node:path'` | 系统 Node 太旧（node12 是 v12）。已修 `scripts/lib-local-runtime.sh`，让它优先用 `.runtime/node`；拉到含该修复的版本即可 |
| `LLM_CHECK` 主模型 `✗`，`fetch failed` | `10.31.112.13:8030` / `8040` 的 vLLM 没在跑。`curl http://10.31.112.13:8040/v1/models` 为空就是服务没起来；起 vLLM，或临时 `SKIP_LLM_CHECK=1` |
| `port(s) already in use` | 改 `scripts/config.env`，别碰别人占的 18789 |
| `git push` 报 LFS 相关错误 | 这次提交碰到了 §1.1 的两个大文件。`git reset HEAD~ -- plugins/med-tools/data/rag` 把它们从提交里拿掉 |
| `git pull` 后 RAG 文件变成几百字节 | LFS 指针覆盖了真实文件。按 §2.2 重新 `cp` 一次 |
| 对话落到了 `~/.pilotdeck` | 没用 `start-local.sh` 而是裸 `npm run dev` |
