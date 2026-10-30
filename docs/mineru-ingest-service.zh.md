# MinerU 文档摄取服务

## 定位

`mineru-ingest-tools` 是独立的 stdio MCP 服务，负责把当前用户目录中的文档转换为后续知识库可消费的标准化产物：

```text
PDF/DOC/DOCX/TXT
  -> MinerU 或轻量文本解析
  -> 确定性切块
  -> 页码、图片资产和质量报告
  -> chunks/pages/assets JSONL
```

当前阶段不执行 embedding、不写个人知识库 SQLite，也不修改现有战创伤 RAG 查询链路。

## 用户目录和配置

服务进程必须收到当前用户的 `PILOT_HOME`。默认产物目录为：

```text
$PILOT_HOME/med-tools/mineru-ingest/
  jobs/
  batches/
  tmp/
```

可选配置文件：

```text
$PILOT_HOME/med-tools/mineru-ingest.env
```

配置文件只允许普通的 `KEY=VALUE` 行，不执行 shell 代码。示例见：
`plugins/med-tools/mineru-ingest.env.example`。

支持的环境变量：

```text
MED_RAG_MINERU_CONFIG_FILE
MED_RAG_MINERU_LAUNCHER
MED_RAG_MINERU_MODEL_ROOT
MED_RAG_MINERU_INGEST_ROOT
MED_RAG_MINERU_DEFAULT_CPU_THREADS=8
MED_RAG_MINERU_MAX_WORKERS=1
MED_RAG_MINERU_MCP_TRANSPORT=stdio
```

其中：

- `MED_RAG_MINERU_LAUNCHER` 使用参数分词，不拼接 shell 命令。
- `MED_RAG_MINERU_MODEL_ROOT` 由部署侧提供，必须是已存在的本地模型目录。
- `MED_RAG_MINERU_INGEST_ROOT` 如果配置，仍必须位于当前用户的 `PILOT_HOME` 内。
- `MED_RAG_MINERU_MAX_WORKERS` 范围为 `1-8`，默认 `1`，避免共享 GPU/CPU 被并发任务压垮。

MCP 返回的 `output_root`、`job_dir`、manifest、artifact 和错误信息不会包含
`PILOT_HOME`、模型目录或其他绝对路径；用户目录内的路径统一表示为相对于
当前用户 `PILOT_HOME` 的路径。服务内部仍使用绝对路径读写任务文件。

## MCP 工具

### 单文件

- `mineru_ingest_health()`
- `mineru_ingest_submit(source_path, ...)`
- `mineru_ingest_status(job_id)`
- `mineru_ingest_result(job_id, include_samples?, sample_limit?)`
- `mineru_ingest_validate(job_id)`

`source_path` 必须是当前用户目录内已经存在的绝对路径。PDF 需要配置 MinerU runtime；DOC、DOCX 和常见文本文件不依赖 MinerU runtime。

任务状态：

```text
queued -> running -> succeeded
                   -> failed
```

任务 ID 对同一源文件、源文件 SHA-256 和解析配置稳定。重复提交默认复用已有任务；传入 `force=true` 才会创建新任务。

### 批处理

- `mineru_ingest_batch_submit(documents, ...)`
- `mineru_ingest_batch_status(batch_id)`
- `mineru_ingest_batch_result(batch_id, ...)`
- `mineru_ingest_batch_validate(batch_id)`

`documents` 可以是路径字符串，也可以是包含 `source_path`、`book_id`、`title`、`volume` 以及单文档解析覆盖参数的对象。

默认情况下，只要有一个子任务失败，批次就是 `partial_failed`，不会构建整体成功 bundle。使用 `allow_partial=true` 可明确构建只包含成功子任务的部分 bundle。

## 标准产物

每个成功任务位于：

```text
jobs/<job_id>/
  manifest.json
  quality_report.json
  corpus/
    chunks.jsonl
    pages.jsonl
    assets.jsonl
  assets/
    <digest-prefix>/<digest><suffix>
  mineru_raw/
  logs/
```

### chunks.jsonl

每条记录包含：

```json
{
  "chunk_id": "stable-id",
  "doc_id": "document-id",
  "title": "document title",
  "chapter_path": "chapter > section",
  "text": "evidence text",
  "contents": "embedding-ready contextual text",
  "content_type": "body",
  "page_start": 1,
  "page_end": 2,
  "image_refs": []
}
```

`text` 用于证据展示，`contents` 可供后续 embedding 使用。页码是 1-based；部分 PDF 解析默认把 `start_page` 转换为原始 PDF 页码偏移。
标准化产物中的 `source_file` 和 manifest 的 `source_path` 使用相对于
`PILOT_HOME` 的路径，不把用户目录绝对路径写入可消费数据。

### pages.jsonl

页面记录包含：

```text
page_id
doc_id
page
text
chunk_ids
text_chunk_ids
asset_ids
```

`text_chunk_ids` 与当前文本切块对应；`chunk_ids` 保留为通用兼容字段。对于当前第一阶段产物，两者通常相同。

### assets.jsonl

资产记录包含 `asset_id`、相对 `path`、SHA-256、字节数、页码、caption 和关联 chunk。资产会复制到当前任务 bundle，避免后续用户修改源文件或资产时影响原始解析产物。

## 安全边界

- 缺失或非法 `PILOT_HOME` 直接拒绝，不回退到共享目录。
- 输入路径、输出路径和配置的 ingest 根目录执行 realpath containment 校验。
- 外部 symlink、dangling symlink、`..` 穿越和其他用户目录均拒绝。
- job ID 和 batch ID 只接受固定格式，不能作为路径穿越载体。
- MinerU 子进程使用任务目录下的 `HOME`、缓存和临时目录，不继承代理和用户级 Python site。
- embedding 尚未执行时，manifest 中 `embedding.ready` 必须为 `false`。

## 启动

插件通过以下独立入口启动：

```text
plugins/med-tools/run-mineru-ingest.cjs
```

现有 `med-tools` 继续使用 `run-mcp.cjs`，两者不互相替换。

服务重启后，进程内未恢复的 `queued`/`running` 任务会报告 `live=false` 和重启警告，不伪造为仍在运行。第一阶段不承诺自动恢复队列。
