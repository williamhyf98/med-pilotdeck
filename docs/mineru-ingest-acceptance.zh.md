# MinerU 摄取服务验收

## 前置条件

1. 使用当前用户目录作为 `PILOT_HOME`。
2. 确认 `plugins/med-tools/.venv` 已安装依赖。
3. PDF 验收需要部署侧提供：
   - `MED_RAG_MINERU_LAUNCHER`
   - `MED_RAG_MINERU_MODEL_ROOT`
4. 配置文件放在：

```text
$PILOT_HOME/med-tools/mineru-ingest.env
```

配置文件只能使用 `KEY=VALUE` 行，不能写 `source`、命令替换或其他 shell 语句。

## 自动化验收

在仓库根目录运行：

```bash
env PYTHONPATH=plugins/med-tools \
  python3 -m unittest discover -s plugins/med-tools/tests -p 'test_mineru_*.py' -v
```

应覆盖：

- 当前用户路径和 symlink 边界；
- runtime 配置和子进程隔离；
- 章节、页码、重叠窗口和图片引用；
- TXT/DOCX 轻量解析；
- PDF fake MinerU 解析；
- 幂等任务和强制重跑；
- 批次部分失败和部分 bundle；
- job/batch ID 穿越拒绝；
- 服务重启后的 `live=false`；
- MCP 工具注册、默认参数、JSON 返回；
- 跨平台 Python launcher 和纯配置解析。

## MCP 手工验收顺序

### 1. 健康检查

调用：

```text
mineru_ingest_health()
```

检查：

- `service=mineru-ingest-tools`
- `async=true`
- `batching.max_workers` 默认是 `1`
- PDF runtime 配置正确时 `runtime.valid=true`
- 文本/DOCX 即使没有 MinerU runtime 也可以使用
- 返回内容不包含 `PILOT_HOME` 或 MinerU 模型目录的绝对路径

### 2. 单文件文本

在当前用户目录内准备 `notes.txt`，调用：

```text
mineru_ingest_submit(
  source_path="<PILOT_HOME>/notes.txt",
  book_id="acceptance-text"
)
```

轮询 `mineru_ingest_status(job_id)`，直到 `succeeded`，随后调用：

```text
mineru_ingest_result(job_id, include_samples=true)
mineru_ingest_validate(job_id)
```

检查 `manifest.json`、`quality_report.json`、三个 JSONL 文件均存在，且 `embedding.ready=false`。

### 3. PDF MinerU

在当前用户目录内准备 PDF，调用单文件工具并检查：

- `mineru_raw` 下存在 MinerU 原始产物；
- `chunks.jsonl` 包含 `chunk_id`、章节和 1-based 页码；
- `pages.jsonl` 能通过 `chunk_ids` 和 `text_chunk_ids` 追溯文本 chunk；
- `assets.jsonl` 和 `assets/` 中的资产 SHA-256 一致；
- chunk 的图片引用只包含 bundle 内相对路径；
- `mineru_ingest_validate` 返回 `ok=true`。

如果是部分页解析，检查省略 `page_index_offset` 时页码默认加上 `start_page`。

### 4. 批处理

提交两个成功文档和一个不存在的文档：

```text
mineru_ingest_batch_submit(
  documents=[
    {"source_path": "<PILOT_HOME>/a.txt", "book_id": "a"},
    {"source_path": "<PILOT_HOME>/b.txt", "book_id": "b"},
    {"source_path": "<PILOT_HOME>/missing.txt", "book_id": "bad"}
  ]
)
```

检查：

- 批次状态为 `partial_failed`；
- 成功子任务状态不被失败子任务覆盖；
- 默认 `batch_result` 不构建整体成功 bundle；
- `allow_partial=true` 返回 `partial=true` 的 bundle；
- 第二次 `batch_validate` 不产生重复资产或重复 ID。

### 5. 用户隔离

使用用户 A 的 `PILOT_HOME` 创建 source 和 job，再以用户 B 的 `PILOT_HOME` 调用：

```text
mineru_ingest_status("<用户A的job_id>")
mineru_ingest_result("<用户A的job_id>")
mineru_ingest_validate("<用户A的job_id>")
```

用户 B 不得读取用户 A 的 job、manifest、chunks、pages 或 assets。直接传入用户 A 的 source 路径也必须被拒绝。

### 6. 重启行为

在服务重启前保留一个 `queued` 或 `running` job，重启后查询同一个 job ID，必须满足：

```json
{
  "live": false,
  "warning": "job is not live in this MCP process; the server may have restarted"
}
```

不能把旧任务伪造为仍在执行，也不能把它标记为成功。

## 验收通过标准

- 自动化 MinerU 测试全部通过；
- 当前 `med-tools` 既有测试不回归；
- 现有 `med-tools` launcher、战创伤 RAG 查询和插件管理员权限不变；
- 未引入共享 `/slow_share/...` 默认路径；
- 后续知识库阶段可以只读取 bundle 中的 `chunks.jsonl`、`pages.jsonl`、`assets.jsonl` 和 manifest。
