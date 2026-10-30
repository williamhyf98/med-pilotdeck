# node12 MinerU 远程验收清单

本清单用于 Task 11，必须在 node12 服务真实运行后执行。自动化 fake runtime 测试不能替代真实 GPU 验收。

## 运行时

- [x] `PYTHONPATH=. python -m mineru_service.doctor` 返回 launcher、模型文件、CUDA 和存储均可用。
- [x] `scripts/mineru-node12-cli-smoke.sh sample.pdf` 生成 Markdown、content list 和 model JSON；本页纯文本样本无图片资产。
- [x] 服务使用固定 MinerU 2.6.5，不在线下载模型。
- [ ] 服务用户能读取模型目录，但只能写入 `MINERU_SERVICE_ROOT`。

## SSH 隧道端到端

- [x] node12 服务只监听 `127.0.0.1:18890`。
- [x] Mac 执行 `ssh -N -L 127.0.0.1:18890:127.0.0.1:18890 node12`。
- [x] Mac `GET /health` 能看到 runtime、CUDA、queue 和 storage 状态。
- [x] Mac 通过 MCP 工具入口（remote 模式）提交真实 PDF，观察到运行并成功；HTTP 首次提交返回 202/queued。
- [x] Mac 下载并校验 manifest、Markdown、content list、model、chunks、pages、assets JSONL 和 quality report；样本无图片 assets 文件。
- [x] Mac 本地 bundle 不出现 node12 绝对路径。
- [x] 在同一 remote client 实例中重复提交同一文档得到原 job，已完成结果读取走本地缓存。

## 隔离和失败恢复

- [x] 租户 B 无法查询、下载租户 A 的已知 job、result 和 manifest（均为 404）。
- [x] 声明超过 50 MiB 上传限制的请求头立即返回 413，未创建可运行任务；完整上传超限仍待实测。
- [x] 队列满返回 429。
- [ ] MinerU 超时返回 `job_timeout`，不伪造成功。
- [x] 服务重启后未完成任务变为 `service_restarted`，不继续显示 running。
- [ ] 网络中断后客户端能返回可重试错误，不自动重复提交。
- [ ] 错误响应和 MCP 错误消息不包含 node12 绝对路径、命令、模型目录或其他租户信息。

## HTTPS

- [ ] 反向代理限制来源网段、方法、上传大小和超时。
- [ ] Mac 使用 `https://` API base 和 CA bundle 完成同一套上传、轮询、下载。
- [ ] 错误 CA 或过期证书会失败；客户端没有关闭证书校验。
- [x] Bearer Token 认证生效，缺失和错误凭据均返回 401（SSH 隧道 HTTP 模式）。

2026-10-30 验收记录：`/local_data/huojianfan/mineru-service/samples/mineru-smoke.pdf` 为 1 页 1.5 KiB 英文样本；独立 CLI smoke 也成功产出三种原始文件。真实 HTTP 任务 `d9dd126830aee628c8a10bf2361d44f9` 成功，8 个标准产物从 Mac 下载并逐个校验 SHA-256；remote client 任务 `fee9405e3d629368fce1a4aa88ff7838` 成功，chunks 数量 1；MCP 工具入口任务 `6423e678bf861b1a2ca9aaa72434c5a9` 成功并下载 8 个产物。中途因添加第二租户 token 而重启服务，任务 `67707ebf04111b79469780f838bda137` 返回 `service_restarted`。大文件请求声明 52,500,000 字节，服务在接收正文前返回 413。`python3 -m unittest discover -s plugins/med-tools/tests -p 'test_mineru_*.py' -q` 通过 60 项。尚未实测完整超限上传、实际超时、网络断连与 HTTPS 代理，保留待办。

同日 Mac 上重新生成并上传的独立样本 `.pilotdeck-home/med-tools/mineru-demo/mac-upload-demo.pdf`（1 页）返回任务 `aeb61a5bb878827ce179c6da62facf65`，服务端 `/validate` 为 `ok=true`，Mac 下载 8 个产物，得到 1 页、3 个文本块、0 张图片。原文 `orange satellite marker` 被 OCR 为 `orange satelite marker`，`Example Patient` 与 `Visit date` 间空格丢失；`quality_report.json` 的 `warnings=[]`。该验收只说明服务可用和结构化结果可以消费，不代表 OCR 逐字准确；导入个人知识库前应支持人工预览及重试。

后续决定 embedding 在 Mac 本地执行，还是也服务化到 node12；本阶段未把 embedding 写入 `knowledge.db`。
