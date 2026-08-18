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
| `med_trauma_stage_plan` | Formal **six-stage** care plan (G9 + GPT fallback) |

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

## Formal six-stage care plan

Tool `med_trauma_stage_plan(stage, injury_text, image_paths?)`:

1. One stage per call among 伤员发生地 / 野战分类场 / 收容处置组 / 重伤救治组 / 手术组 / 洗消组.
2. Plugin builds the fixed prompt (stage-specific 【任务要求】 + five sections + multi-image rules).
3. Calls G9-V-Med; GPT fallback inside the plugin when G9 fails.
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
| `MED_VLM_API_BASE` | `http://127.0.0.1:8030/v1` | OpenAI-compatible VLM base |
| `MED_VLM_MODEL` | `G9-V-Med` | VLM model id |
| `MED_VLM_API_KEY` | `EMPTY` | Bearer token if required |
| `MED_VLM_MAX_TOKENS` | `8192` | Max generation tokens |
| `MED_EMBEDDING_API_BASE` | `http://127.0.0.1:65507/v1` | Embedding OpenAI-compatible base |
| `MED_EMBEDDING_ENDPOINT` | `{API_BASE}/embeddings` | Full embeddings URL |
| `MED_EMBEDDING_MODEL` | `qwen3-vl-embedding` | Embedding model id |
| `MED_EMBEDDING_DIMENSION` | `2048` | Expected vector dim |
| `MED_RAG_MANIFEST` | `<plugin>/data/rag/manifest.json` | Override manifest path (tests) |
| `MED_DICOM_DERIVED_DIR` / `MED_DERIVED_DIR` | `<parent>/.med-tools-derived` | Preview/PNG output dir |

Optional Python deps (degraded if missing): `pymupdf`, `wfdb`.

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
