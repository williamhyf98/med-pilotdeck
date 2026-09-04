# med-tools (PilotDeck plugin)

MCP plugin that adds **multi-source medical parsing**, local **G9-V-Med** reports,
**war-trauma RAG Q&A**, and **six-stage formal care plans** to PilotDeck.

## Tools

| Tool | Role |
|------|------|
| `med_parse_medical` | Parse medical file/folder + G9 report |
| `med_tools_health` | VLM / deps / RAG summary |
| `med_trauma_rag_status` | Corpus readiness (rows, dim, sha) |
| `med_trauma_rag_query` | Retrieve war-trauma chunks for **knowledge Q&A** |
| `med_trauma_stage_plan` | Formal **six-stage** care plan (G9 + main-agent fallback) |

Wire names in chat: `mcp__med-tools__<tool>`.

## Skill × Tool（当前用法：无注册 Profile）

主 Agent 页面**不选 Profile**；靠 Skill description 自行分流。  
`agents/medical-assistant.md` 仅作设计留存（`plugin.json` 里 `"agents": []`，不加载）。

```text
用户
  │
  ├─【解读附件】── Skill med-medical
  │                  └─ med_parse_medical → report 原样展示
  │
  ├─【战创伤知识点问答】── Skill med-trauma-assist
  │                  └─ med_trauma_rag_query → 主模型作答（可附简短要点）
  │
  ├─【正式分阶段救治方案】── Skill med-trauma-stage-plan
  │                  ├─ (可选) med_parse_medical 并入可见伤情
  │                  └─ med_trauma_stage_plan → care_plan 原样展示
  │
  └─【纯问答】────── 主模型直接答
```

Skills:

- `med-medical` — 附件解读；`report` 原样展示
- `med-trauma-assist` — RAG 知识点问答；非正式五段方案
- `med-trauma-stage-plan` — 六阶段正式方案；`care_plan` 原样展示

## Primary tool: `med_parse_medical`

Unified entry (aligned with offline-301 suffixes):

1. Accept a **file or directory** (for chat/Files folder uploads, pass the folder root once).
2. Parse locally by type: DICOM, PDF, images, CDA/XML, text/markdown, JSON, WFDB/ECG (some ECG types degraded).
3. Call local **G9-V-Med** for one structured Chinese report.
4. Agent should show the returned `report` **verbatim**.

Directory batches default to `max_items=64` (max 64); truncated folders surface a warning with discovered vs parsed counts.

Supported suffixes: `.cda .xml .json .xml1 .txt .md .markdown .pdf .png .jpg .jpeg .bmp .dcm .dicom .ecg .wfdb .hea .dat .atr .qrs .edf .scp`

**详细流程（中文）**：见 [`docs/med-parse-medical-flow.zh.md`](docs/med-parse-medical-flow.zh.md)（Skill 路由、本地解析分支、Python 依赖、G9 流式、输入输出契约、流程图；含可选演进 MinerU 备忘，未接入）。

## War-trauma RAG（知识点问答）

Self-contained under `data/rag/` (no `products/` runtime dependency):

```text
data/rag/
  manifest.json
  corpus/war_trauma_books_chunks.jsonl   # LFS
  embedding/war_trauma_books_embedding.npy  # LFS, shape (16540, 2048)
```

Flow for **Skill `med-trauma-assist`**:

1. Rewrite a self-contained retrieval `query` using the current user turn plus up to the last 5 user turns and any needed assistant conclusions (do not paste raw chat history into embedding).
2. Call `med_trauma_rag_query(query=...)`.
3. Main model answers the knowledge question from `chunks` (brief tips OK).
4. Formal five-section plans use **`med_trauma_stage_plan`**, not this path.

If the embedding service is down, the tool uses **lexical-fallback** and sets `mode` accordingly.

### 图片交错展示

`med_trauma_rag_query` 仍然只做**文字检索**。当文字 chunk 与 MinerU 图片存在关联时，返回：

- `chunks[].image_refs`：图片路径、图注、页码和关联强度；
- `interleave_context`：按 `text → image → text` 顺序排列的展示片段。

主 Agent 应使用 `med-trauma-assist` Skill 调用 RAG；如果前端支持图片附件，就渲染
`interleave_context` 中的 `image` 片段。普通直接问答不会自动调用该工具，也不会自动附图。
图片只作为文字证据的附件，不代表系统理解了图片中未被图注或正文支持的视觉语义。

## Formal six-stage care plan

Tool `med_trauma_stage_plan(stage, injury_text, image_paths?)`:

1. One stage per call among 伤员发生地 / 野战分类场 / 收容处置组 / 重伤救治组 / 手术组 / 洗消组.
2. Plugin builds the fixed prompt (stage-specific 【任务要求】 + five sections + multi-image rules).
3. Calls G9-V-Med; falls back to the configured main agent model inside the plugin when G9 fails.
4. Agent shows `care_plan` **verbatim** (same rule as `report` on parse).

Ordinary injury photos go in `image_paths` for G9 to read. DICOM/PDF: prefer `med_parse_medical` first, fold report/summary into `injury_text`. RAG is **not** required.

## Setup

Prefer the project-local launcher so `PILOT_HOME` points at
`.pilotdeck-home` (no `~/.pilotdeck`):

```bash
# from repo root
./scripts/bootstrap-runtime-select.sh   # once
./scripts/start-local.sh                # creates .pilotdeck-home + links this plugin
```

Manual venv only:

```bash
cd plugins/med-tools
bash setup.sh
```

`plugin.json` MCP command uses `${env:PILOT_HOME}/plugins/med-tools/run.sh`.
`timeoutMs: 300000` (5 minutes) for this MCP only.

Restart PilotDeck (or reload plugins) after changing `plugin.json` env.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `MED_VLM_API_BASE` | `http://127.0.0.1:8030/v1` | OpenAI-compatible **G9** VLM base |
| `MED_VLM_MODEL` | `G9-V-Med` | Primary medical VLM model id |
| `MED_VLM_API_KEY` | `EMPTY` | Bearer token if required |
| `MED_VLM_MAX_TOKENS` | `8192` | Max generation tokens |
| `MED_VLM_FALLBACK_ENABLED` | `1` | Enable fallback when G9 fails |
| `MED_VLM_FALLBACK_MODEL` | *(from `pilotdeck.yaml` `agent.model`)* | Fallback model id; env overrides config |
| `MED_VLM_FALLBACK_API_BASE` | *(from matching provider `url`)* | Fallback OpenAI-compatible base |
| `MED_VLM_FALLBACK_API_KEY` | *(from matching provider `apiKey`)* | Fallback API key |
| `MED_EMBEDDING_API_BASE` | `http://127.0.0.1:65507/v1` | Embedding OpenAI-compatible base |
| `MED_EMBEDDING_ENDPOINT` | `{API_BASE}/embeddings` | Full embeddings URL |
| `MED_EMBEDDING_MODEL` | `qwen3-vl-embedding` | Embedding model id |
| `MED_EMBEDDING_DIMENSION` | `2048` | Expected vector dim |
| `MED_RAG_MANIFEST` | `<plugin>/data/rag/manifest.json` | Highest-priority manifest override |
| `MED_DICOM_DERIVED_DIR` / `MED_DERIVED_DIR` | `<parent>/.med-tools-derived` | Preview/PNG output dir |

When `MED_VLM_FALLBACK_*` are unset, med-tools reads `$PILOT_HOME/pilotdeck.yaml` (then `.pilotdeck-home/pilotdeck.yaml` / `~/.pilotdeck/pilotdeck.yaml`) and uses `agent.model` plus that provider's `url` / `apiKey`.

### Personal RAG manifest selection

Some MCP launchers whitelist child-process environment variables, so an export
from the shell running PilotDeck may not reach med-tools. For a user-local,
non-Git configuration, write exactly one absolute manifest path to:

```text
$PILOT_HOME/med-tools/rag-manifest-path
```

Selection order is `MED_RAG_MANIFEST` → this pointer file → the bundled
default manifest. A malformed or missing pointed-to manifest is an error; it
never silently falls back to another corpus.

Bundles may contain image attachments under `assets/`. Their returned URLs use
the same PilotDeck origin at `/api/plugins/med-tools/rag-assets/assets/...`.
The server resolves only under the active bundle's `assets/` directory; it does
not expose arbitrary data-disk paths.

Optional Python deps (degraded if missing): `pymupdf`, `wfdb`.

## MinerU 通用入库 MCP

`mineru-ingest-tools` 可将授权 PDF、DOC/DOCX 和常见文本异步转换为统一的
chunks/pages/assets bundle，后续再按需导入 RAG。默认使用不占端口的 stdio MCP；
也可按需启动仅监听本机的 Streamable HTTP MCP。部署配置、9 个工具、并发边界和
完整验收步骤见 [docs/mineru-ingest-service.zh.md](docs/mineru-ingest-service.zh.md)。
MinerU 可执行环境、模型和数据盘路径通过个人的 `$PILOT_HOME/med-tools/`
`mineru-ingest.env` 配置，不提交到 Git；模板见
[mineru-ingest.env.example](mineru-ingest.env.example)。

## Tests

```bash
cd plugins/med-tools
.venv/bin/python -m unittest discover -s tests -v
```

## Manual smoke

```bash
.venv/bin/python -c "
from server.rag import rag_status, query_rag
print(rag_status(validate=True))
print(query_rag(query='战创伤现场大出血止血', top_k=3)['mode'],
      query_rag(query='战创伤现场大出血止血', top_k=3)['chunk_count'])
"

.venv/bin/python -c "
from server.trauma_stage_plan import build_user_prompt, normalize_stage
assert normalize_stage('发生地') == '伤员发生地'
print(build_user_prompt(stage='伤员发生地', injury_text='右大腿贯通伤', has_images=False)[:200])
"
```
