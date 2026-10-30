# MinerU 个人知识库基础能力实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从旧分支 `origin/feat/jiang-rag` 中抽取 MinerU 文档摄取能力，先建立可本地运行的 `mineru-ingest-tools` MCP 和可部署到 node12 的 MinerU HTTP 服务，后续以统一的 ingest 契约实现用户隔离的个人知识库、embedding、数据库存储和检索。

**Architecture:** MinerU 核心只负责授权文档的解析、结构化切块、图片/页码产物和任务状态，不直接修改当前战创伤 RAG，也不负责知识库查询。Mac 本地保留 stdio MCP 作为统一工具入口；生产/远程模式由 node12 提供独立 MinerU HTTP 服务，Mac 通过上传文件、查询任务和下载标准化 bundle 调用它。未来个人知识库编排层复用同一 ingest 契约，随后使用当前 embedding 服务，将文档、chunk、资产和向量写入当前用户目录下的 SQLite 数据库。

**Tech Stack:** Python、FastMCP、FastAPI/Uvicorn、外部 MinerU runtime、现有 `med-tools` Python venv、SQLite、NumPy、HTTPX、SSH 隧道、HTTPS/TLS、当前多用户 `PILOT_HOME`/`resolveScopedHome()` 路径模型。

**Spec:** 本文档同时是设计规格和实施计划，来源为 `origin/feat/jiang-rag` 的提交 `3c6dfc8` 及其测试/验收文档，并结合当前分支 `feat/multi-user-v2` 的多用户路径和插件启动约束。

## Global Constraints

- 不直接合并 `feat/jiang-rag`；按本文档的文件边界选择性移植。
- 不修改当前战创伤远程 RAG 优先策略，不把个人知识库接入现有 `med_trauma_rag_query`。
- 不在第一阶段接入 RAG Bundle 激活、`rag-assets` UI 路由、Markdown 图片展示和消息流改造。
- 所有输入、产物、任务状态和未来知识库数据必须位于当前用户的 `PILOT_HOME` 内。
- 多用户 Gateway 为每个 MCP 子进程设置 `PILOT_HOME=<PILOT_ROOT>/users/<userId>`；Python 服务必须再次执行路径校验。
- 当前 `plugins/med-tools/run-mcp.cjs` 是主 MCP 的跨平台启动入口；新增 MCP 不得用旧分支的 `run.sh` 替换它。
- MinerU 本体、模型权重和运行环境由部署侧提供；仓库只保存 launcher、配置边界和适配代码。
- 默认 `MED_RAG_MINERU_MAX_WORKERS=1`，共享 GPU/CPU 的全局并发控制留到后续集中式 Worker。
- node12 是 MinerU 的集中式 GPU 计算节点；Mac 不安装 MinerU、模型权重或 CUDA，只通过远程服务提交文件。
- 远程请求必须上传文件内容，不允许把 Mac 的本地绝对路径传给 node12；node12 只接受服务端生成的任务目录和内部相对路径。
- 远程 HTTP 服务必须使用异步任务、有限队列、单 worker 和任务级超时；不能为每个请求开放任意服务器路径下载。
- 远程服务必须依据已认证的用户/租户身份选择 node12 侧隔离目录，不能信任客户端传入的 `user_id` 作为唯一授权依据。
- 开发阶段优先使用 SSH 隧道访问 node12 回环 HTTP；直接内网访问或生产部署必须使用 HTTPS/TLS、Bearer Token 或 mTLS，并校验证书。
- 默认使用复制而不是 hardlink，避免用户 Bundle 或资产修改基础数据。
- 所有异步任务必须有稳定 job id、源文件 SHA-256、解析配置指纹和明确的失败状态。
- 未完成任务的 Future 保存在进程内；第一阶段不承诺服务重启后自动恢复。

## Review Focus

- 用户 A 传入用户 B、系统目录或 symlink 外部目标时，MCP 必须拒绝且不读取文件。
- 用户 A 不能通过 job id、manifest、asset path 或 SQLite 路径访问用户 B 的数据。
- MinerU 解析成功但 embedding 服务不可用时，必须保留可重试的解析产物，不得标记为完整入库成功。
- embedding 模型或维度变化时，旧向量不能被静默混用。
- 插件管理接口的 `requireAdmin`、当前主 MCP launcher 和现有远程 RAG 行为必须保持不变。

## 1. 范围和目标

### 1.1 第一阶段交付

第一阶段交付 MinerU 基础能力，包含独立的 `mineru-ingest-tools` MCP 和 node12 远程服务链路：

- 接收当前用户目录中的 PDF、DOC、DOCX 和常见文本文件。
- PDF 调用外部 MinerU runtime。
- DOC/DOCX/文本走轻量解析。
- 解析、切块、页码和图片引用统一为稳定 JSON 产物。
- 支持单文件异步任务和批处理。
- 支持健康检查、状态查询、结果查询和产物校验。
- node12 提供独立 HTTP 服务，接收文件上传并异步执行真实 MinerU。
- Mac 通过本地 Remote Client 调用 node12 服务；开发阶段使用 SSH 隧道，生产阶段使用 HTTPS。
- 供后续个人知识库读取 `chunks.jsonl`、`pages.jsonl`、`assets.jsonl`。

第一阶段明确不做：

- 个人知识库 UI。
- 用户知识库列表、删除、重命名。
- embedding 写入个人数据库。
- 个人知识库检索。
- 现有战创伤 RAG 的 Bundle 合并和激活。
- 图片在聊天 Markdown 中的展示。

### 1.2 最终目标

完整个人知识库链路应为：

```text
用户上传文档
  -> 保存到当前用户目录
  -> 知识库编排层调用 mineru-ingest-tools
  -> MinerU 解析/切块/产出页码和资产
  -> 批量调用 embedding 服务
  -> 写入当前用户的 SQLite knowledge.db
  -> 向量/关键词检索
  -> 返回带文档、章节、页码和图片资产的证据
```

### 1.3 与 node12 服务的边界及后续实施顺序

现有 node12 HTTP 服务常驻时不常驻 GPU 显存；它在 PDF 解析任务期间启动独立的 CUDA MinerU 子进程，结束后退出。服务目前一次只接收一个任务：Mac 或 node12 上传文件，拿到 HTTP 202 和任务 ID，轮询 `queued -> running -> succeeded/failed`，再下载并校验 Markdown、content list、model JSON、`chunks.jsonl`、`pages.jsonl`、`assets.jsonl`、manifest 与质量报告。node12 的产物保留 24 小时，因此未来个人知识库必须在过期前将需要的原文和解析结果**复制到用户自己的持久目录**；node12 的任务目录只能作为临时解析区。参见 `docs/mineru-node12-service.zh.md`。

后续从登录用户上传界面开始，服务端先检查身份和知识库归属，把源文件存进该用户的 `$PILOT_HOME/knowledge-bases/<knowledge_base_id>/sources/`，异步调用现有 MinerU MCP 的 `submit -> status -> result -> validate`，将解析产物和图片资产复制到同一用户知识库目录。仅当校验通过，才读取 `chunks.jsonl` 的 `contents` 批量请求现有 embedding 服务，将 chunks、页码、文档版本、资产路径和向量写进该知识库的 SQLite `knowledge.db`。**目前尚未实现 embedding、数据库入库和知识库检索**；不应把“MinerU 任务成功”显示为“已加入知识库”。

导入状态应区分 `parsing`、`parsed`、`embedding`、`ready`、`failed_parse`、`failed_embedding`；embedding 暂不可用时保留已解析的文档并支持只重试 embedding。用源文件 SHA-256、解析参数和 embedding 模型/维度识别重复导入或模型升级，避免混用不同模型的向量。查询时先确认当前用户及知识库权限，对问题生成同模型向量，检索对应 chunks，并返回原文标题、章节和页码；可增加 SQLite FTS5 作为关键词检索和 embedding 不可用时的降级。由于实测出现 `satellite -> satelite` 和空格合并，导入界面需要让用户预览解析文字，不能用产物 SHA-256 校验代替 OCR 质量验收。

正式多用户接入前，须从当前单一 `pilotdeck` token 过渡到按用户隔离的授权；多用户网关把 `PILOT_HOME` 设置为各自的 `users/<id>`，应分别配置访问凭据、存储路径和访问控制，禁止用同一 token 把不同用户任务混入同一个租户。生产网络访问还需完成 HTTPS/CA 与超时、断连验收。上述工作按第 8 至 10 节分阶段完成。

## 2. 旧分支内容取舍

### 2.1 现在移植

| 旧分支内容 | 处理方式 | 原因 |
|---|---|---|
| `server/mineru_ingest.py` | 移植并适配 | 异步任务、批处理、产物编排核心 |
| `server/mineru_ingest_app.py` | 移植并适配 | MCP 工具入口 |
| `server/rag/mineru_adapter.py` | 移植 | 外部 MinerU 子进程边界 |
| `server/rag/mineru_chunking.py` | 移植 | 标题、章节、页码、chunk 生成 |
| `server/rag/mineru_runtime.py` | 移植并适配 | launcher、模型路径和运行环境校验 |
| `test_mineru_chunking.py` | 移植 | 切块行为回归 |
| `test_mineru_ingest_service.py` | 移植并扩展 | 异步任务和产物回归 |
| `test_mineru_runtime.py` | 移植并扩展 | runtime 配置回归 |

### 2.2 有条件移植

| 旧分支内容 | 当前策略 |
|---|---|
| `content_quality.py` | 如果第一阶段继续输出质量字段，则移植；否则放到质量增强阶段 |
| `content_census.py` | 作为离线质量分析工具保留，第一阶段不作为在线依赖 |
| `ingestion_ledger.py` | 暂不与现有 `MinerUIngestService` 并行引入；未来需要可恢复队列时再整合 |
| `embedding_client.py` | 优先复用当前版本，不直接覆盖；只补充批量 embedding 所需接口 |
| `mineru_ingestion.py` | 暂不引入第二套任务编排，避免和 `MinerUIngestService` 重复 |

### 2.3 暂不移植

- `rag_bundle.py`
- 旧分支对 `rag/query.py` 的远程/本地查询改造
- 旧分支对 `rag/store.py` 的 Bundle 存储改造
- `rag/presentation.py`
- `med_trauma_rag_import_mineru_bundle`
- `med_trauma_rag_activate_manifest`
- `ui/server/routes/plugins.js` 的旧版 `rag-assets` 改动
- Markdown 图片展示、消息流和聊天状态改动
- 旧分支删除 `requireAdmin` 的插件路由改动

## 3. 目标目录和运行时约定

### 3.1 用户目录

第一阶段默认目录：

```text
$PILOT_HOME/
  med-tools/
    mineru-ingest.env
    mineru-ingest/
      jobs/
      batches/
      tmp/
```

后续个人知识库目录：

```text
$PILOT_HOME/
  knowledge-bases/
    <knowledge_base_id>/
      knowledge.db
      sources/
      assets/
      tmp/
      exports/
```

`PILOT_HOME` 在多用户模式下必须是当前用户目录，不允许退回共享根目录。

### 3.2 配置项

第一阶段支持：

```text
MED_RAG_MINERU_CONFIG_FILE
MED_RAG_MINERU_LAUNCHER
MED_RAG_MINERU_MODEL_ROOT
MED_RAG_MINERU_INGEST_ROOT
MED_RAG_MINERU_DEFAULT_CPU_THREADS=8
MED_RAG_MINERU_MAX_WORKERS=1
MED_RAG_MINERU_DEFAULT_DEVICE=cpu
MED_RAG_MINERU_MCP_TRANSPORT=stdio
MED_RAG_MINERU_REMOTE_MODE=local
MED_RAG_MINERU_API_BASE=
MED_RAG_MINERU_API_TOKEN_FILE=
MED_RAG_MINERU_CA_BUNDLE=
MED_RAG_MINERU_CONNECT_TIMEOUT=10
MED_RAG_MINERU_POLL_INTERVAL=2
MED_RAG_MINERU_MAX_UPLOAD_BYTES=
```

约束：

- `MED_RAG_MINERU_INGEST_ROOT` 未配置时默认落在 `$PILOT_HOME/med-tools/mineru-ingest`。
- 不再使用旧分支的 `/slow_share/jiangzhenming/mineru-ingest` 默认值。
- `MED_RAG_MINERU_MODEL_ROOT` 必须存在且由部署侧配置。
- `MED_RAG_MINERU_LAUNCHER` 通过 `shlex.split` 解析，禁止拼接未经解析的 shell 命令。
- `MED_RAG_MINERU_DEFAULT_DEVICE` 本地默认使用 `cpu`；node12 GPU 服务固定配置为 `cuda`，客户端不得通过普通请求任意选择设备。
- `MED_RAG_MINERU_REMOTE_MODE=local` 时使用当前本地 stdio MCP；`remote` 时由本地 client 调用 node12 HTTP 服务。
- `MED_RAG_MINERU_API_BASE`、token 文件和 CA bundle 只存在于部署配置，不提交真实地址、密钥或证书。
- 当前 MCP 传输仍使用 stdio；node12 HTTP 是独立服务传输层，不把 stdio MCP 直接暴露到网络。
- SSH 隧道开发时，node12 HTTP 服务只监听 `127.0.0.1`；生产 HTTPS 服务才允许绑定受控内网地址。

## 4. MCP 接口契约

### 4.1 健康检查

```text
mineru_ingest_health() -> JSON string
```

返回至少包含：

```json
{
  "ok": true,
  "service": "mineru-ingest-tools",
  "supported_inputs": [".doc", ".docx", ".pdf", ".txt"],
  "async": true,
  "output_root": "<user-relative path>",
  "batching": {
    "max_workers": 1,
    "running_jobs": 0,
    "queued_jobs": 0
  },
  "runtime": {
    "configured": true,
    "valid": true
  }
}
```

对用户可见的错误消息不得泄露其他用户路径、系统敏感路径或模型目录绝对路径。

### 4.2 单文件任务

```text
mineru_ingest_submit(
  source_path: str,
  book_id?: str,
  title?: str,
  volume?: str,
  language?: str = "ch",
  device?: str = "cpu",
  start_page?: int,
  end_page?: int,
  page_index_offset?: int,
  formula_enabled?: bool = false,
  table_enabled?: bool = false,
  timeout_seconds?: int = 3600,
  cpu_threads?: int,
  max_chars?: int = 1200,
  overlap_chars?: int = 160,
  force?: bool = false
) -> JSON string
```

返回：

- `job_id`
- `status`: `queued`、`running`、`succeeded`、`failed`
- `source_sha256`
- `input_type`
- `job_dir` 的用户相对路径或脱敏路径
- 当前 phase

### 4.3 查询和校验

```text
mineru_ingest_status(job_id: str) -> JSON string
mineru_ingest_result(
  job_id: str,
  include_samples?: bool = false,
  sample_limit?: int = 3
) -> JSON string
mineru_ingest_validate(job_id: str) -> JSON string
```

成功结果至少包含：

```text
manifest_path
quality_report_path
artifact_paths.chunks_jsonl
artifact_paths.pages_jsonl
artifact_paths.assets_jsonl
artifact_paths.assets_dir
```

`result` 默认只返回小样本和元数据；完整数据由后续知识库编排层在服务端读取，不通过 MCP 一次性返回。

远程模式下，MCP 工具名称和返回语义保持不变，但 `source_path` 只作为本地输入文件使用；Remote Client 必须将文件内容上传到 node12，不能把该路径作为远程服务器路径传递。

### 4.4 批处理

```text
mineru_ingest_batch_submit(
  documents: list[DocumentSpec],
  language?: str = "ch",
  device?: str = "cpu",
  formula_enabled?: bool = false,
  table_enabled?: bool = false,
  timeout_seconds?: int = 3600,
  cpu_threads?: int,
  max_chars?: int = 1200,
  overlap_chars?: int = 160,
  force_jobs?: bool = false
) -> JSON string
mineru_ingest_batch_status(batch_id: str) -> JSON string
mineru_ingest_batch_result(
  batch_id: str,
  include_samples?: bool = false,
  sample_limit?: int = 3,
  build_bundle?: bool = true,
  allow_partial?: bool = false
) -> JSON string
mineru_ingest_batch_validate(batch_id: str) -> JSON string
```

批处理必须满足：

- 单个文档失败不破坏其他任务状态。
- `allow_partial=false` 时，存在失败文档不得标记整体成功。
- `allow_partial=true` 时明确返回 `partial=true`。
- 并发由 `MED_RAG_MINERU_MAX_WORKERS` 控制。

## 5. 标准化产物契约

### 5.1 `manifest.json`

必须包含：

```json
{
  "schema_version": "mineru-ingest-chunks-v1",
  "corpus_id": "user-document-id",
  "source_documents": [],
  "parser": {},
  "chunking": {},
  "artifacts": {
    "chunks_path": "corpus/chunks.jsonl",
    "pages_path": "corpus/pages.jsonl",
    "assets_path": "corpus/assets.jsonl",
    "assets_dir": "assets"
  },
  "quality": {},
  "source_sha256": "",
  "created_at": ""
}
```

### 5.2 chunk 记录

每条 chunk 至少包含：

```json
{
  "chunk_id": "stable-id",
  "doc_id": "stable-document-id",
  "title": "document title",
  "chapter_path": "chapter > section",
  "text": "plain text used as evidence",
  "contents": "contextual text used for embedding",
  "content_type": "body",
  "page_start": 1,
  "page_end": 2,
  "image_refs": []
}
```

要求：

- `chunk_id` 对同一文档和同一解析配置稳定。
- `text` 不包含不必要的检索前缀。
- `contents` 可以包含书名、章节和图片 caption，用于 embedding。
- 页码使用 1-based 语义。
- 图片引用只能是当前 ingest bundle 内的相对路径。

### 5.3 资产和页面

资产必须使用：

```text
assets/<digest-prefix>/<digest><suffix>
```

页面记录至少包含：

```text
page_id
doc_id
page
asset_ids
text_chunk_ids
```

所有资产路径必须经过：

- 相对路径检查；
- `..` 检查；
- realpath containment 检查；
- 文件存在和 SHA-256 校验。

## 6. 实施任务

### Task 1: 建立 MinerU 用户路径边界

**Files:**

- Create: `plugins/med-tools/server/mineru_paths.py`
- Modify: `plugins/med-tools/server/path_safety.py` only when shared helper is needed
- Test: `plugins/med-tools/tests/test_mineru_path_safety.py`

**Interfaces:**

```python
def resolve_mineru_root(env: Mapping[str, str] | None = None) -> Path
def assert_mineru_source_path(value: str, env: Mapping[str, str] | None = None) -> Path
def assert_mineru_output_path(value: str, env: Mapping[str, str] | None = None) -> Path
```

- [x] 写测试：允许当前用户目录内的文件和新建输出目录。
- [x] 写测试：拒绝其他用户目录、系统目录、`..`、绝对路径越界和外部 symlink。
- [x] 写测试：拒绝 dangling symlink。
- [x] 实现用户根目录和 ingest 根目录解析。
- [x] 将 `PILOT_HOME` 缺失或不合法视为拒绝，而不是回退到共享目录。
- [x] 运行路径安全测试。

### Task 2: 移植 MinerU runtime 和子进程适配层

**Files:**

- Create: `plugins/med-tools/server/rag/mineru_runtime.py`
- Create: `plugins/med-tools/server/rag/mineru_adapter.py`
- Test: `plugins/med-tools/tests/test_mineru_runtime.py`
- Test: `plugins/med-tools/tests/test_mineru_adapter.py`

**Interfaces:**

```python
class MinerURuntime:
    launcher: tuple[str, ...]
    model_root: Path

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None) -> "MinerURuntime"
    def validate(self) -> None

class MinerUInvocation:
    def command(self) -> list[str]

def run_mineru(invocation: MinerUInvocation) -> CompletedProcess[str]
def validate_mineru_output(invocation: MinerUInvocation) -> MinerUOutput
```

- [x] 写 fake MinerU launcher 测试，验证参数、模型目录、页码、超时和 CPU 线程参数。
- [x] 验证子进程使用隔离的 `HOME`、cache 和 `TMPDIR`。
- [x] 验证非零退出码和缺失产物进入明确异常。
- [x] 禁止继承会影响本地模型调用的代理和用户级 Python 状态。
- [x] 运行 runtime 和 adapter 单测。

### Task 3: 移植确定性切块和资产引用

**Files:**

- Create: `plugins/med-tools/server/rag/mineru_chunking.py`
- Create: `plugins/med-tools/server/rag/content_quality.py` if quality metadata is enabled
- Test: `plugins/med-tools/tests/test_mineru_chunking.py`
- Test: `plugins/med-tools/tests/test_content_quality.py`

**Interfaces:**

```python
@dataclass(frozen=True)
class ChunkingConfig:
    max_chars: int = 1200
    overlap_chars: int = 160

def build_mineru_chunks(
    *,
    source_pdf: Path,
    content_list_path: Path,
    config: ChunkingConfig = ChunkingConfig(),
    page_index_offset: int = 0,
) -> list[dict[str, Any]]
```

- [x] 写测试：标题层级、章节路径、句子切分、重叠窗口和页码偏移。
- [x] 写测试：图片 caption 与 chunk 的关联。
- [x] 写测试：空内容、非法 content list、过小 chunk 配置被拒绝。
- [x] 写测试：图片路径只能保留 bundle 内相对路径，外部绝对路径不可传播。
- [x] 运行切块和质量测试。

### Task 4: 移植异步 ingest service

**Files:**

- Create: `plugins/med-tools/server/mineru_ingest.py`
- Test: `plugins/med-tools/tests/test_mineru_ingest_service.py`

**Interfaces:**

```python
class MinerUIngestService:
    def health(self) -> dict[str, Any]
    def submit(
        self,
        *,
        pdf_path: str,
        book_id: str | None = None,
        title: str | None = None,
        volume: str | None = None,
        language: str = "ch",
        device: str = "cpu",
        start_page: int | None = None,
        end_page: int | None = None,
        page_index_offset: int | None = None,
        formula_enabled: bool = False,
        table_enabled: bool = False,
        timeout_seconds: int = 3600,
        cpu_threads: int | None = None,
        max_chars: int = 1200,
        overlap_chars: int = 160,
        force: bool = False,
    ) -> dict[str, Any]
    def status(self, job_id: str) -> dict[str, Any]
    def result(self, job_id: str, *, include_samples: bool = False, sample_limit: int = 3) -> dict[str, Any]
    def validate(self, job_id: str) -> dict[str, Any]
    def submit_batch(
        self,
        *,
        documents: list[Any],
        language: str = "ch",
        device: str = "cpu",
        formula_enabled: bool = False,
        table_enabled: bool = False,
        timeout_seconds: int = 3600,
        cpu_threads: int | None = None,
        max_chars: int = 1200,
        overlap_chars: int = 160,
        force_jobs: bool = False,
    ) -> dict[str, Any]
    def batch_status(self, batch_id: str) -> dict[str, Any]
    def batch_result(
        self,
        batch_id: str,
        *,
        include_samples: bool = False,
        sample_limit: int = 3,
        build_bundle: bool = True,
        allow_partial: bool = False,
    ) -> dict[str, Any]
    def batch_validate(self, batch_id: str) -> dict[str, Any]
```

- [x] 写测试：文本文件不依赖 MinerU runtime。
- [x] 写测试：PDF 调用 fake MinerU 并生成完整产物。
- [x] 写测试：相同源文件和配置复用已有成功任务；`force=true` 生成新任务。
- [x] 写测试：单任务失败、批任务部分失败和允许部分成功。
- [x] 写测试：任务 id、batch id 和路径参数不能穿越。
- [x] 写测试：服务重启后旧的 queued/running 任务报告 `not live`，不得伪造为仍在运行。
- [x] 保持默认 worker 数为 1。
- [ ] 增加 `MED_RAG_MINERU_DEFAULT_DEVICE`，本地默认 `cpu`，node12 服务默认 `cuda`；远程请求不允许任意切换 GPU 设备。
- [x] 运行完整 ingest service 测试。

### Task 5: 接入独立 stdio MCP

**Files:**

- Create: `plugins/med-tools/server/mineru_ingest_app.py`
- Create: `plugins/med-tools/run-mineru-ingest.cjs`
- Create: `plugins/med-tools/mineru-ingest.env.example`
- Modify: `plugins/med-tools/plugin.json`
- Test: `plugins/med-tools/tests/test_mineru_ingest_app.py`

**Interfaces:**

- MCP server name: `mineru-ingest-tools`
- transport: stdio
- `plugin.json` 保留现有 `med-tools` 配置和所有管理员权限行为。
- 新 MCP 的 child env 必须包含 `PILOT_HOME`、`PILOTDECK_DISABLE_LOCAL_AUTH`、`HOME`、`PATH` 和配置文件路径。

- [x] 写 MCP wrapper 测试，确认工具名称、参数默认值和 JSON 返回格式。
- [x] 写 launcher 测试，确认 macOS/Linux 使用 `.venv/bin/python`，Windows 使用 `.venv/Scripts/python.exe`。
- [x] 配置文件读取只支持明确的 `KEY=VALUE` 行，不执行 shell 代码。
- [x] `plugin.json` 只新增 `mineru-ingest-tools`，不得替换当前 `med-tools` launcher。
- [x] 保留插件管理员权限边界。
- [x] 运行 MCP wrapper 测试和现有插件配置测试。

### Task 6: 第一阶段端到端验收

**Files:**

- Create: `docs/mineru-ingest-service.zh.md`
- Create: `docs/mineru-ingest-acceptance.zh.md`
- Optional: `scripts/mineru-ingest-smoke.sh`

- [x] 在 node12 使用真实 MinerU runtime、CUDA 和 PDF 样本完成直接 CLI 手工验收。
- [ ] 通过 node12 HTTP 服务完成上传、轮询、结果下载和 Mac 端 bundle 验收。
- [x] 通过自动化测试验证 health、提交、轮询、结果读取和 validate。
- [x] 验证 chunks、pages、assets 和 quality report 均存在。
- [x] 验证第二个用户无法读取第一个用户的 source、job、manifest 或 assets。
- [x] 验证服务重启后的任务状态符合文档约定。
- [x] 运行 MinerU 核心测试和当前 med-tools 可运行的回归测试。

## 7. node12 MinerU 服务化与远程调用阶段

这一阶段把 node12 作为集中式 MinerU GPU 计算节点。它不改变第一阶段的标准化产物和 MCP 工具语义，只增加 HTTP 传输层和远程客户端。

### 7.1 已确认的部署事实

截至 2026-10-30，node12 `10.31.112.13` 已确认：

```text
MinerU 2.6.5:
/local_data/medical/Med-Rag/UltraRAG/.venv/bin/python

MinerU 2.7.0:
/local_data/root_miniconda3/envs/medrag-qwen35/bin/python

Pipeline 模型目录:
/local_data/models/opendatalab/PDF-Extract-Kit-1___0
```

node12 有 8 张 NVIDIA A800 80GB。2.6.5 和 2.7.0 均已使用 `pipeline + cuda + --source local` 完成真实 PDF 单页解析，并生成当前 adapter 需要的：

```text
<stem>/ocr/<stem>.md
<stem>/ocr/<stem>_content_list.json
<stem>/ocr/<stem>_model.json
<stem>/ocr/images/*
```

当前 node12 只有 MinerU CLI/runtime，没有正在运行的 MinerU HTTP 服务。首轮服务部署固定一个经过验收的版本，不允许运行时在 2.6.5 和 2.7.0 之间自动切换；按最小变更原则优先使用与 UltraRAG 同目录的 2.6.5。

### 7.2 目标调用链和数据流

```text
Mac PilotDeck
  -> 本地 mineru-ingest-tools stdio MCP
  -> Remote MinerU Client
  -> node12 HTTPS/SSH-tunnel HTTP API
  -> node12 上传暂存和用户/租户隔离目录
  -> MinerU CLI + CUDA GPU
  -> node12 标准化 bundle
  -> Mac 下载 bundle
  -> 当前用户 PILOT_HOME/knowledge-bases/<id>/
  -> 后续 embedding 和 knowledge.db
```

node12 本地运行的 PilotDeck 可以直接调用同一 HTTP API 的回环地址，也可以在明确的本地模式下继续使用 stdio MCP。生产部署推荐所有调用方都走同一 HTTP 契约，避免 Mac 和 node12 出现两套行为。

文件必须通过 `multipart/form-data` 上传。Mac 的本地绝对路径只在本地使用，不能传给 node12。node12 生成任务 ID、保存上传文件、调用现有 `MinerUIngestService`/adapter，并只允许下载该任务登记的标准化产物。

第一版服务可以复用现有 CLI 子进程边界，每个任务单独生成隔离 `HOME`、缓存、临时目录和输出目录；不要为了复用模型而先引入全局单例。确认稳定性和吞吐后，再评估长驻 MinerU worker。

### 7.3 HTTP 服务接口

服务端至少提供：

```text
GET  /health
POST /v1/mineru/jobs
GET  /v1/mineru/jobs/{job_id}
GET  /v1/mineru/jobs/{job_id}/result
GET  /v1/mineru/jobs/{job_id}/artifacts/{artifact_name}
```

`POST /v1/mineru/jobs` 使用 `202 Accepted` 返回：

```json
{
  "job_id": "stable-or-random-id",
  "status": "queued",
  "source_sha256": "...",
  "input_type": "pdf",
  "parser": {
    "runtime": "mineru",
    "device": "cuda"
  }
}
```

请求字段包括文件和受限的解析参数；不接受 `source_path`、`output_path`、`model_root` 或任意服务器路径。服务端负责设置 `device=cuda`、模型目录、超时、worker 数和最大上传大小。

任务状态至少包含：

```text
uploading -> queued -> running -> succeeded
                              -> failed
```

服务重启后，未完成任务必须变为明确的 `failed/service_restarted` 或 `not_live`，不能继续显示为运行中。结果接口只有在任务成功且 manifest 校验通过后才允许返回。

### Task 7: 固定 node12 MinerU runtime 和部署配置

**Files:**

- Create: `plugins/med-tools/mineru_service/service.env.example`
- Create: `docs/mineru-node12-service.zh.md`
- Optional: `scripts/start-mineru-service.sh`
- Optional: `scripts/stop-mineru-service.sh`
- Test: `plugins/med-tools/tests/test_mineru_service_config.py`

建议 node12 配置：

```env
MINERU_SERVICE_ROOT=/absolute/path/to/mineru-service
MED_RAG_MINERU_LAUNCHER='"/local_data/medical/Med-Rag/UltraRAG/.venv/bin/python" -m mineru.cli.client'
MED_RAG_MINERU_MODEL_ROOT='/local_data/models/opendatalab/PDF-Extract-Kit-1___0'
MED_RAG_MINERU_DEFAULT_DEVICE=cuda
MED_RAG_MINERU_MAX_WORKERS=1
MINERU_SERVICE_BIND=127.0.0.1
MINERU_SERVICE_PORT=18890
MINERU_SERVICE_MAX_UPLOAD_BYTES=2147483648
MINERU_SERVICE_JOB_TIMEOUT=3600
```

- [x] 固定 MinerU 版本、Python 解释器和模型目录，禁止服务启动时在线下载模型。
- [x] 验证服务用户对模型目录只读、对任务目录可写。
- [x] 配置任务目录权限为服务用户私有，限制上传大小、任务数、输出保留时间和单任务超时。
- [x] 配置单 Uvicorn worker；禁止使用多个 worker 共享同一任务队列和 GPU。
- [x] 写 runtime doctor，检查 Python、MinerU 版本、模型文件、CUDA 和输出目录权限。
- [x] 写 node12 直接 CLI smoke 脚本，失败时输出完整诊断但不修改既有 UltraRAG 产物。

### Task 8: 实现 node12 MinerU HTTP 服务

**Files:**

- Create: `plugins/med-tools/mineru_service/__init__.py`
- Create: `plugins/med-tools/mineru_service/app.py`
- Create: `plugins/med-tools/mineru_service/worker.py`
- Create: `plugins/med-tools/mineru_service/auth.py`
- Test: `plugins/med-tools/tests/test_mineru_http_service.py`

实现边界：

- `app.py` 只负责 HTTP、鉴权、上传和任务查询，不重复实现切块逻辑。
- `worker.py` 负责为任务建立服务端 `PILOT_HOME`/租户根目录，并调用现有 `MinerUIngestService`。
- 任务目录不能由请求中的路径决定；使用服务端生成的 job id 和受控目录。
- 每个任务保存上传文件 SHA-256、解析配置、当前 phase、状态和错误摘要。
- 结果下载只允许 manifest 登记的 `chunks.jsonl`、`pages.jsonl`、`assets.jsonl`、assets 目录和必要的质量报告。
- 错误响应不暴露 node12 绝对路径、模型路径、Python 命令或其他租户信息。
- 服务文档页和 OpenAPI 默认关闭，避免暴露内部接口说明。

- [x] 写健康检查：依赖配置、模型目录、CUDA、队列容量和当前运行数分别返回。
- [x] 写 multipart 上传、空文件、超限文件、非法参数和不支持扩展名测试。
- [x] 写任务状态转换、队列满、超时、异常和服务重启测试。
- [x] 写结果 allowlist 和任意路径下载拒绝测试。
- [x] 写 token 校验、恒定时间比较和缺失凭据拒绝测试。
- [x] 写租户/用户隔离测试，确认 A 不能查询或下载 B 的任务。
- [x] 写成功任务的 manifest、chunks、pages、assets 完整性测试。

### Task 9: 增加 Mac 远程客户端并复用现有 MCP 契约

**Files:**

- Create: `plugins/med-tools/server/mineru_remote_client.py`
- Modify: `plugins/med-tools/server/mineru_ingest_app.py`
- Modify: `plugins/med-tools/run-mineru-ingest.cjs`
- Modify: `plugins/med-tools/mineru-ingest.env.example`
- Test: `plugins/med-tools/tests/test_mineru_remote_client.py`
- Test: `plugins/med-tools/tests/test_mineru_ingest_app.py`

实现逻辑：

1. `MED_RAG_MINERU_REMOTE_MODE=local` 时保持现有本地调用行为。
2. `MED_RAG_MINERU_REMOTE_MODE=remote` 时，MCP 工具接收本地文件并由 client 流式上传，不把本地路径写入 HTTP 请求。
3. `submit` 返回远程 `job_id` 和本地映射信息；后续 `status/result/validate` 只查询同一个远程 job。
4. 成功后将标准化 bundle 下载到当前用户的 `PILOT_HOME`，再由本地路径安全层校验。
5. 远程任务失败时保留服务端错误摘要和本地可重试状态，不重复提交新任务。
6. HTTP 请求使用连接超时、读取超时、轮询间隔和有限重试；上传和结果下载不能无限等待。
7. HTTPS 默认校验证书；只有 SSH 隧道开发配置才允许访问本地回环 `http://`。

- [x] 测试 multipart 上传不会传递 Mac 绝对路径。
- [x] 测试远程 submit/status/result/validate 的 JSON 映射保持现有 MCP 工具契约。
- [x] 测试网络断开、HTTP 401/404/413/429/5xx 和任务失败的错误转换。
- [x] 测试重复查询同一 job 不会重复上传或重复生成本地资产。
- [x] 测试下载后的 bundle 仍通过当前用户路径、manifest 和 SHA-256 校验。
- [x] 测试远程配置缺失时 fail closed，不静默回退到共享路径或任意本地目录。

### Task 10: 开发隧道、生产 HTTPS 和进程守护

**Files:**

- Modify: `docs/mineru-node12-service.zh.md`
- Create: `docs/mineru-node12-acceptance.zh.md`
- Optional: `packaging/mineru-service/`
- Test: `plugins/med-tools/tests/test_mineru_remote_transport.py`

开发模式：

```bash
# node12 服务只监听 127.0.0.1:18890
ssh -N -L 18890:127.0.0.1:18890 node12
```

Mac 使用 `http://127.0.0.1:18890`，SSH 负责跨主机加密；该模式不作为生产服务地址。

生产模式：

```text
Mac/node12 -> HTTPS reverse proxy -> node12 MinerU service
```

- [x] 配置 HTTPS 证书、CA、Bearer Token 或 mTLS。
- [x] 客户端默认校验证书，禁止通过关闭 TLS 校验解决部署问题。
- [x] 反向代理限制来源网段、请求方法、上传大小和超时时间。
- [x] node12 服务使用 systemd user service 或等价守护方式，退出 SSH 后仍能运行。
- [x] 不把真实地址、密钥、证书和服务端绝对路径提交到 Git。
- [ ] 记录服务版本、MinerU 版本、任务耗时、失败 phase 和 GPU 使用情况，不记录完整文档内容到普通日志。

### Task 11: Mac/node12 远程端到端验收

**Files:**

- Create: `docs/mineru-node12-acceptance.zh.md`
- Optional: `scripts/mineru-remote-smoke.sh`
- Test: `plugins/med-tools/tests/test_mineru_remote_e2e.py`

- [x] node12 服务 doctor 和 Mac SSH 隧道 `GET /health` 确认 runtime、model、CUDA 和 queue 状态。
- [x] Mac 通过 SSH 隧道上传真实 PDF，完成 `202 -> queued -> running -> succeeded`。
- [x] Mac 下载 bundle，验证 Markdown、content list、model、chunks、pages、assets JSONL 和质量报告（小样本无图片文件）。
- [x] Mac 端验收结果中不出现 node12 绝对路径和其他用户信息。
- [x] 使用第二个 token 验证无法查询、下载首个租户的 job、manifest 和资产。
- [ ] 上传超限、队列满、MinerU 超时、服务重启和网络中断均返回可恢复状态（已验证队列满和服务重启，其他待测）。
- [ ] 使用 HTTPS 部署再次完成健康检查、上传、轮询和结果下载，并确认客户端证书校验生效。
- [ ] node12 本地 PilotDeck 和 Mac PilotDeck 通过同一 HTTP 契约得到一致结果（已验收 Mac MCP 和 HTTP，node12 本地 PilotDeck 未验收）。
- [ ] 验收后再决定是否将 embedding 计算放在 Mac 本地或后续也服务化到 node12。

## 8. 个人知识库数据库阶段

这一阶段在 MinerU MCP 稳定后开始，不与第一阶段混合提交。

### 8.1 SQLite 数据库设计

**Files:**

- Create: `plugins/med-tools/server/knowledge_base/__init__.py`
- Create: `plugins/med-tools/server/knowledge_base/schema.py`
- Create: `plugins/med-tools/server/knowledge_base/db.py`
- Test: `plugins/med-tools/tests/test_knowledge_base_db.py`

每个知识库使用一个数据库：

```text
$PILOT_HOME/knowledge-bases/<knowledge_base_id>/knowledge.db
```

建议表：

```text
knowledge_bases
documents
document_versions
chunks
chunk_embeddings
assets
ingestion_jobs
```

关键约束：

- 所有表包含 `knowledge_base_id` 或通过外键归属知识库。
- `documents.source_sha256`、解析器版本、chunk 配置和 embedding 配置构成幂等指纹。
- `chunks.chunk_id` 在同一文档版本内唯一。
- `chunk_embeddings.model`、`dimension`、`dtype` 必须可审计。
- SQLite 开启 `foreign_keys=ON` 和 WAL。
- 数据库、source、asset 路径均通过当前用户路径检查。

- [ ] 写 schema 创建和重复执行测试。
- [ ] 写外键、唯一约束和删除级联测试。
- [ ] 写不同 embedding 模型/维度不可混用测试。
- [ ] 写数据库位于用户目录内的路径测试。

### 8.2 Embedding 持久化

**Files:**

- Create: `plugins/med-tools/server/knowledge_base/embedding_store.py`
- Modify: `plugins/med-tools/server/rag/embedding_client.py` only for shared batching/config behavior
- Test: `plugins/med-tools/tests/test_knowledge_base_embedding.py`

约定：

- 复用当前 OpenAI-compatible embedding client。
- 每批最多 64 个文本。
- 使用 `contents` 作为默认 embedding 输入，同时保留 `text` 作为证据正文。
- 向量以 `float32` BLOB 保存，记录 model、dimension 和 norm。
- embedding 失败时保留解析成功状态，任务可重试。
- 不将向量写入旧战创伤 `.npy` Bundle。

建议接口：

```python
def embed_chunks(
    chunks: Sequence[Mapping[str, Any]],
    *,
    embedding_model: str | None = None,
) -> list[EmbeddedChunk]

def store_embeddings(
    connection: sqlite3.Connection,
    *,
    document_version_id: str,
    embeddings: Sequence[EmbeddedChunk],
) -> int
```

- [ ] 写批量调用和响应数量不匹配测试。
- [ ] 写维度、非有限值、空向量和模型不匹配测试。
- [ ] 写 embedding 服务失败后的可重试状态测试。
- [ ] 写向量 BLOB 编码/解码一致性测试。

### 8.3 知识库导入编排

**Files:**

- Create: `plugins/med-tools/server/knowledge_base/service.py`
- Create: `plugins/med-tools/server/knowledge_base/jobs.py`
- Test: `plugins/med-tools/tests/test_knowledge_base_service.py`

建议接口：

```python
class KnowledgeBaseService:
    def create_knowledge_base(self, *, name: str) -> dict[str, Any]
    def import_document(
        self,
        *,
        knowledge_base_id: str,
        source_path: str,
        title: str | None = None,
        parser_options: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]
    def get_import_status(self, *, job_id: str) -> dict[str, Any]
    def retry_embedding(self, *, document_version_id: str) -> dict[str, Any]
    def delete_document(self, *, document_id: str) -> dict[str, Any]
```

导入状态：

```text
created
parsing
parsed
embedding
ready
failed_parse
failed_embedding
deleted
```

编排顺序：

1. 检查当前用户和知识库归属。
2. 计算源文件 SHA-256。
3. 调用 `mineru-ingest-tools`。
4. 读取并校验 manifest、chunks、pages、assets。
5. 在数据库事务中创建 document version。
6. 批量生成 embedding。
7. 将 chunks、向量和 assets 写入用户目录。
8. 成功后提交为 `ready`。
9. 失败时保留可诊断状态，不留下半完成的 ready 数据。

- [ ] 写重复导入幂等测试。
- [ ] 写解析成功、embedding 失败、重试成功测试。
- [ ] 写事务回滚测试。
- [ ] 写删除文档后数据库和资产清理测试。
- [ ] 写两个用户不能互相访问知识库的测试。

## 9. 个人知识库 MCP/API 和上传阶段

### 9.1 用户上传

**Files:**

- Create: `ui/server/routes/knowledgeBases.js`
- Create: `ui/server/services/knowledgeBaseService.js`
- Modify: `ui/server/apiRouter.js`
- Test: `ui/server/routes/knowledgeBases.test.js`

约束：

- 路由挂在现有 `requireUser` 链上。
- 上传临时目录按用户隔离。
- 最终 source 文件只能移动到当前用户的知识库目录。
- 文件名使用现有安全文件名策略，不信任客户端路径。
- 上传成功后返回 `document_id` 和导入状态，不在 HTTP 请求中同步等待 MinerU。

建议接口：

```text
POST   /api/knowledge-bases
GET    /api/knowledge-bases
POST   /api/knowledge-bases/:id/documents
GET    /api/knowledge-bases/:id/documents
GET    /api/knowledge-bases/:id/documents/:documentId
DELETE /api/knowledge-bases/:id/documents/:documentId
```

- [ ] 写上传路径和跨用户访问测试。
- [ ] 写大文件、重复文件名和非法扩展名测试。
- [ ] 写上传后异步状态返回测试。
- [ ] 写删除和重新导入测试。

### 9.2 知识库编排调用 MinerU MCP

知识库服务不得依赖 `mineru_ingest.py` 的私有实现细节。调用边界使用 MCP 工具契约：

```text
submit -> status polling -> result -> validate
```

- [ ] 增加 MCP client 测试，确认工具调用超时、重试和错误转换。
- [ ] 增加任务取消或超时后的明确状态。
- [ ] 确认返回内容不把其他用户的绝对路径写入前端。

## 10. 个人知识库检索阶段

**Files:**

- Create: `plugins/med-tools/server/knowledge_base/search.py`
- Create: `plugins/med-tools/server/knowledge_base/presentation.py`
- Test: `plugins/med-tools/tests/test_knowledge_base_search.py`

第一版检索：

- 对查询文本调用同一 embedding 模型。
- 从当前用户知识库加载向量 BLOB。
- 使用 NumPy 计算 cosine similarity。
- 支持 `top_k`、最低分数和知识库过滤。
- 同时提供 SQLite FTS5 关键词检索作为 embedding 不可用时的降级。
- 结果必须包含 `document_id`、`document_version_id`、`chunk_id`、标题、章节、页码和来源。

后续性能优化：

- 小型个人知识库先使用 SQLite + NumPy。
- 数据量增大后评估 `sqlite-vec` 或独立向量索引。
- 不把个人知识库检索结果混入现有战创伤远程 RAG，除非另行设计合并策略。

- [ ] 写向量检索排序测试。
- [ ] 写 FTS5 降级测试。
- [ ] 写模型/维度不一致拒绝测试。
- [ ] 写多知识库过滤和跨用户隔离测试。
- [ ] 写文档、章节、页码元数据完整返回测试。

## 11. 图片和资产展示阶段

图片展示属于个人知识库第二阶段，不作为 MinerU MCP 第一阶段的阻塞项。

**Files:**

- Create or modify: `ui/server/routes/knowledgeBases.js`
- Modify: `ui/src/components/chat/view/subcomponents/Markdown.tsx` only after route security is complete
- Test: `ui/server/routes/knowledgeBases.assets.test.js`
- Test: `ui/src/components/chat/view/subcomponents/Markdown.knowledgeBase.test.tsx`

要求：

- 图片 URL 只能映射到当前用户当前知识库的 `assets/`。
- 必须使用 realpath containment。
- 只返回允许的图片 MIME 类型。
- 前端使用 authenticated fetch，不直接暴露未鉴权文件 URL。
- 用户 A 不能通过修改 asset id、document id 或 path 读取用户 B 的图片。

## 12. 测试和验收矩阵

### 12.1 单元测试

- MinerU runtime 配置。
- 子进程命令构造。
- PDF/DOCX/TXT 解析。
- chunk 切分和页码。
- 图片资产复制和路径校验。
- 异步任务、批处理和幂等。
- SQLite schema、事务和删除。
- embedding 批处理和向量编码。
- 个人知识库向量/关键词检索。

### 12.2 多用户测试

- 用户 A 不能读取用户 B 的 source。
- 用户 A 不能查询用户 B 的 job。
- 用户 A 不能提交用户 B 的 manifest。
- 用户 A 不能激活或读取用户 B 的数据库。
- 用户 A 不能读取用户 B 的图片。
- dangling symlink、外部 symlink 和 `..` 均拒绝。
- 缺失 user scope 时服务 fail closed。

### 12.3 端到端验收

- 上传 PDF 后创建异步导入任务。
- 任务状态从 `queued` 到 `parsing` 到 `parsed`/`embedding` 到 `ready`。
- 解析失败可看到失败原因并可重试。
- embedding 服务临时不可用时，解析结果仍可保留。
- 同一文件重复导入不会生成重复 ready 版本。
- 用户知识库查询可以召回新文档 chunk。
- 结果包含书名、章节、页码和源文档。
- 删除文档后不再召回，资产也被清理。

### 12.4 回归验收

- 当前 `med-tools` 既有测试通过。
- 当前多用户隔离测试通过。
- 现有战创伤远程 RAG 查询行为不变。
- 插件管理接口权限不变。
- 当前主 MCP 在 macOS/Linux/Windows launcher 行为不变。
- 工作区中用户已有未提交改动不得被覆盖。

## 13. 实施顺序和提交边界

按以下顺序串行实施，每个任务独立测试后再进入下一个：

1. 用户路径边界。
2. MinerU runtime 和 adapter。
3. 确定性切块和资产引用。
4. 异步 ingest service。
5. 独立 stdio MCP 和跨平台 launcher。
6. 第一阶段端到端验收。
7. 固定 node12 MinerU runtime 和部署配置。
8. node12 MinerU HTTP 服务。
9. Mac 远程 client 和现有 MCP 契约适配。
10. SSH 隧道、生产 HTTPS 和进程守护。
11. Mac/node12 远程端到端验收。
12. SQLite 个人知识库 schema。
13. embedding 持久化。
14. 知识库导入编排。
15. 上传和知识库管理 API。
16. 个人知识库检索。
17. 图片和资产展示。
18. 多用户、重启、性能和部署验收。

建议提交边界：

```text
feat: add scoped MinerU ingestion core
feat: expose MinerU ingestion MCP
test: add multi-user MinerU isolation coverage
feat: add node12 MinerU HTTP service
feat: add remote MinerU client over SSH tunnel/HTTPS
test: add remote MinerU upload and bundle acceptance
feat: add per-user knowledge base SQLite storage
feat: add knowledge base embedding ingestion
feat: add knowledge base upload and retrieval APIs
feat: add knowledge base asset presentation
```

## 14. 明确不采用的方案

- 不直接 Merge `origin/feat/jiang-rag`。
- 不把个人知识库数据写入共享的 `plugins/med-tools/data/rag`。
- 不用旧分支的 `rag_bundle.py` 代替用户级数据库。
- 不使用 hardlink 共享用户 Bundle 资产。
- 不让 MinerU MCP 直接读取任意服务器绝对路径。
- 不让单个用户通过 HTTP 服务访问其他用户任务。
- 不把 Mac 本地绝对路径直接传给 node12 MinerU 服务。
- 不把 MinerU CLI 或 stdio MCP 直接暴露到公网。
- 不在没有限流、鉴权和证书校验的情况下把 node12 服务作为生产接口。
- 不通过修改现有战创伤 RAG 查询逻辑来实现个人知识库。
- 不在第一阶段为了图片展示修改聊天消息流和 Markdown 处理。

## 15. 完成定义

第一阶段完成的最低标准：

- `mineru-ingest-tools` 被当前插件系统发现并能通过 stdio 启动。
- 用户可以提交当前用户目录内的 PDF/DOCX/TXT。
- 服务返回稳定 job id，并能查询状态和结果。
- 产物包含 manifest、chunks、pages、assets 和校验结果。
- 越界路径、跨用户路径和 symlink 路径全部拒绝。
- 旧分支核心测试和当前系统回归测试通过。
- 不改变现有战创伤 RAG、插件权限和主 MCP 行为。

远程 MinerU 服务阶段完成的最低标准：

- node12 的固定 MinerU runtime、模型目录和 CUDA 配置通过 doctor 和真实 PDF smoke。
- node12 HTTP 服务支持上传、异步任务、状态查询、结果下载和健康检查。
- Mac 通过 SSH 隧道完成开发验收，生产配置支持 HTTPS 和证书校验。
- Mac 和 node12 使用同一 HTTP 契约得到一致的标准化 bundle。
- 服务端任务、上传文件、产物和日志均有用户/租户隔离，不能通过路径参数越权。

完整个人知识库完成的最低标准：

- 每个用户拥有独立知识库目录和 SQLite 数据库。
- 文档解析、切块、embedding、入库状态可追踪。
- 重复导入幂等，失败任务可重试。
- 查询只返回当前用户和当前知识库的数据。
- 结果包含来源、页码和可选图片资产。
- 用户删除文档后，文本、向量、资产和检索结果均被清理。
- 多用户隔离和路径安全通过自动化测试及 Linux 生产环境验收。
