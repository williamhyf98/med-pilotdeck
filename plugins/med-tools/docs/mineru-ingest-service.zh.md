# MinerU 文档入库 MCP：stdio 与 HTTP 两种运行方式

`mineru-ingest-tools` 将授权 PDF、DOC/DOCX 和常见文本文件解析为统一的
`chunks.jsonl`、`pages.jsonl`、`assets.jsonl`、`manifest.json` 与质量报告。
它只负责解析与产物规范化；向量化和并入 RAG 由后续
`med_trauma_rag_import_mineru_bundle` 完成。

两种运行方式共用完全相同的工具和输出格式：

| 模式 | 适合场景 | 是否占用端口 |
| --- | --- | --- |
| stdio（默认） | 本地 PilotDeck、单用户、少量任务 | 否 |
| Streamable HTTP（可选） | 多个 MCP 客户端复用、受控批量任务 | 是，仅本机回环地址 |

## 1. 默认：stdio MCP

`plugin.json` 默认配置保持为：

```text
run-mineru-ingest.sh → python -m server.mineru_ingest_app → stdio
```

PilotDeck 启动时按需拉起进程。它不监听网络端口，适用于日常单用户使用。

部署前，从仓库模板创建**个人且不纳入 Git**的运行时配置：

```bash
export PILOT_HOME=/home/你的用户名/projects/med-pilotdeck/.pilotdeck-home
mkdir -p "$PILOT_HOME/med-tools"
cp plugins/med-tools/mineru-ingest.env.example \
  "$PILOT_HOME/med-tools/mineru-ingest.env"
```

再编辑该文件，填写本机已安装 MinerU 的启动命令、模型目录、个人数据盘输出目录。
stdio 与 HTTP 启动脚本都会读取它；仓库代码和 `plugin.json` 不写死个人路径。

## 2. 可选：HTTP MCP 服务

先在服务所在机器启动。默认只监听本机 `127.0.0.1:18890`，MCP 地址为
`http://127.0.0.1:18890/mcp`：

```bash
cd /home/jiangzhenming/projects/med-pilotdeck
MED_RAG_MINERU_MCP_HOST=127.0.0.1 \
MED_RAG_MINERU_MCP_PORT=18890 \
bash plugins/med-tools/run-mineru-ingest-http.sh
```

它以前台方式运行，方便明确查看日志并由使用者自行管理生命周期。不要默认
绑定 `0.0.0.0`；跨机器访问应先使用 SSH 隧道或经团队批准的带鉴权反向代理。
部署到其他机器时只需替换个人运行时配置文件，代码不会写死机器路径。

在需要连接该常驻服务的 PilotDeck 项目/用户 MCP 配置中增加一个 **额外的**
URL 服务（不替换默认 stdio 配置）：

```json
{
  "mcpServers": {
    "mineru-ingest-http": {
      "url": "http://127.0.0.1:18890/mcp",
      "transport": "http",
      "timeoutMs": 300000
    }
  }
}
```

确认 URL 服务可用后，可以按使用场景选择关闭或保留 stdio 服务；两者不要同时
向同一输出目录提交同一份文件，以免造成重复任务。

## 3. 受控并发

HTTP 不代表无限并发。两种 transport 都使用同一个有界作业队列：

```bash
# 默认值为 1；共享服务器建议先保持 1。
MED_RAG_MINERU_MAX_WORKERS=1

# 经 CPU/GPU 资源检查后，可小规模提高到 2。
MED_RAG_MINERU_MAX_WORKERS=2
```

允许范围为 1–8，但应同时考虑每个任务的 `cpu_threads`。例如 2 个任务各用
16 线程可能比单任务 8 线程更影响共享服务器。`mineru_ingest_health` 会返回
`max_workers`、`running_jobs` 和 `queued_jobs`。

服务重启后，已完成任务和产物仍保留；重启时仍在运行的进程不会自动续跑，状态
接口会明确给出相应提示。高可用持久化队列（SQLite/独立 worker）属于后续增强，
不在当前轻量 MCP 服务中隐式开启。

## 4. MCP 工具契约与产物

两种 transport 均提供以下 9 个工具：

| 类别 | 工具 |
| --- | --- |
| 单文件 | `mineru_ingest_health`、`submit`、`status`、`result`、`validate` |
| 批处理 | `mineru_ingest_batch_submit`、`batch_status`、`batch_result`、`batch_validate` |

`submit` 和 `batch_submit` 都是异步提交：立即返回 `job_id` 或 `batch_id`，不在
一次 MCP 调用中等待 MinerU 完成。完成后，单任务目录中必有：

```text
manifest.json
quality_report.json
corpus/chunks.jsonl
corpus/pages.jsonl
corpus/assets.jsonl
assets/
```

其中 `chunks.jsonl` 是后续向量化的唯一文本输入；`pages.jsonl` 保存页级溯源；
`assets.jsonl` 与 `assets/` 保存图、表等附件及其和 chunk 的关联。服务本身不做
embedding、不更改现有 RAG 语料库。

## 5. 验收步骤

1. 启动 stdio 或 HTTP 服务后调用 `mineru_ingest_health`。预期 `ok=true`，PDF
   使用场景还应有 `runtime.valid=true`。
2. 用一个已授权 PDF 的 3–5 页调用 `mineru_ingest_submit`（MinerU 页码从 0 开始，
   例如 `start_page=0, end_page=4`）。轮询 `status` 至 `succeeded`。
3. 调用 `result`，确认五类产物路径存在；调用 `validate`，预期 `ok=true`。
4. 调用 `batch_submit` 提交两份小文档或同一 PDF 的两个不重叠页段。设置
   `MED_RAG_MINERU_MAX_WORKERS=1` 时，短时间内应看到一个 `running`、其余
   `queued`；`health` 的计数应相符。
5. 确认 CPU/GPU 资源充足后，重启服务并将 `MAX_WORKERS` 调为 2，重复步骤 4。

完整回归测试在仓库根目录执行：

```bash
PYTHONPATH=plugins/med-tools \
plugins/med-tools/.venv/bin/python -m unittest discover \
  -s plugins/med-tools/tests -p 'test_*.py'
```

## 6. 可选：导入 RAG 的闭环验收

对**当前 RAG 尚未包含**的授权文档，取 `mineru_ingest_result` 返回的
`manifest_path`，调用主 `med-tools` MCP 的：

```text
med_trauma_rag_import_mineru_bundle(
  ingest_manifest_path=<ingest manifest>,
  target_corpus_id=<new corpus version>,
  activate=false,
  validate=true
)
```

检查返回的 `old_chunk_count`、`new_chunk_count`、`total_chunk_count`、
`embedding_dimension=2048` 和验证结果；确认后才调用
`med_trauma_rag_activate_manifest(manifest_path=<new manifest>)`。导入会生成一个
新的自包含 RAG bundle，不会原地改写旧 bundle。不要把已在活动语料库中的教材
样本再次激活导入，否则会引入重复 chunk。
