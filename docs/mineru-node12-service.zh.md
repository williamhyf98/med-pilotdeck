# node12 MinerU 服务部署

本文档对应 `plugins/med-tools/mineru_service`。node12 只运行 MinerU HTTP 服务，Mac 通过本地 stdio MCP 的 remote 模式调用它。

## 固定运行时

首轮固定使用已验收的 MinerU 2.6.5：

```text
Python: /local_data/medical/Med-Rag/UltraRAG/.venv/bin/python
模型:   /local_data/models/opendatalab/PDF-Extract-Kit-1___0
GPU:    CUDA，node12 上的 NVIDIA A800
监听:   127.0.0.1:18890
```

不要在服务启动时下载模型，也不要在 2.6.5 和 2.7.0 之间自动切换。2.7.0 只作为后续对照运行时。

实际部署根目录为 `/local_data/huojianfan/mineru-service/`：`code/` 存放服务代码，`jobs/` 存放每个 token 租户的输入和结果，`private/service.env` 和 `private/api-tokens.env`（权限 0600）存放配置与凭据，`samples/` 存放验收 PDF。运行时依旧使用 UltraRAG 已安装的 Python/MinerU，模型从既有目录只读引用。单独部署 `server/rag` 子集时，其 `__init__.py` 必须保持最小化，避免加载未部署的通用 RAG 模块。

新的环境可参考以下模板；当前 node12 已配置完成，无需重新生成 token：

```bash
cp plugins/med-tools/mineru_service/service.env.example /local_data/huojianfan/mineru-service/private/service.env
```

修改 `MINERU_SERVICE_ROOT`、token 文件路径和部署侧路径。真实 token、CA 证书和环境文件不提交到 Git。

token 文件支持以下格式，每行一个租户：

```text
tenant-a=随机的长 token
tenant-b=另一个随机的长 token
```

token 通过 Bearer header 认证；租户名来自服务端 token 映射，不接受请求体中的 `user_id` 作为授权依据。

## Doctor 和 CLI smoke

在 node12 上执行：

```bash
set -a
. /local_data/huojianfan/mineru-service/private/service.env
set +a
cd /local_data/huojianfan/mineru-service/code
PYTHONPATH=. /local_data/medical/Med-Rag/UltraRAG/.venv/bin/python -m mineru_service.doctor
./mineru-cli-smoke.sh /local_data/huojianfan/mineru-service/samples/mineru-smoke.pdf
```

doctor 会检查 launcher、模型目录、模型文件、CUDA、服务目录可写性和 MinerU 版本。smoke 使用临时输出目录，不修改 UltraRAG 既有产物。

## 启动服务

服务由下述 user systemd 管理；手动调试只绑定回环地址，且必须先停止 systemd 服务以免端口冲突：

```bash
cd /local_data/huojianfan/mineru-service/code
set -a
. /local_data/huojianfan/mineru-service/private/service.env
set +a
PYTHONPATH=. /local_data/medical/Med-Rag/UltraRAG/.venv/bin/python -m uvicorn \
  mineru_service.app:configured_app \
  --factory --host 127.0.0.1 --port 18890 --workers 1
```

必须保持 `--workers 1`。任务队列和 CUDA worker 不支持多个 Uvicorn worker 共享同一工作目录。

node12 已配置 `~/.config/systemd/user/pilotdeck-mineru.service`（linger 开启）。systemd 的 `EnvironmentFile` 只读取部署配置，`ExecStart` 仍固定为单 worker：

```ini
[Unit]
Description=PilotDeck MinerU HTTP service
After=network.target

[Service]
WorkingDirectory=/local_data/huojianfan/mineru-service/code
EnvironmentFile=/local_data/huojianfan/mineru-service/private/service.env
Environment=PYTHONPATH=/local_data/huojianfan/mineru-service/code
ExecStart=/local_data/medical/Med-Rag/UltraRAG/.venv/bin/python -m uvicorn mineru_service.app:configured_app --factory --host 127.0.0.1 --port 18890 --workers 1
Restart=on-failure
UMask=0077

[Install]
WantedBy=default.target
```

运维命令：`ssh node12 'systemctl --user status pilotdeck-mineru.service'`；查看日志用 `journalctl --user -u pilotdeck-mineru.service -n 100 --no-pager`。Mac 侧凭据保存为 `~/.config/pilotdeck/mineru-node12.token`（0600），不要输出 token 值。当前上传上限 50 MiB、队列容量 1、任务保留 24 小时；服务不对局域网直接监听。服务配置文件不应由其他用户读取。

## GPU 占用与任务生命周期

常驻的 `pilotdeck-mineru.service` 是一个 Uvicorn HTTP 进程，负责鉴权、接收文件、队列、状态查询与下载；空闲时不加载 MinerU CUDA 模型、不持续占用 GPU 显存。接到 PDF 任务时，worker 才启动独立的 `python -m mineru.cli.client` 子进程，以 `-b pipeline -m ocr -d cuda --source local` 使用 node12 的 GPU 和本地模型。子进程解析结束后退出并释放其显存；HTTP 服务继续常驻。**node12 上其他程序的 GPU 占用不会随 MinerU 任务结束而消失**，解析时仍可能与它们竞争显存和算力。2026-10-30 空闲核查：systemd 服务正常、无 MinerU CLI 子进程，服务 PID 不在 `nvidia-smi` 计算进程列表中。

目前仅允许一个正在处理的任务（`MINERU_SERVICE_MAX_JOBS=1`）；忙时新上传可能收到 429，需要由调用方稍后重试。单任务最长 3600 秒，完成状态在 node12 保留 24 小时。PDF 即便只有一页，也需要初始化模型，首次运行可能明显慢于普通 HTTP 请求。`DOC`、`DOCX`、`TXT` 走轻量文本提取，不执行 MinerU PDF OCR；成功后仍采用相同的标准化产物契约。

## 从上传到获得解析结果

1. **入口**：Mac 把文档保存于当前 `PILOT_HOME` 下，通过本地 `mineru-ingest-tools` stdio MCP 的 `submit` 工具发送；remote client 将文件内容以 `multipart/form-data` 通过 SSH 隧道上传至 node12 的 `POST /v1/mineru/jobs`。node12 本机也可调用同一 HTTP API。开发环境 HTTP 只在两个端点的回环地址上使用。
2. **接收和排队**：服务用 Bearer token 确定租户，检查文件类型和 50 MiB 大小限制，将原文存入 `/local_data/huojianfan/mineru-service/jobs/tenants/<租户>/jobs/<job_id>/input/`，计算 SHA-256，返回 HTTP 202 和任务 ID。不能通过请求参数指定 node12 的本地路径或用户身份。
3. **解析和切块**：任务状态从 `queued` 进入 `running`；PDF 在 node12 上启动 GPU 子进程，生成 Markdown、content list 与 model JSON。`MinerUIngestService` 再按页面和章节切块，产生 `corpus/chunks.jsonl`、`pages.jsonl`、`assets.jsonl`、质量报告和 manifest。此阶段**不生成 embedding，也不写个人知识库数据库**。
4. **轮询和回传**：Mac/MCP 用 `GET /v1/mineru/jobs/{job_id}` 轮询到 `succeeded` 或 `failed`；成功后先获取 `/result` 的产物清单，再按登记路径下载各文件，并按大小和 SHA-256 校验；`/validate` 可验证服务端产物。Mac 将下载副本写入当前用户的 `$PILOT_HOME/med-tools/mineru-ingest/jobs/<job_id>/`，以后可在本地读取、预览。若用户要的是正文，需读取下载的 Markdown 或 chunks；`submit` 的即时响应仅含任务状态，并不会直接返回全文。

2026-10-30 从 Mac 上传一页合成英文 PDF 的实测结果：1 页、3 个 chunks、0 个图片资产，上传、解析、下载和校验均成功。但识别把原文 `satellite` 输出为 `satelite`，并合并了部分空格；质量报告的 `warnings` 为空。**产物完整性校验不等于文本准确性保证**，未来导入界面应提供解析预览，必要时允许重试或人工修正。见 `docs/mineru-node12-acceptance.zh.md`。

## API 和数据边界

```text
GET  /health
POST /v1/mineru/jobs
GET  /v1/mineru/jobs/{job_id}
GET  /v1/mineru/jobs/{job_id}/result
GET  /v1/mineru/jobs/{job_id}/validate
GET  /v1/mineru/jobs/{job_id}/artifacts/{artifact_name}
```

上传使用 `multipart/form-data` 的 `file` 字段。请求不能包含 `source_path`、`output_path`、`model_root` 或其他 node12 路径。服务端为每个 token 租户生成独立目录，并限制上传大小、队列容量、任务超时和输出保留时间。

结果只允许下载：

```text
manifest.json
quality_report.json
corpus/chunks.jsonl
corpus/pages.jsonl
corpus/assets.jsonl
assets/**
mineru_raw/**/{stem}.md
mineru_raw/**/{stem}_content_list.json
mineru_raw/**/{stem}_model.json
```

每个 artifact 都有 SHA-256。服务端不会开放任意路径下载，也不会把 node12 绝对路径、模型路径或其他租户信息返回给客户端。

## Mac 开发调用

node12 服务保持监听 `127.0.0.1:18890`，Mac 建立 SSH 隧道：

```bash
ssh -N -L 127.0.0.1:18890:127.0.0.1:18890 node12
```

Mac 用户目录中的 `med-tools/mineru-ingest.env` 使用：

```env
MED_RAG_MINERU_REMOTE_MODE=remote
MED_RAG_MINERU_API_BASE=http://127.0.0.1:18890
MED_RAG_MINERU_API_TOKEN_FILE=/Users/william/.config/pilotdeck/mineru-node12.token
```

SSH 隧道是开发访问方式，不能将 node12 的明文 HTTP 端口直接暴露到内网。
本机开发安装的配置文件为项目根 `.pilotdeck-home/med-tools/mineru-ingest.env`（`MED_RAG_MINERU_REMOTE_MODE=remote`）。该路径只在 MCP 子进程的 `PILOT_HOME` 指向项目根 `.pilotdeck-home` 时自动生效；多用户网关将 `PILOT_HOME` 指向 `users/<id>`，需要在对应用户目录单独配置或显式设置 `MED_RAG_MINERU_CONFIG_FILE`，并为各用户签发独立 token 后再开放上传。本地服务启动前应建立隧道，否则提交任务会报连接失败。其他 Mac 用户应将 token 文件路径改为自己的绝对路径。`/local_data/huojianfan/mineru-service/private/api-tokens.env` 当前只保留 `pilotdeck` 租户；第二租户的验收 token 已撤销。

## 生产 HTTPS

生产访问链路应为：

```text
Mac/node12 PilotDeck -> HTTPS reverse proxy -> 127.0.0.1:18890
```

反向代理至少配置：

- 证书和完整 CA 链；
- Bearer Token 或 mTLS；
- 只允许受控来源网段；
- 只允许上述 HTTP 方法和路径；
- 上传大小不大于服务端限制；
- 上传、读取和上游超时不小于单任务约束；
- 不暴露 `/docs`、`/redoc` 或 `/openapi.json`。

Mac remote client 默认校验证书。遇到证书问题应修复 CA 配置，不得通过关闭 TLS 校验绕过。
