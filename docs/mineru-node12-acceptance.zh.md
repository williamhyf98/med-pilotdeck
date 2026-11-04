# node12 MinerU 远程验收清单

本清单用于 Task 11，必须在 node12 服务真实运行后执行。自动化 fake runtime 测试不能替代真实 GPU 验收。

## 运行时

- [x] `PYTHONPATH=. python -m mineru_service.doctor` 返回 launcher、模型文件、CUDA 和存储均可用。
- [x] `scripts/mineru-node12-cli-smoke.sh sample.pdf` 生成 Markdown、content list 和 model JSON；本页纯文本样本无图片资产。
- [x] 服务使用固定 MinerU 2.6.5，不在线下载模型。
- [ ] 服务用户能读取模型目录，但只能写入 `MINERU_SERVICE_ROOT`。

## node12 内网直连

- [x] node12 服务监听 `node12` 内网地址 `10.31.112.13:18890`，不再只监听 `127.0.0.1`。
- [x] Mac 直接访问 `http://10.31.112.13:18890`，不依赖 SSH 隧道。
- [x] Mac `GET /health` 能看到 runtime、CUDA、queue、storage 和 trusted-internal 状态。
- [ ] Mac 通过 MCP 工具入口（remote 模式）提交真实 PDF，观察到运行并成功；HTTP 首次提交返回 202/queued。
- [x] Mac 下载并校验 manifest、Markdown、content list、model、chunks、pages、assets JSONL 和 quality report；样本无图片 assets 文件。
- [x] Mac 本地 bundle 不出现 node12 绝对路径。
- [x] 在同一 remote client 实例中重复提交同一文档得到原 job，已完成结果读取走本地缓存。

## 隔离和失败恢复

- [x] 每个任务使用随机 `job_id` 独立目录；客户端不能指定 node12 本地路径或输出目录。
- [ ] 无 token 模式下的用户级 job 权限隔离不提供保证；来源控制由 node12 内网和防火墙承担。
- [x] 声明超过 50 MiB 上传限制的请求头立即返回 413，未创建可运行任务；完整上传超限仍待实测。
- [x] 队列满返回 429。
- [ ] MinerU 超时返回 `job_timeout`，不伪造成功。
- [x] 服务重启后未完成任务变为 `service_restarted`，不继续显示 running。
- [ ] 网络中断后客户端能返回可重试错误，不自动重复提交。
- [ ] 错误响应和 MCP 错误消息不包含 node12 绝对路径、命令、模型目录或其他租户信息。

## 当前安全边界

- [x] MinerU 服务不要求 Bearer Token，`/health` 无 Authorization Header 可访问。
- [x] 服务配置移除 Mac token 文件和 node12 token 映射文件依赖。
- [x] 未确认任务最多保留 1 小时；本地知识库写入成功确认后由客户端调用 acknowledge 立即清理。
- [ ] 反向代理或防火墙限制来源网段、方法、上传大小和超时。
- [ ] 未来跨越不可信网络时，再验收 HTTPS/TLS、Bearer Token 或 mTLS。

2026-10-30 的历史验收记录保留作旧部署结果，不代表当前无 token 直连部署。2026-11-02 已完成：node12 服务代码更新、systemd 监听地址切换、token 配置移除、Mac 到 `10.31.112.13:18890/health` 直连验证；真实 PDF 直连上传、下载、acknowledge 和自动清理仍待本轮重新验收。

同日 Mac 上重新生成并上传的独立样本 `.pilotdeck-home/med-tools/mineru-demo/mac-upload-demo.pdf`（1 页）返回任务 `aeb61a5bb878827ce179c6da62facf65`，服务端 `/validate` 为 `ok=true`，Mac 下载 8 个产物，得到 1 页、3 个文本块、0 张图片。原文 `orange satellite marker` 被 OCR 为 `orange satelite marker`，`Example Patient` 与 `Visit date` 间空格丢失；`quality_report.json` 的 `warnings=[]`。该验收只说明服务可用和结构化结果可以消费，不代表 OCR 逐字准确；导入个人知识库前应支持人工预览及重试。

后续决定 embedding 在 Mac 本地执行，还是也服务化到 node12；本阶段未把 embedding 写入 `knowledge.db`。
