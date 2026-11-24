# 腹盆CT分析（abd-pelvis-ct）RADAR Docker 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 node12 上实际运行的 RADAR 服务拆成不携带模型的网关镜像和携带模型的 GPU 推理镜像，交付名统一为 `腹盆CT分析` / `abd-pelvis-ct`，并保持现有 node12 服务可回滚。

**Architecture:** 使用两个独立镜像：`med-abd-pelvis-ct-gateway` 负责上传、任务和 CSV 返回；`med-abd-pelvis-ct-inference` 负责 GPU 模型加载和推理。两者通过 Compose 内部服务名通信，模型只存在于 inference 镜像。首轮保留实际部署源码内部的旧兼容标识，但用户可见层、镜像名、Compose 服务名和交付目录全部使用 `abd-pelvis-ct`。

**Tech Stack:** Docker Buildx、Docker Compose、Python 3.10、torch 2.7.1+cu126、MONAI 1.5.0、FastAPI、NVIDIA Container Toolkit、node12。

**Spec:** `docs/superpowers/specs/2026-11-20-ct-docker-packaging-design.md`

## Global Constraints

- 用户可见名称必须是 `腹盆CT分析`；交付技术名必须是 `abd-pelvis-ct`。
- 镜像名必须是 `med-abd-pelvis-ct-gateway` 和 `med-abd-pelvis-ct-inference`。
- Compose 服务名必须是 `abd-pelvis-ct-gateway` 和 `abd-pelvis-ct-inference`。
- 不把模型放进 gateway 镜像。
- 不在镜像中放入 `.runtime`、`.venvs`、`handoff`、`service/jobs`、`artifacts`、`benchmarks`、密钥、证书、`__pycache__` 或 `.DS_Store`。
- 用户已明确确认授权允许；不把独立的 `LICENSE`、`NOTICE`、版权或引用文件复制到发布包或镜像。
- 首轮不删除 node12 现有运行目录；所有清理先移动、归档或保留在构建上下文外。
- 首轮保留 Dataset298、`model.safetensors`、`biovil_image_resnet50`，真实 CT smoke 后再评估移除。
- node12 原生构建和运行 `linux/amd64`；Mac 构建仅作为基础镜像拉取失败时的回退方案。
- 不用 `/health` 单独证明功能可用；必须有真实 CT smoke。
- 首轮允许源码内部保留旧 `RADAR_*` 变量名、模块名和模型文件名；交付层不得出现旧名称。

## Review Focus

- inference 镜像是否能加载 RADAR checkpoint、BERT 和 `damo-radar` 源码，而不是只在无模型路径下启动。
- gateway 镜像是否在**没有模型**的情况下仍能完成上传、调用 inference、下载 CSV。
- `gpu_api.py` 未监听 18221 时，gateway 健康检查是否会明确失败而不是误报 ready。
- 从 node12 复制的最小上下文是否误带 `handoff`、历史工作目录、密钥或宿主 Python 环境。
- node12 的 Docker socket 权限和 `/local_data` 空间是否满足运行，而不是只满足 Mac 构建。

---

### Task 1: 建立 staging 与文件清单

**Files:**
- Create: `deploy/ct/abd-pelvis-ct/.gitignore`
- Create: `deploy/ct/abd-pelvis-ct/manifests/radar-files.json`
- Create: `deploy/ct/abd-pelvis-ct/manifests/radar-files.sha256`
- Create: `deploy/ct/abd-pelvis-ct/gateway/`
- Create: `deploy/ct/abd-pelvis-ct/inference/`

**Interfaces:**
- Consumes: node12 `/local_data/huojianfan/radar-gpu-poc/` 的实际部署文件。
- Produces: 一个可复现、可校验的 RADAR 最小构建上下文。

- [ ] **Step 1: 建立 staging 目录**

创建以下目录：

```text
deploy/ct/abd-pelvis-ct/
├── gateway/
├── inference/
├── manifests/
└── .gitignore
```

`.gitignore` 至少排除：

```text
inference/models/
**/.runtime/
**/.venv/
**/__pycache__/
**/*.pyc
**/.DS_Store
**/*.key
**/*.pem
**/*.crt
```

- [ ] **Step 2: 从 node12 复制 RADAR 最小代码**

只复制以下文件，不复制 `handoff/`、`venv/`、`cache/`、`tmp/`、`integration-artifacts/`、`config/inference-api.key`：

```text
app.py
gpu_api.py
radar_inference.py
requirements.txt
damo-radar/
  RADAR_inference/
  ckpt/infer_text_embedding_radar.pt
  requirements.txt
```

把 `app.py`、`radar_inference.py`、`requirements.txt` 放入 `gateway/`；  
把 `gpu_api.py`、`radar_inference.py`、`damo-radar/` 放入 `inference/`。  
复制 `models/checkpoint_radar_pretrain.pth` 和 `models/bert-base-chinese/` 到 `inference/models/`。  
不要复制独立的 `LICENSE`、`NOTICE`、README 或引用文件。

- [ ] **Step 3: 生成文件清单**

生成 JSON 清单，至少包含：

```json
{
  "name": "abd-pelvis-ct",
  "source": "node12:/local_data/huojianfan/radar-gpu-poc",
  "files": [
    { "path": "inference/models/checkpoint_radar_pretrain.pth", "bytes": 0, "sha256": "" }
  ]
}
```

用实际大小和 SHA256 填充，不写密钥内容。

- [ ] **Step 4: 校验 staging 不含禁入内容**

运行：

```bash
find deploy/ct/abd-pelvis-ct -type d \( -name handoff -o -name venv -o -name __pycache__ -o -name cache -o -name tmp \) -print
find deploy/ct/abd-pelvis-ct -type f \( -name '*.key' -o -name '*.pem' -o -name '*.crt' -o -name 'LICENSE' -o -name 'NOTICE' \) -print
sha256sum -c deploy/ct/abd-pelvis-ct/manifests/radar-files.sha256
```

预期：前两条无输出；最后一条全部 OK。

- [ ] **Step 5: 提交 staging 代码**

```bash
git add deploy/ct/abd-pelvis-ct
git commit -m "chore(ct): stage abd-pelvis-ct radar build context"
```

---

### Task 2: 建立中性的交付配置与兼容环境映射

**Files:**
- Create: `deploy/ct/abd-pelvis-ct/compose.ct.yml`
- Create: `deploy/ct/abd-pelvis-ct/env.example`
- Create: `deploy/ct/abd-pelvis-ct/gateway/entrypoint.sh`
- Create: `deploy/ct/abd-pelvis-ct/inference/entrypoint.sh`

**Interfaces:**
- Consumes: Task 1 的 staging 文件。
- Produces: 服务名、镜像名、端口和中性环境变量；旧源码需要的 `RADAR_*` 变量只由镜像内 entrypoint 兼容映射。

- [ ] **Step 1: 写 Compose 服务定义**

`compose.ct.yml` 定义：

```yaml
services:
  abd-pelvis-ct-inference:
    image: med-abd-pelvis-ct-inference:${ABD_PELVIS_CT_TAG:-dev}
    profiles: ["ct"]
    ports:
      - "127.0.0.1:18221:18221"
    volumes:
      - abd-pelvis-ct-inference-work:/var/lib/abd-pelvis-ct/inference
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
  abd-pelvis-ct-gateway:
    image: med-abd-pelvis-ct-gateway:${ABD_PELVIS_CT_TAG:-dev}
    profiles: ["ct"]
    ports:
      - "127.0.0.1:18120:18120"
    environment:
      ABD_PELVIS_CT_INFERENCE_API_BASE: http://abd-pelvis-ct-inference:18221
    volumes:
      - abd-pelvis-ct-gateway-work:/var/lib/abd-pelvis-ct/gateway
    depends_on:
      - abd-pelvis-ct-inference
volumes:
  abd-pelvis-ct-inference-work:
  abd-pelvis-ct-gateway-work:
```

- [ ] **Step 2: 写中性环境变量模板**

`env.example` 使用：

```env
ABD_PELVIS_CT_TAG=dev
ABD_PELVIS_CT_GPU=0
ABD_PELVIS_CT_INFERENCE_WORK_ROOT=/var/lib/abd-pelvis-ct/inference
ABD_PELVIS_CT_GATEWAY_WORK_ROOT=/var/lib/abd-pelvis-ct/gateway
```

不写真实密钥、证书路径或患者数据路径。

- [ ] **Step 3: 写兼容 entrypoint**

`inference/entrypoint.sh` 把中性变量映射为现有源码需要的变量，例如：

```sh
export RADAR_SERVICE_ROOT="${RADAR_SERVICE_ROOT:-/opt/abd-pelvis-ct/inference}"
export RADAR_ROOT="${RADAR_ROOT:-$RADAR_SERVICE_ROOT/damo-radar}"
export RADAR_MODEL_ROOT="${RADAR_MODEL_ROOT:-$RADAR_SERVICE_ROOT/models}"
export RADAR_TEXT_EMBEDDING="${RADAR_TEXT_EMBEDDING:-$RADAR_ROOT/ckpt/infer_text_embedding_radar.pt}"
export RADAR_DEVICE="${RADAR_DEVICE:-cuda:0}"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-${ABD_PELVIS_CT_GPU:-0}}"
exec python "$RADAR_SERVICE_ROOT/gpu_api.py" --host 0.0.0.0 --port 18221
```

`gateway/entrypoint.sh` 同理，把 `ABD_PELVIS_CT_INFERENCE_API_BASE` 映射到现有 `RADAR_INFERENCE_API_BASE`，再启动 `app.py`。

- [ ] **Step 4: 静态检查中性交付层**

运行：

```bash
grep -RIn "RADAR" deploy/ct/abd-pelvis-ct/compose.ct.yml deploy/ct/abd-pelvis-ct/env.example || true
docker compose -f deploy/ct/abd-pelvis-ct/compose.ct.yml config
```

预期：Compose 和 env 文件不出现面向用户的旧名；`config` 成功展开。镜像内 entrypoint 的兼容变量不在此检查范围内。

- [ ] **Step 5: 提交交付配置**

```bash
git add deploy/ct/abd-pelvis-ct/compose.ct.yml deploy/ct/abd-pelvis-ct/env.example deploy/ct/abd-pelvis-ct/gateway/entrypoint.sh deploy/ct/abd-pelvis-ct/inference/entrypoint.sh
git commit -m "feat(ct): add abd-pelvis-ct compose contract"
```

---

### Task 3: 构建不带模型的 gateway 镜像

**Files:**
- Create: `deploy/ct/abd-pelvis-ct/gateway/Dockerfile`
- Create: `deploy/ct/abd-pelvis-ct/gateway/.dockerignore`
- Copy: `deploy/ct/abd-pelvis-ct/gateway/app.py`
- Copy: `deploy/ct/abd-pelvis-ct/gateway/radar_inference.py`
- Copy: `deploy/ct/abd-pelvis-ct/gateway/requirements.txt`

**Interfaces:**
- Consumes: Task 2 的 entrypoint 和 Compose 配置。
- Produces: `med-abd-pelvis-ct-gateway`，不含模型，能调用 inference。

- [ ] **Step 1: 写 gateway Dockerfile**

使用 `python:3.10-slim-bookworm`，安装 `requirements.txt`，复制 gateway 文件，设置非 root 用户，暴露 18120。

- [ ] **Step 2: 写 gateway `.dockerignore`**

排除：

```text
models/
handoff/
venv/
*.key
*.pem
*.crt
__pycache__/
*.pyc
```

- [ ] **Step 3: 构建镜像**

在 node12 上运行：

```bash
docker buildx build --network=host --platform linux/amd64 \
  --load \
  -f deploy/ct/abd-pelvis-ct/gateway/Dockerfile \
  -t med-abd-pelvis-ct-gateway:dev \
  deploy/ct/abd-pelvis-ct/gateway
```

预期：构建成功。

- [ ] **Step 4: 验证 gateway 不含模型**

```bash
docker run --rm --entrypoint sh med-abd-pelvis-ct-gateway:dev -c \
  'test ! -e /opt/abd-pelvis-ct/inference/models && echo gateway-model-free'
```

预期输出：`gateway-model-free`。

- [ ] **Step 5: 启动 gateway 并验证 inference 不可用时明确失败**

先只启动 gateway，确认：

```bash
curl -fsS http://127.0.0.1:18120/health
```

预期：返回非 ready 或明确的 inference 连接错误，不得返回 ready。

- [ ] **Step 6: 提交 gateway 镜像定义**

```bash
git add deploy/ct/abd-pelvis-ct/gateway
git commit -m "feat(ct): build abd-pelvis-ct gateway image"
```

---

### Task 4: 构建带模型的 inference 镜像

**Files:**
- Create: `deploy/ct/abd-pelvis-ct/inference/Dockerfile`
- Create: `deploy/ct/abd-pelvis-ct/inference/.dockerignore`
- Create: `deploy/ct/abd-pelvis-ct/inference/requirements-gpu.txt`
- Copy: `deploy/ct/abd-pelvis-ct/inference/gpu_api.py`
- Copy: `deploy/ct/abd-pelvis-ct/inference/radar_inference.py`
- Copy: `deploy/ct/abd-pelvis-ct/inference/damo-radar/`
- Copy: `deploy/ct/abd-pelvis-ct/inference/models/`

**Interfaces:**
- Consumes: Task 1 的模型、`damo-radar` 和 Task 2 的 entrypoint。
- Produces: `med-abd-pelvis-ct-inference`，可在 GPU 上加载模型。

- [ ] **Step 1: 写 GPU 依赖清单**

`requirements-gpu.txt` 至少固定：

```text
fastapi==0.116.1
python-multipart==0.0.20
uvicorn==0.35.0
monai==1.5.0
SimpleITK==2.5.2
nibabel==5.2.1
numpy==1.24.4
transformers==4.37.2
pandas>=2.0
tqdm>=4.65
```

`torch==2.7.1+cu126` 使用与 node12 验证环境一致的 CUDA 12.6 安装源。

- [ ] **Step 2: 写 inference Dockerfile**

使用与 torch 2.7.1+cu126 兼容的 CUDA 12.6 runtime 基础镜像，安装 Python 3.10 和依赖，复制 `damo-radar`、模型和代码，设置 `/opt/abd-pelvis-ct/inference`，运行非 root 用户，暴露 18221。

- [ ] **Step 3: 构建 inference 镜像**

在 node12 上运行：

```bash
docker buildx build --network=host --platform linux/amd64 \
  --load \
  -f deploy/ct/abd-pelvis-ct/inference/Dockerfile \
  --build-context hostpkgs=/usr/local/lib/python3.10/dist-packages \
  -t med-abd-pelvis-ct-inference:dev \
  deploy/ct/abd-pelvis-ct/inference
```

预期：构建成功；模型层存在。

- [ ] **Step 4: 验证模型和运行时**

```bash
docker run --rm --entrypoint sh med-abd-pelvis-ct-inference:dev -c \
  'test -f /opt/abd-pelvis-ct/inference/models/checkpoint_radar_pretrain.pth && python -c "import torch, monai; print(torch.__version__, monai.__version__)"'
```

预期：输出 `2.7.1+cu126 1.5.0`，模型文件存在。

- [ ] **Step 5: 提交 inference 镜像定义**

```bash
git add deploy/ct/abd-pelvis-ct/inference
git commit -m "feat(ct): build abd-pelvis-ct inference image"
```

---

### Task 5: node12 构建与本地镜像验证

**Files:**
- Create: `deploy/ct/abd-pelvis-ct/scripts/build-radar.sh`
- Create: `deploy/ct/abd-pelvis-ct/scripts/export-radar.sh`
- Modify: `deploy/ct/abd-pelvis-ct/manifests/radar-files.json`

**Interfaces:**
- Consumes: Task 3、4 的 Dockerfile 和 node12 Docker/Buildx。
- Produces: node12 本地可运行的 `linux/amd64` 镜像；导出包只作为可选回退产物。

- [ ] **Step 1: 写 node12 构建脚本**

脚本固定使用：

```bash
docker buildx build --platform linux/amd64 \
  --load \
  -f deploy/ct/abd-pelvis-ct/gateway/Dockerfile \
  -t med-abd-pelvis-ct-gateway:${TAG} \
  deploy/ct/abd-pelvis-ct/gateway

docker buildx build --platform linux/amd64 \
  --load \
  -f deploy/ct/abd-pelvis-ct/inference/Dockerfile \
  -t med-abd-pelvis-ct-inference:${TAG} \
  deploy/ct/abd-pelvis-ct/inference
```

- [ ] **Step 2: 保留可选导出脚本**

仅在需要迁移到其他机器时导出：

```bash
docker save \
  med-abd-pelvis-ct-gateway:${TAG} \
  med-abd-pelvis-ct-inference:${TAG} \
  | zstd -T0 -3 > abd-pelvis-ct-images-${TAG}.tar.zst
sha256sum abd-pelvis-ct-images-${TAG}.tar.zst > abd-pelvis-ct-images-${TAG}.tar.zst.sha256
```

- [ ] **Step 3: 在 node12 生成镜像并校验**

```bash
ssh node12 'cd /local_data/huojianfan/med-pilotdeck && bash deploy/ct/abd-pelvis-ct/scripts/build-radar.sh dev'
ssh node12 'docker image inspect med-abd-pelvis-ct-gateway:dev --format "{{.Architecture}}"'
ssh node12 'docker image inspect med-abd-pelvis-ct-inference:dev --format "{{.Architecture}}"'
```

预期：两个镜像架构均为 `amd64`，并且已经存在于 node12 本地 Docker。

- [ ] **Step 4: node12 构建前预检**

```bash
ssh node12 'docker info >/dev/null && docker system df && df -h /local_data'
```

如果 base image 无法从 registry mirror 拉取，才切换到 Mac 构建回退方案；不要改用宿主机运行 Python 代替容器。

- [ ] **Step 5: 提交构建脚本**

```bash
git add deploy/ct/abd-pelvis-ct/scripts deploy/ct/abd-pelvis-ct/manifests
git commit -m "build(ct): add abd-pelvis-ct image build and export scripts"
```

---

### Task 6: node12 smoke 与旧内容归档

**Files:**
- Create: `deploy/ct/abd-pelvis-ct/scripts/smoke-radar.sh`
- Modify: `docs/superpowers/specs/2026-11-20-ct-docker-packaging-design.md`

**Interfaces:**
- Consumes: Task 5 的 node12 本地镜像。
- Produces: RADAR gateway/inference 的真实 GPU smoke 结果和可回滚迁移记录。

- [ ] **Step 1: 写 smoke 脚本**

至少检查：

```bash
curl -fsS http://127.0.0.1:18221/health
curl -fsS http://127.0.0.1:18120/health
```

然后用真实去标识化 CT 上传到 gateway，验证返回 CSV；没有真实 CT 时，明确标记 `SKIPPED`，不能标记通过。

- [ ] **Step 2: 在 node12 启动本地镜像**

```bash
ssh node12 'docker compose -f /path/to/compose.ct.yml --profile ct up -d'
```

如果 node12 本地镜像不存在，先回到 Task 5 构建；不要修改宿主机 `/local_data` 权限或绕过 Docker。

- [ ] **Step 3: 运行真实 smoke**

```bash
bash deploy/ct/abd-pelvis-ct/scripts/smoke-radar.sh <de-identified-ct-path>
```

预期：

- inference 模型成功加载；
- gateway 能调用 inference；
- 返回 RADAR 评分 CSV；
- 不出现 ready 但实际推理失败的情况。

- [ ] **Step 4: 只在新容器通过后归档旧内容**

把 `handoff/`、`integration-artifacts/`、`cache/`、`tmp/`、`__pycache__/` 移到独立归档目录；不要直接删除。  
`handoff` 的两份模型已核对为重复文件，但归档后仍需保留至少一份可恢复副本。

- [ ] **Step 5: 更新文档并提交**

记录镜像 tag、模型 SHA256、smoke 结果和旧目录归档位置。

```bash
git add docs/superpowers/specs/2026-11-20-ct-docker-packaging-design.md deploy/ct/abd-pelvis-ct/scripts
git commit -m "docs(ct): record abd-pelvis-ct radar smoke and migration"
```

---

### 后续任务（不在本计划首轮实现）

- 用真实 CT 验证后移除 Dataset298、`model.safetensors`、`biovil_image_resnet50`；
- 将 `med_radar_*` 工具名、`RADAR_*` 配置名和源码模块名进一步中性化；
- DeepChest 的 gateway/inference 拆包沿用同一模式；
- ~~将 CT Compose 接入 `pilotdeck` 的 `MED_SPECIALIZED_CT_ENABLED=1` 配置~~（2026-11-24 已完成，见下节）。

## 执行记录（2026-11-23）

- Task 1 staging：40 个文件、约 1.98GB，SHA256 全部通过；未包含 handoff、venv、密钥、证书、notices 或缓存。
- Task 2 Compose：使用静态内部网络，服务名不再依赖运行时 DNS。
- Task 3 gateway：镜像约 515MB，不含模型，`app`/`radar_inference` 导入通过。
- Task 4 inference：镜像约 15.6GB，torch `2.7.1+cu126`、monai `1.5.0`、模型文件通过；模型实际加载并返回 `ready:true`。
- Task 5 构建：node12 原生 `linux/amd64` 构建完成。
- Task 6 smoke：真实腹部 CT 上传返回 200，146/146 评分有效，无失败病例；CSV 下载返回 200。
- 临时容器、网络、测试卷已清理；测试镜像保留。

## 主系统接入与切换（2026-11-24）

目标：让 `med-pilotdeck` 通过原有的 `MED_RADAR_API_BASE=http://10.31.112.13:18120`
直接使用 Docker 版服务，不再依赖宿主 `radar-cpu-gateway.service`。

### 发现的问题

1. `docker compose up` 在 `deploy/ct/abd-pelvis-ct/` 下执行时会向上找到仓库根目录的
   `docker-compose.yml`，误构建主系统镜像。**必须显式 `-f deploy/ct/abd-pelvis-ct/compose.ct.yml`。**
2. `inference/entrypoint.sh` 原来把宿主 GPU 序号写进容器内 `CUDA_VISIBLE_DEVICES`，
   与 Compose 的 `device_ids` 形成双重映射，容器内反而看不到任何 GPU
   （`/health` 返回 `ready:false`、`A CUDA device is required`）。已删除该行。
3. 旧 systemd 网关虽然 `/health` 报 `ready:true`，但其依赖的 `127.0.0.1:18221`
   推断服务实际未监听，属于“假健康”。

### 切换步骤

```bash
# 1) 停用旧的宿主网关（unit 文件保留，可随时回滚）
sudo systemctl disable --now radar-cpu-gateway.service

# 2) 启动 Docker 版；对外发布 10.31.112.13:18120 供主系统访问
cd /local_data/huojianfan/med-pilotdeck
ABD_PELVIS_CT_GPU=3 \
ABD_PELVIS_CT_GATEWAY_PUBLISH_HOST=10.31.112.13 \
docker compose -f deploy/ct/abd-pelvis-ct/compose.ct.yml --profile ct up -d
```

回滚：`docker compose ... down` 后 `sudo systemctl enable --now radar-cpu-gateway.service`。

### 验证结果

- `GET http://10.31.112.13:18120/health` → `ok:true`、`ready:true`、
  `inference_api_base=http://172.30.250.10:18221`（证明走的是容器网络）。
- `plugins/med-tools` 客户端 `run_radar_analysis()` 真实上传 36MB NIfTI：
  `ok:true`、`status:completed`、1 例、无 failed case，CSV 落盘。
- MCP 层（`python -m server` + JSON-RPC）验证：工具已注册，
  `med_radar_status` 与 `med_radar_analyze_ct` 均成功返回。
- 容器 `restart: unless-stopped`，Docker 已 `enabled`，node12 重启后自动恢复。
