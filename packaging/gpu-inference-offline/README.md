# RADAR + DeepChest 离线 GPU 推理交接包

此目录是压缩包内的操作说明。node12 保留上传网关、病例处理和 DeepChest 中文报告生成；GPU 主机只运行两个推理 API。解压后在同一目录内操作，不需要容器、pip、sudo 或联网安装。

**当前候选包预置的是 node12 已验证的 NVIDIA/CUDA PyTorch 环境，并非沐曦或截图所示 Mars/HPCC 后端。** 交付包内有模型、服务、独立 Python、依赖和离线依赖快照；它能离线解压、检查、启动，但在非 NVIDIA GPU 上不能承诺 `torch.cuda` 可用或模型推理成功。`/health` 也不能替代真实 CT 测试。不要在目标机执行 `pip install` 从互联网获取依赖；若 GPU 后端不兼容，反馈 `./doctor.sh` 的输出，再用匹配的厂商 PyTorch/运行时替换两个隔离环境中的 GPU 组件并重新验证。

## 交接给同事

传输 `gpu-inference-offline-*.tar.gz` 和对应 `.sha256`，在 Linux x86_64 主机上：

```bash
sha256sum -c gpu-inference-offline-*.tar.gz.sha256
tar -xzf gpu-inference-offline-*.tar.gz
cd gpu-inference-offline-*/
./verify.sh
cp config.env.example config.env
# 修改 config.env 中绑定 IP、端口、GPU 编号；默认仅监听 127.0.0.1
./doctor.sh
./start.sh radar      # 一个终端
./start.sh deepchest  # 另一个终端
./health.sh
```

`start.sh` 是前台进程，退出可按 Ctrl-C；`config.env` 的 `RADAR_BIND`/`DEEPCHEST_BIND` 可以改成内网地址。生产环境的进程守护、可信 HTTPS/隧道由同事按服务器实际配置接入。以普通用户解压及运行，不需要 sudo；目录需要能容纳解压后的权重、依赖和推理临时文件。

`./smoke.sh radar /绝对路径/去标识化腹部CT.nii.gz` 和 `./smoke.sh deepchest /绝对路径/去标识化胸部CT.nii.gz` 分别验证真实推理。RADAR 输出原始 CSV，DeepChest 输出三个证据组。`./health.sh` 只验证可用性状态，不证明模型准确性。

`./doctor.sh` 会显示 Python、torch 版本、可见 GPU，以及模型导入结果。`torch.cuda.is_available()` 为 false、API 返回 `ready: false` 或启动报错时，保存完整输出和 `private/logs/` 的错误日志用于后续补齐 GPU 后端；**不要将此版本宣称为沐曦已验证版**。

## 包内边界

- `radar/` 和 `deepchest/`：2026-10-14 node12 各自验证的 GPU API 源码及完整模型权重。
- `python/3.10`、`python/3.12`：独立 Linux x86_64 Python；`runtime/radar`、`runtime/deepchest`：彼此隔离的第三方 Python 包和各自 PyTorch；启动脚本通过绝对路径动态定位包目录，可搬动整个解压目录。
- `config.env`：本机创建，作为唯一需要修改的服务配置；`private/`：运行时任务、缓存和日志，不应被重新打入交付包。
- `SHA256SUMS`：生成包时记录源码、权重和运行脚本哈希；外层 `.sha256` 校验整个压缩包。

两个服务分别独占一个 Uvicorn 进程。RADAR 使用 `CUDA_VISIBLE_DEVICES` 选卡，进程内使用 `cuda:0`；DeepChest 用 `DEEPCHEST_INFERENCE_GPU` 指定物理 GPU 编号，内部自行映射为 `cuda:0`。DeepChest 当前需要 CUDA 兼容接口及 TotalSegmentator、nnUNet 算子。某些非 NVIDIA PyTorch 实现暴露 `torch.cuda` 接口，但这不能证明第三方分割算子也可用。

node12 原 RADAR 网关监听 `10.31.112.13:18120`，GPU caller 当前目标为本机 `127.0.0.1:18221`；DeepChest 网关监听 `10.31.112.13:18130`，GPU caller 当前目标为本机 `127.0.0.1:18330`。先在目标机运行真实 CT smoke，接好内网可信 HTTPS 或 node12 本地回环隧道后再调整两个 caller 地址，测试完整上传链路后才关闭 node12 原 GPU 服务。DeepChest caller 只接受可信 HTTPS 或 loopback HTTP，不可直接换为远端明文 `http://IP`。本包不包括 node12 的网关、报告生成、患者数据、密钥、证书和 GPU 内核驱动。

包内权重和第三方代码来自既有交接包，转交同事以外的第三方或用于临床前，应复核原使用与分发条款。源交接包的验证范围详见 `SOURCE-VALIDATION.md`；这不等于本离线候选包在其他 GPU 上通过验收。
