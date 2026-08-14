# med-tools (PilotDeck plugin)

MCP plugin that adds **multi-source medical parsing**, local **G9-V-Med** reports,
and **war-trauma RAG** (textbook evidence for the main Agent) to PilotDeck.

## Tools

| Tool | Role |
|------|------|
| `med_parse_medical` | Parse medical file/folder + G9 report |
| `med_tools_health` | VLM / deps / RAG summary |
| `med_trauma_rag_status` | Corpus readiness (rows, dim, sha) |
| `med_trauma_rag_query` | Retrieve war-trauma chunks (vector or lexical-fallback) |

Wire names in chat: `mcp__med-tools__<tool>`.

Skills:

- `med-medical` — parse attachments / show `report` verbatim
- `med-trauma-assist` — describe (main model) → RAG → care plan (main model)

## Primary tool: `med_parse_medical`

Unified entry (aligned with offline-301 suffixes):

1. Accept a **file or directory** (for chat/Files folder uploads, pass the folder root once).
2. Parse locally by type: DICOM, PDF, images, CDA/XML, text/markdown, JSON, WFDB/ECG (some ECG types degraded).
3. Call local **G9-V-Med** for one structured Chinese report.
4. Agent should show the returned `report` **verbatim**.

Directory batches default to `max_items=64` (max 64); truncated folders surface a warning with discovered vs parsed counts.

Supported suffixes: `.cda .xml .json .xml1 .txt .md .markdown .pdf .png .jpg .jpeg .bmp .dcm .dicom .ecg .wfdb .hea .dat .atr .qrs .edf .scp`

## War-trauma RAG

Self-contained under `data/rag/` (no `products/` runtime dependency):

```text
data/rag/
  manifest.json
  corpus/war_trauma_books_chunks.jsonl   # LFS
  embedding/war_trauma_books_embedding.npy  # LFS, shape (16540, 2048)
```

Flow (方案 A):

1. Main model writes a short injury description (especially for images).
2. Call `med_trauma_rag_query(query=...)`.
3. Main model writes the assistive care plan from `chunks` (tools do **not** generate the plan).

If the embedding service is down, the tool uses **lexical-fallback** and sets `mode` accordingly.

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
```
