# MinerU 文档入库与 RAG 增量导入：验收说明

本文面向 PilotDeck 验收人员，说明 MinerU 文档解析 MCP 服务的边界、两种接入方式及从文档到 RAG 问答的完整测试流程。默认不监听端口，解析阶段不执行 embedding，也不改写当前活动语料。

## 交付：三个工具包

| 工具包 | 职责 | 核心接口/产物 |
| --- | --- | --- |
| MinerU 入库 MCP | 接收服务端文件路径，异步解析、切分、任务队列 | `mineru_ingest_*` 9 个工具；`manifest.json`、`chunks.jsonl`、`pages.jsonl`、`assets.jsonl`、`quality_report.json` |
| RAG Bundle 管理 | 校验并将 ingest bundle 增量合并为新的自包含 RAG bundle | `med_trauma_rag_import_mineru_bundle`、`med_trauma_rag_activate_manifest`、`med_trauma_rag_status` |
| RAG 检索与图片展示 | 对活动语料做文本召回，并返回关联图片的安全元数据 | `med_trauma_rag_query`；`chunks[].image_refs`、`interleave_context` |

链路为：**解析并规范化 → 验证/增量建库 → 激活后检索与展示**。解析工具不会直接覆盖旧语料；导入可先生成未激活的新 bundle，验收无误后再切换。

## 1. MinerU 入库 MCP

入口为 `mineru-ingest-tools`，输入是服务器可访问的绝对 `source_path`，不是前端上传控件。支持：

```text
.pdf .docx .doc .txt .md .markdown .rst .csv .tsv .json .jsonl
.xml .html .htm .yaml .yml .log
```

- PDF 走 MinerU OCR/版面解析；DOCX 使用 OOXML 文本解析；DOC 优先调用服务器已有转换器，缺失时低置信降级抽取。
- 文本、标记和结构化文本直接抽取并切分 chunk；未知二进制拒绝入库，防止乱码污染 RAG。
- 共 9 个 MCP 工具：单文件 `health`、`submit`、`status`、`result`、`validate`；批量 `batch_submit`、`batch_status`、`batch_result`、`batch_validate`。提交为异步操作，需轮询状态至完成。

### CLI / stdio（默认）

PilotDeck 按 `plugin.json` 自动拉起 `run-mineru-ingest.sh`，不占用端口。重启 PilotDeck 后在前端调用：

```text
请调用 mineru_ingest_health 检查文档 ingest 服务状态
```

预期工具仍存在，且返回 `transport: "stdio"`、`batching.max_workers: 1`。再提交 TXT 或 DOCX，验证 `submit → status → result → validate` 全链路；非 PDF 不依赖 MinerU runtime，预期 `status=succeeded`、`validate.ok=true`。

### Streamable HTTP（可选）

仅在需要让多个受控 MCP 客户端复用服务时启动：

```bash
cd /home/jiangzhenming/projects/med-pilotdeck
MED_RAG_MINERU_MCP_HOST=127.0.0.1 MED_RAG_MINERU_MCP_PORT=18890 \
  bash plugins/med-tools/run-mineru-ingest-http.sh
```

默认只监听 `http://127.0.0.1:18890/mcp`。在 PilotDeck MCP 配置中**新增**而非替换 stdio：

```json
{"mcpServers":{"mineru-ingest-http":{"url":"http://127.0.0.1:18890/mcp","transport":"http","timeoutMs":300000}}}
```

调用 `health`，预期 `transport: "streamable-http"`、`batching.max_workers: 1`，并可看到同一组 9 个 `mineru_ingest_*` 工具。跨机器请使用 SSH 隧道或经批准的鉴权反向代理；不要默认绑定 `0.0.0.0`。

两种 transport 复用同一解析逻辑、任务状态和产物格式。`MED_RAG_MINERU_MAX_WORKERS` 控制有界队列，默认 `1`；仅在 CPU/GPU 资源确认后提高到 `2`。HTTP 不会无限并发。

MinerU 命令、模型路径和数据盘目录由个人的 `$PILOT_HOME/med-tools/mineru-ingest.env` 配置，模板为 `plugins/med-tools/mineru-ingest.env.example`，不纳入 Git。

## 2. PDF、队列与产物验收

对授权的 3–5 页 PDF 调用 `mineru_ingest_submit`；请求第 1–3 页时传 `start_page=0, end_page=3`（页码从 0 开始），可使用 `device=cpu, cpu_threads=8`。成功后应有：

```text
manifest.json
quality_report.json
corpus/chunks.jsonl
corpus/pages.jsonl
corpus/assets.jsonl
assets/
```

`mineru_ingest_result(include_samples=true)` 应显示页码、书名 metadata 和可选的 `image_refs`；图片路径必须是 bundle 内相对 `assets/` 路径，而不是 `/tmp`。`mineru_ingest_validate` 应返回 `ok=true`。

保持 `MED_RAG_MINERU_MAX_WORKERS=1` 提交两个轻量文档或 PDF 页段，预期一个 `running`、一个 `queued`，且 `health` 的 `running_jobs`、`queued_jobs` 相符。资源确认后重启并以 `MAX_WORKERS=2` 复测。

## 3. RAG Bundle、图片与问答验收

以任务返回的 `manifest_path` 调用：

```text
med_trauma_rag_import_mineru_bundle(
  ingest_manifest_path=<manifest_path>, target_corpus_id=import-test-001,
  name=import-test-001, version=import-test-001, activate=false, validate=true
)
```

预期 `ready=true`、`activated=false`、旧/新增/总 chunk 数正确、`embedding_dimension=2048`、`validation.ready=true`。`target_corpus_id` 会拒绝路径穿越；图片采用 hardlink 优先、copy 兜底，`asset_materialization` 返回 `hardlinked`、`copied`、`existing` 统计。

确认后调用 `med_trauma_rag_activate_manifest`，再以 `med_trauma_rag_status(validate=true)` 检查活动语料。最后询问一个仅新 PDF 含有的问题：应召回新书名/页码；若命中 chunk 关联图片，前端应渲染图片而不是只显示 alt 文本。新 bundle 为追加，不会原地修改旧 bundle；不要重复导入已激活文档。

## 自动化回归

```bash
PYTHONPATH=plugins/med-tools \
plugins/med-tools/.venv/bin/python -m unittest discover \
  -s plugins/med-tools/tests -p 'test_*.py'
```

提交前再运行 `py_compile` 与 `git diff --check`。自动化测试覆盖输入分类、任务队列、stdio/HTTP transport、bundle 导入、图片资产合并及检索展示；真实 PDF OCR 质量仍须按本文小样本和目标语料单独验收。
