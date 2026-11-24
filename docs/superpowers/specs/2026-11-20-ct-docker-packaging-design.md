# CT Docker 打包设计（RADAR + DeepChest）

日期：2026-11-20  
状态：设计已确认，进入 RADAR 实施计划  
范围：node12 `/local_data/huojianfan` 下的 RADAR、DeepChest，以及它们的最小运行时、模型和配置

## 0. 已确认决策（2026-11-20）

- 用户可见名称：`腹盆CT分析`
- 交付技术名：`abd-pelvis-ct`
- CT 推理镜像：
  - `med-abd-pelvis-ct-gateway`
  - `med-abd-pelvis-ct-inference`
- 先实施 RADAR（对外不再使用旧名称），DeepChest 随后。
- 第一版先保留 Dataset298、`model.safetensors`、`biovil_image_resnet50`，真实 CT smoke 后再移除。
- 采用 node12 原生构建和运行 `linux/amd64` 镜像；Mac 构建只作为基础镜像拉取失败时的回退方案。
- node12 内存/磁盘不作为当前 RADAR 阶段的阻塞条件，构建后按实际 `docker system df` 检查。
- 用户已明确确认授权允许，不保留 notices、版权和引用文件；不把 notices 写入发布包或镜像。
- `RADAR` 旧名只允许出现在历史源码、测试、迁移说明或兼容别名中；用户可见文案、镜像名、Compose 服务名和交付包目录使用 `腹盆CT分析` / `abd-pelvis-ct`。

### 名称映射

| 旧源码/历史名 | 交付层名称 |
|---|---|
| `RADAR`（用户可见文案） | `腹盆CT分析` |
| `med-radar-gateway` | `med-abd-pelvis-ct-gateway` |
| `med-radar-inference` | `med-abd-pelvis-ct-inference` |
| `radar-gateway`（Compose 服务） | `abd-pelvis-ct-gateway` |
| `radar-inference`（Compose 服务） | `abd-pelvis-ct-inference` |
| 交付目录 `radar/` | `abd-pelvis-ct/` |

首轮实现为降低破坏风险，允许实际推理源码内部保留旧的模块名、函数名和第三方模型文件名；这些不属于用户可见或交付层名称。若后续要求镜像源码层也完全不出现旧名，再安排独立的兼容性重命名任务。

## 1. 背景与目标

当前 `med-pilotdeck` 的 Dockerfile 只覆盖通用应用镜像，不能直接用于医疗 CT 功能：

- 没有打包 `plugins/med-tools`；
- 没有 Python/med-tools venv；
- 没有 RADAR、DeepChest、Office Renderer 等服务编排；
- 没有 GPU、模型、任务卷、服务健康检查；
- 当前 node12 上 RADAR 和 DeepChest 的实际部署目录包含大量历史产物、宿主运行时和重复模型。

本次选择“方案 A”：保留可选服务包，不把 Qwen3.8-27B、G9-V-Med、MinerU 放进包内。第一阶段的交付范围只包含 CT：

```text
CT = RADAR + DeepChest
```

目标：

1. 将 RADAR 和 DeepChest 做成可独立构建、独立启动、独立升级的 Docker 服务；
2. 只保留运行时需要的代码、模型、配置和 Python 依赖；
3. 将历史 handoff、测试输出、任务数据、宿主 venv/runtime 排除出镜像；
4. RADAR 和 DeepChest 的模型与服务代码可以放进同一个“推理镜像”，但不放进应用镜像；
5. 在 node12 现有磁盘和 Docker 权限条件下给出可执行的构建与迁移路径；
6. 清理前不删除当前正在运行的服务数据，先 staging、验证、再归档或删除。

非目标：

- 不打包 MinerU；
- 不打包 Qwen、G9、embedding、reranker；
- 不做一个包含 RADAR、DeepChest 网关和推理的超大单镜像；
- 不把真实密钥、证书、患者数据、任务数据打进镜像；
- 不在本轮删除 node12 正在使用的目录。

反向目标（出现即视为设计失败）：

- 网关镜像携带几 GB 的 CT 模型；
- 推理镜像复制宿主 `.runtime` 或 `.venvs`；
- 只依据 `/health` 判定 CT 可用；
- 依赖 node12 当前 28.5G 可用空间直接在本地构建全部镜像和缓存。

## 2. 当前节点事实

### 2.1 运行时与端口

| 服务 | 当前形态 | 端口 | 关键运行时 |
|---|---|---:|---|
| RADAR 网关 | `radar-gpu-poc/app.py` | 18120 | Python 3.10.12 |
| RADAR GPU API | `radar-gpu-poc/gpu_api.py` | 18221 | Python 3.10.12、torch 2.7.1+cu126、MONAI 1.5.0 |
| DeepChest 网关 | `3D-MLLM-remote-poc/service` | 18130 | Python 3.12.13 |
| DeepChest GPU 推理 | `inference_api.py` | 18330 | Python 3.12.13、torch 2.10.0+cu128 |
| DeepChest 回答模型 | 外部 Qwen | 8040 或配置地址 | 不属于 CT 镜像 |

当前 RADAR 只观察到 18120 的 `app.py` 进程，18221 没有监听，但 `/health` 仍可能显示 ready。新的 Compose 方案必须把 RADAR 的推理入口作为独立服务纳入健康检查，不能继承这个“健康接口自报 ready”的问题。

### 2.2 实际代码与仓库模板不一致

实际部署代码与 `plugins/med-tools` 里的模板并不相同：

- RADAR 部署侧有 `gpu_api.py`、`radar_inference.py`，仓库模板没有；
- DeepChest 部署侧有 `inference_api.py`、`remote_inference.py`，仓库模板没有；
- 两边的 `app.py`、`worker.py` 也存在差异。

因此：

```text
实际运行目录 = 本次打包的代码事实来源
仓库模板 = 只作为参考，不能直接覆盖实际部署
```

实施前应把实际部署目录中最小的运行文件快照到 `deploy/ct/vendor/`，并记录 SHA256。

### 2.3 磁盘与 Docker 状态

截至 2026-11-20：

| 项目 | 现状 |
|---|---:|
| `/local_data` 可用 | 约 28.5G（约 30.6 GB） |
| `/` 可用 | 约 6.4G |
| Docker data-root | `/local_data/docker` |
| Docker client | 已安装 |
| Docker daemon | 运行中，但 `huojianfan` 无 socket 权限 |
| Docker Compose | 未安装 |
| Docker Buildx | 未安装 |
| NVIDIA Container Toolkit | 已安装 |
| bwrap | 0.6.1 已安装 |

结论：**CT 的源文件和模型可以放进约 4.5G 的上下文，但 node12 当前不适合在本地完成完整的 CUDA 镜像构建、缓存和导出。**

## 3. 清理审计

### 3.1 RADAR

当前约 6.0G，最小运行时约 1.9G。

保留：

```text
radar/
├── app.py
├── gpu_api.py
├── radar_inference.py
├── requirements.txt
├── damo-radar/
│   ├── RADAR_inference/
│   ├── ckpt/infer_text_embedding_radar.pt
│   ├── LICENSE
│   └── requirements.txt
├── models/
│   ├── checkpoint_radar_pretrain.pth
│   └── bert-base-chinese/
└── config/
    ├── gateway.env.example
    └── gpu.env.example
```

排除或归档：

| 内容 | 处理 |
|---|---|
| `handoff/radar-gpu-handoff/` | 与 `models/` 重复，归档后移出构建上下文 |
| `handoff/radar-gpu-handoff-keyless-20261013/` | 与 `models/` 重复，归档后移出构建上下文 |
| `venv/` | 宿主环境，镜像内重建 |
| `cache/`、`tmp/`、`__pycache__/` | 运行缓存，不进入镜像 |
| `integration-artifacts/` | 测试产物，不进入镜像 |
| `gateway-work/`、`gpu-work/` | 运行任务目录，使用 volume，不进入镜像 |
| `damo-radar/docs/` | 文档，不进入运行时 |
| `damo-radar/download_scripts/` | 下载脚本，不进入运行时 |
| `config/inference-api.key` | 密钥，严禁进入镜像 |
| `config/gpu.env.before-gpu6-20261019` | 历史备份，不进入镜像 |
| `radar.service` | systemd 单元，不进入容器 |

重复性已验证：

```text
models/checkpoint_radar_pretrain.pth
handoff/radar-gpu-handoff/models/checkpoint_radar_pretrain.pth
handoff/radar-gpu-handoff-keyless-20261013/models/checkpoint_radar_pretrain.pth
```

三份 SHA256 相同：

```text
5e8b1b50b92162fcafcf8231e51ffbe9d1be2be52ccff4f967e4beb71e4499f4
```

BERT 模型三份也完全一致。`handoff` 可以安全归档。

### 3.2 DeepChest

当前约 29G，主要体积不是模型，而是宿主运行时和历史产物：

| 内容 | 体积 | 处理 |
|---|---:|---|
| `.runtime/python` | 约 24G | 宿主专用，镜像内重建 |
| `.venvs/radar` | 约 1.1G | 宿主专用，镜像内重建 |
| `models/` | 约 3.2G | 保留，按白名单去重 |
| `artifacts/` | 约 579M | 历史输出，归档 |
| `data/` | 约 131M | 评测数据，归档 |
| `service/jobs/` | 约 56M | 任务数据，移出镜像 |
| `service/benchmarks/` | 约 109M | 基准数据，归档 |
| `service/remote-inference/` | 约 33M | 只保留环境示例，其余归档 |
| `third_party/damo-radar-*` | 约 13M | DeepChest 当前链路不需要 |
| `experiments/` | 约 232K | 只保留 GPU 推理需要的两个脚本 |

#### GPU 推理最小集合

```text
deepchest-inference/
├── service/deepchest_service/
│   ├── __init__.py
│   ├── evidence.py
│   ├── inputs.py
│   └── inference_api.py
├── experiments/3dmedagent_repro/
│   ├── segment_deepchest.py
│   └── run_ctclip_deepchest.py
├── third_party/3DMedAgent-official/
│   └── CT_Clip/
├── models/
│   ├── CT-CLIP_v2.pt
│   ├── ct_clip/CT-CLIP_v2.pt -> ../CT-CLIP_v2.pt
│   ├── biomedvlp/
│   │   ├── config.json
│   │   ├── configuration_cxrbert.py
│   │   ├── modeling_cxrbert.py
│   │   ├── pytorch_model.bin
│   │   ├── special_tokens_map.json
│   │   ├── tokenizer_config.json
│   │   └── vocab.txt
│   └── totalsegmentator/
│       ├── config.json
│       ├── weights/Dataset297_TotalSegmentator_total_3mm_1559subj.zip
│       └── nnunet/results/Dataset297_.../
└── .venvs/radar/bin/python -> 容器内 Python
```

#### 网关最小集合

```text
deepchest-gateway/
└── service/deepchest_service/
    ├── __init__.py
    ├── app.py
    ├── answer.py
    ├── evidence.py
    ├── inputs.py
    ├── remote_inference.py
    ├── worker.py
    └── requirements.txt
```

网关不需要 CT-CLIP、BiomedVLP、TotalSegmentator 或 CUDA。

#### 模型去重建议

`inference_api.py` 明确检查：

```text
models/biomedvlp/pytorch_model.bin
models/totalsegmentator/weights/Dataset297_TotalSegmentator_total_3mm_1559subj.zip
```

所以第一版必须保留 `pytorch_model.bin` 和 Dataset297 zip。

建议先移入 `retired/`、经真实 CT smoke 后再决定删除：

- `models/biomedvlp/model.safetensors`（约 438M，当前 DeepChest 代码没有显式引用）；
- `models/biomedvlp/biovil_image_resnet50_proj_size_128.pt`（约 103M，当前链路未显式引用）；
- `models/totalsegmentator` 的 Dataset298 及其 zip（约 135M，当前 fast 模式只检查 Dataset297）；
- `third_party/damo-radar-src`、`third_party/damo-radar-download`；
- `service/remote-inference/backups-*`、历史 `pending-independence/`、测试脚本和日志；
- `service/device-mode-backup-20261012/`；
- `service/certs/`、`service/secrets/`、`service/jobs/`、`service/benchmarks/`；
- `.DS_Store`、`._.DS_Store`、`__pycache__/`。

清理后 DeepChest 的代码 + 模型上下文预计约 **2.5–3.2G**。

## 4. 方案选择

### 方案 A：一个 CT 超级镜像

把 RADAR、DeepChest 网关、DeepChest 推理、两套 Python/CUDA 环境和所有模型放进一个镜像。

不采用。原因是：

- Python 3.10 与 3.12、torch 2.7+cu126 与 2.10+cu128 不兼容；
- 一个服务重启影响全部；
- GPU 分配不清晰；
- 无法分别升级模型和网关；
- 镜像和构建缓存过大。

### 方案 B：按服务拆分镜像，模型与推理代码同镜像

采用。结构为：

```text
med-abd-pelvis-ct-gateway
med-abd-pelvis-ct-inference
med-deepchest-gateway
med-deepchest-inference
```

腹盆CT分析和 DeepChest 的推理镜像包含各自的模型和 Python/CUDA 运行时；网关镜像只包含上传、任务、报告和远程推理客户端。这样既能保持模型版本与代码版本一致，又不会让网关携带模型。

### 方案 C：模型全部放外部只读卷

作为后续可选方案保留，但本次不选。理由：

- 本次是小模型、一次性交付，模型与代码同镜像更容易保证可复现；
- 独立模型卷会增加挂载、权限、版本对齐和现场误配风险；
- 如果以后模型需要独立升级，再把推理镜像中的模型目录改为 volume 即可。

## 5. 目标服务拓扑

```text
pilotdeck / med-tools
  ├─ http://abd-pelvis-ct-gateway:18120
  │     └─ http://abd-pelvis-ct-inference:18221
  └─ http://deepchest-gateway:18130
        └─ http://deepchest-inference:18330
```

服务表：

| 服务 | 镜像 | GPU | 模型 | 端口 |
|---|---|---:|---|---:|
| `abd-pelvis-ct-gateway` | `med-abd-pelvis-ct-gateway` | 否 | 否 | 18120 |
| `abd-pelvis-ct-inference` | `med-abd-pelvis-ct-inference` | 是 | RADAR + BERT（源码内部名） | 18221 |
| `deepchest-gateway` | `med-deepchest-gateway` | 否 | 否 | 18130 |
| `deepchest-inference` | `med-deepchest-inference` | 是 | CT-CLIP + BiomedVLP + TotalSegmentator | 18330 |

容器内使用 Compose 服务名，不使用 `127.0.0.1` 或 `10.31.112.13`。如果 `pilotdeck` 仍在宿主机而不是同一 Compose 网络，仅将 18120/18130 发布到 `127.0.0.1`，不要暴露到公网。

## 6. 镜像布局

### 6.1 `med-abd-pelvis-ct-inference`

- 基础：匹配 Python 3.10 + torch 2.7.1+cu126 的 CUDA 运行时镜像；
- 工作目录：`/opt/radar`；
- 代码：`app.py` 不需要，`gpu_api.py`、`radar_inference.py`、`damo-radar/`；
- 模型：`models/checkpoint_radar_pretrain.pth`、`models/bert-base-chinese/`；
- 启动：`python gpu_api.py --host 0.0.0.0 --port 18221`；
- 数据：`/var/lib/radar/work` 由 volume 提供；
- 模型只读，不允许运行时改写。

### 6.2 `med-abd-pelvis-ct-gateway`

- 基础：Python 3.10 slim；
- 代码：`app.py`、`radar_inference.py`；
- 不包含模型；
- 启动时设置：

```env
RADAR_INFERENCE_API_BASE=http://radar-inference:18221
RADAR_SERVICE_ROOT=/opt/radar-gateway
RADAR_WORK_ROOT=/var/lib/radar/gateway-work
```

### 6.3 `med-deepchest-inference`

- 基础：匹配 Python 3.12 + torch 2.10.0+cu128 的 CUDA 运行时镜像；
- 工作目录：`/opt/deepchest`；
- 代码：`inference_api.py`、`inputs.py`、`evidence.py`、两个实验脚本、`third_party/3DMedAgent-official/CT_Clip/`；
- 模型：CT-CLIP、BiomedVLP、Dataset297；
- 在镜像内创建：

```text
/opt/deepchest/.venvs/radar/bin/python -> /usr/local/bin/python
/opt/deepchest/.venvs/radar/bin/TotalSegmentator
```

- 启动：`python -m uvicorn deepchest_service.inference_api:app --host 0.0.0.0 --port 18330 --workers 1`；
- 数据：GPU work/log 目录使用 volume。

### 6.4 `med-deepchest-gateway`

- 基础：Python 3.12 slim；
- 代码：`app.py`、`worker.py`、`remote_inference.py`、`answer.py`、`evidence.py`、`inputs.py`；
- 不包含模型；
- 启动时设置：

```env
DEEPCHEST_DEVICE=remote
DEEPCHEST_INFERENCE_API_BASE=http://deepchest-inference:18330
DEEPCHEST_WORK_ROOT=/var/lib/deepchest/gateway-jobs
FINAL_TEST_OPENAI_BASE_URL=<外部 Qwen 地址>
```

## 7. 模型与代码同镜像的结论

可以，且本设计采用：

- `radar-inference`：代码 + RADAR 模型 + CUDA/Python；
- `deepchest-inference`：代码 + DeepChest 模型 + CUDA/Python；
- `radar-gateway`、`deepchest-gateway`：仅代码，不带模型。

原因：

1. 模型较小，分别为约 1.9G 与约 2.5–3.2G；
2. 模型与推理代码版本耦合，镜像 digest 可以同时锁定两者；
3. 离线部署不需要额外挂载模型目录；
4. 网关不带模型，避免重复 3G 左右的文件；
5. 两个推理服务使用不同 CUDA/Python 版本，拆分比合并更可靠。

代价：

- 模型更新需要重新构建推理镜像；
- 镜像比“纯代码”大；
- 如果以后模型独立升级，需要改成只读 model volume。

## 8. 清理实施规则

本轮只写设计，不执行删除。实施时按以下顺序：

1. 创建 `deploy/ct/staging`；
2. 只复制白名单文件；
3. 生成 `manifests/ct-files.json`，记录路径、大小、SHA256；
4. 构建镜像并跑真实 smoke；
5. 通过后，将旧 `handoff`、历史输出、旧 backup 移到 `retired/` 或独立归档盘；
6. 最后才删除确认无用的重复文件。

不得在容器验证前删除：

- 当前正在使用的 `.runtime`、`.venvs`；
- `service/jobs`、`artifacts`、`benchmarks`；
- `service/certs`、`service/secrets`；
- RADAR `models` 或 DeepChest `models`。

## 9. 验证与验收

### 9.1 构建前检查

- `deploy/ct/staging` 不包含 `.runtime`、`.venvs`、`__pycache__`、`.DS_Store`；
- 不包含 `*.key`、`*.pem`、`*.crt`、`service/jobs`、`benchmarks`、`artifacts`；
- 模型 SHA256 与 manifest 一致；
- RADAR 和 DeepChest 模型只出现在各自 inference 镜像。

### 9.2 运行时检查

- `radar-inference /health` 返回模型已加载；
- `radar-gateway /health` 返回连接推理服务成功；
- `deepchest-inference /health` 的 `missing` 为空；
- `deepchest-gateway /health` 的 `device_mode=remote`；
- 通过真实去标识化 CT 走一次完整 `/v1/jobs` 或 `/v1/infer`；
- 检查结果包含 CT-CLIP 三类证据和 RADAR 评分 CSV；
- 不允许只用 `/health` 作为功能验收。

### 9.3 安全与隔离

- 两个 gateway 的 18120/18130 仅绑定回环或内部网络；
- 18221/18330 不发布到宿主机公网；
- 模型目录只读；
- 任务目录使用独立 volume；
- 密钥和证书通过 Docker secret 或只读 secret 文件注入；
- 运行用户不是 root，或至少显式设置只读模型和受限写目录。

## 10. node12 磁盘方案

### 10.1 当前容量

```text
/local_data 可用：约 28.5G
/ 可用：约 6.4G
Docker data-root：/local_data/docker
```

### 10.2 清理后基础包

```text
腹盆CT分析最小上下文      约 1.9G
DeepChest 最小上下文      约 2.5–3.2G
CT 代码和配置            约 30M
--------------------------------
合计约 4.5–5.2G
```

### 10.3 镜像和构建缓存估算

以下为保守估算，取决于 CUDA 基础镜像和 Python wheel 复用：

```text
abd-pelvis-ct-gateway     约 1–2G
abd-pelvis-ct-inference   约 5–8G
deepchest-gateway         约 1–2G
deepchest-inference       约 10–15G
BuildKit 缓存             约 5–15G
镜像导出 tar/压缩暂存     约 10–20G
```

CT-only 的安全构建空间建议至少 **40–50G 可用**；当前 28.5G 不足以安全覆盖“镜像 + 构建缓存 + 导出暂存”。

### 10.4 推荐路径

首选（node12 资源已满足）：

```text
node12
  -> docker buildx build --platform linux/amd64
  -> docker compose up
```

如果基础镜像或 Python wheel 无法从 node12 的镜像源拉取，再回退到 Mac/独立 Linux 构建机，并导出镜像。

如果必须在 node12 本机构建：

- 先清理 Docker 构建缓存；
- 确认 `/local_data/docker` 可用空间至少 40–50G；
- 不在构建期间保留旧镜像 tar；
- 构建完成后立即清掉 BuildKit cache；
- 旧 `.runtime` 和 `.venvs` 只能在 CT 容器验证通过后清理，约可释放 25G。

## 11. 实施顺序

### 阶段 0：冻结与 staging

- 快照实际部署代码；
- 生成文件清单和 SHA256；
- 复制最小 CT 上下文；
- 不停止现有 RADAR/DeepChest 服务。

### 阶段 1：RADAR 镜像

- 构建 `med-radar-inference`；
- 构建 `med-radar-gateway`；
- 用真实 CT 或已有验收样本验证。

### 阶段 2：DeepChest 镜像

- 构建 `med-deepchest-inference`；
- 构建 `med-deepchest-gateway`；
- 验证 GPU API 和完整报告链路。

### 阶段 3：Compose 接入

- 新增 `compose.ct.yml` 和 `ct` profile；
- 将 `pilotdeck` 的 `MED_RADAR_API_BASE`、`MED_DEEPCHEST_API_BASE` 指向 Compose 服务；
- 保持 `MED_SPECIALIZED_CT_ENABLED=1`。

### 阶段 4：迁移与清理

- 并行运行旧服务和新容器；
- 对比同一 CT 的结果和产物；
- 切换流量；
- 归档旧 handoff、旧 runtime、旧任务数据；
- 最后删除确认无用的重复文件。

## 12. 待确认事项

1. 是否接受“RADAR 也拆成 gateway + inference”，以修复当前 18221 未监听但 `/health` 仍显示 ready 的问题；
2. 第一版是否暂时保留 `Dataset298`、`model.safetensors`、`biovil_image_resnet50`，等真实 CT smoke 后再移除；
3. 模型许可证和部署用途是否满足内部交付要求，尤其 BiomedVLP 的 README 标注研究用途；
4. node12 的 Docker registry mirror 和 PyPI 镜像是否需要进一步调整；
5. node12 的 Docker 权限已具备，后续是否保留 root key 和 docker 组权限。

## 13. 验收标准

- RADAR 与 DeepChest 各有 gateway 和 inference 镜像；
- 推理镜像携带模型，网关镜像不携带模型；
- 最小上下文不含 `.runtime`、`.venvs`、jobs、benchmarks、artifacts、历史备份和密钥；
- 清理后源文件约 4.5–5.2G；
- node12 不因构建过程耗尽 `/local_data`；
- 真实去标识化 CT 完成一次 RADAR 和一次 DeepChest 推理；
- RADAR/DeepChest 的 `/health` 与实际推理入口一致，不再出现“健康但推理不可用”；
- 旧服务在新容器验证通过前保持可回滚。

## 14. RADAR 首轮执行记录（2026-11-23）

- node12 已成功构建：
  - `med-abd-pelvis-ct-gateway:dev`，约 515MB；
  - `med-abd-pelvis-ct-inference:dev`，约 15.6GB。
- inference 使用 node12 已验证的 `torch 2.7.1+cu126` 作为 named build context，避免 PyTorch CDN 长时间不稳定；镜像内 `torch/monai/transformers` 导入正常。
- Compose 使用静态内部网络 `172.30.250.0/24`，规避 node12 自定义 Docker DNS 对服务名解析不稳定的问题。
- gateway 依赖 inference 的 `service_healthy`；健康检查要求 inference `ready=true`、gateway `ok=true`。
- 使用 `Slicer_CTAAbdomenPanoramix.nii.gz` 完成真实 smoke：
  - HTTP 200；
  - 1 个病例；
  - 146 个评分全部有效；
  - 无 failed cases；
  - CSV 下载接口返回 200。
- 测试容器、临时网络和测试卷已清理；镜像保留在 node12。
- node12 现有 RADAR/DeepChest 业务进程未被停止或修改。

## 15. 主系统接入（2026-11-24）

- 端口发布改为可配置：`ABD_PELVIS_CT_GATEWAY_PUBLISH_HOST/PORT`、`ABD_PELVIS_CT_INFERENCE_PUBLISH_HOST/PORT`；
  主系统在别的机器时把网关发布到内网 IP，`MED_RADAR_API_BASE` 保持 `http://10.31.112.13:18120` 不变。
- GPU 选择统一由 Compose 的 `device_ids` 负责（`ABD_PELVIS_CT_GPU` 是宿主序号，
  容器内一律 `cuda:0`）；entrypoint 不再改写 `CUDA_VISIBLE_DEVICES`。
- Compose v2 会向上层目录寻找 compose 文件，所有命令必须带
  `-f deploy/ct/abd-pelvis-ct/compose.ct.yml`。
- 旧 `radar-cpu-gateway.service` 已 `disable`，其推断后端 `18221` 此前已不可用；
  unit 文件保留用于回滚。
- 真实链路验证通过：MCP `med_radar_status` / `med_radar_analyze_ct` 在 Docker 后端上返回
  `ok:true`、1 例、0 failed，CSV 正常落盘。
