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
  │                  └─ med_parse_medical(continuation_mode=terminal)
  │                     → report 流式展示并可作为本轮终局
  │
  ├─【战创伤知识点问答】── Skill med-trauma-assist
  │                  └─ med_trauma_rag_query → 主模型作答（可附简短要点）
  │
  ├─【正式分阶段救治方案】── Skill med-trauma-stage-plan
  │                  ├─ (可选) med_parse_medical(continuation_mode=material) 并入可见伤情
  │                  └─ med_trauma_stage_plan → care_plan 流式展示，本轮可继续导出
  │
  ├─【按模版生成病例报告 / HTML】── Skill med-case-report
  │                  ├─ med_parse_medical(continuation_mode=material) 并入附件解读
  │                  └─ 主模型继续写固定 9 段模版 / 后续交付物
  │
  └─【纯问答】────── 主模型直接答
```

Skills:

- `med-medical` — 附件解读；`continuation_mode=terminal`；`report` 可作为本轮终局
- `med-trauma-assist` — RAG 知识点问答；非正式五段方案
- `med-trauma-stage-plan` — 六阶段正式方案；先 parse 时用 `material`；`care_plan` 流式展示后本轮可继续
- `med-case-report` — 固定 9 段模版病例报告；附件解析必须用 `material`，解析后继续写报告/HTML

### MCP 调用前的 Skill 门禁

所有 `mcp__med-tools__*` 工具都经过会话级 Skill 门禁：

1. 若本会话已经通过 `read_skill` 加载了对应医学 Skill，工具正常执行。
2. 若模型跳过 `read_skill` 直接调用 MCP，首次调用**不执行医学工具**；运行时自动加载完整 Skill，并把正文和“重新规划、重新调用”的提示返回模型。
3. 模型按 Skill 重新规划并再次调用后，MCP 才真正执行。

映射关系：

- `med_parse_medical` → `med-medical`；已加载 `med-case-report` 或 `med-trauma-stage-plan` 时也可使用。
- `med_trauma_rag_query` / `med_trauma_rag_status` → `med-trauma-assist`。
- `med_trauma_stage_plan` → `med-trauma-stage-plan`。
- `med_tools_health` → 任一医学 Skill；未加载时默认补 `med-medical`。

门禁只保证模型先读完整操作手册；阶段合法性、输入路径等不可省略的参数仍由 MCP 工具自身校验。

## Primary tool: `med_parse_medical`

Unified entry (aligned with offline-301 suffixes):

1. Accept a **file or directory** (for chat/Files folder uploads, pass the folder root once).
2. Parse locally by type: DICOM, PDF, images, **structured CDA/XML** (CLUSTER labs, observation pairs), text/markdown, JSON, WFDB/ECG (some ECG types degraded).
3. Call local **G9-V-Med** for one structured Chinese report.
4. Choose continuation:
   - `continuation_mode="terminal"` (default, `med-medical`): streamed `report` may end the turn.
   - `continuation_mode="material"` (`med-case-report` / multi-step plans): streamed `report` is material; the main agent continues unfinished steps.

CDA notes:

- Lab items prefer the CD `code` on `检验结果代码` (e.g. `cTnI`) over hospital internal ids.
- If only an internal id like `5581` exists, it is kept verbatim and marked **项目名称未提供** — never guessed from order.
- `status=ready/degraded` follows structured extraction quality, not whether `lxml` is installed.

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

1. One stage per call among 伤员发生地 / 野战分类场 / 收容处置组 / 重伤救治组 / 手术组 / 洗消组. If the user did not name a stage, Skill `med-trauma-stage-plan` must call `ask_user_question` first (do not guess).
2. Plugin builds the fixed prompt (stage-specific 【任务要求】 + five sections + multi-image rules).
3. Calls G9-V-Med; falls back to the configured main agent model inside the plugin when G9 fails.
4. Agent shows `care_plan` **verbatim** (same rule as `report` on parse).

Ordinary injury photos go in `image_paths` for G9 to read. DICOM/PDF: prefer `med_parse_medical` first, fold report/summary into `injury_text`. RAG is **not** required.

## Setup

Prefer the project-local launcher so `PILOT_HOME` points at
`.pilotdeck-home` (no `~/.pilotdeck`). Full clone/bootstrap/start
for Linux, macOS, and Windows: [`docs/local-clone-and-start.zh.md`](../../docs/local-clone-and-start.zh.md).

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

Windows notes:

- `setup.sh` needs a real Python (the Microsoft Store `python3` stub is NOT one).
  Point it at any real interpreter, e.g. a conda env:
  `PYTHON_BIN='D:/softwares/miniconda3/envs/med-mas/python.exe' bash setup.sh`
- venv layout on Windows is `.venv/Scripts/python.exe`; `setup.sh` / `run.sh`
  detect both POSIX (`bin/`) and Windows (`Scripts/`) layouts.
- When running plain `npm run dev` (PILOT_HOME=`~/.pilotdeck`), link this
  plugin into the global plugins dir so the runtime discovers it
  (symlinks need dev mode/admin; a junction works without):
  `cmd //c mklink /J "%USERPROFILE%\.pilotdeck\plugins\med-tools" "D:\projects\med-pilotdeck\plugins\med-tools"`

`plugin.json` MCP command is `node ${env:PILOT_HOME}/plugins/med-tools/run-mcp.cjs`
(the node launcher locates the venv python itself; it deliberately avoids
shell resolution because on Windows plain `bash` can resolve to WSL's bash).
`run.sh` remains for manual use. `timeoutMs: 300000` (5 minutes) for this MCP only.

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
| `MED_RAG_SERVICE_ENABLED` | `1` | Query the remote med-rag service first; `0` = local corpus only |
| `MED_RAG_SERVICE_API_BASE` | `http://127.0.0.1:18080` | med-rag service base (no `/v1`; not OpenAI-shaped) |
| `MED_RAG_SERVICE_ENDPOINT` | `{API_BASE}/retrieve` | Override the retrieve URL |
| `MED_RAG_SERVICE_HEALTH_ENDPOINT` | `{API_BASE}/health` | Override the health URL |
| `MED_RAG_SERVICE_TIMEOUT_SECONDS` | `60` | Retrieve timeout; on timeout we degrade to the local corpus |
| `MED_RAG_SERVICE_MAX_CHARS_PER_CHUNK` | `1800` | Per-chunk text budget passed to the service |
| `MED_RAG_SERVICE_API_KEY` | *(empty)* | Bearer token; the service is unauthenticated today |
| `MED_RAG_TOPIC` | `战创伤` | Default topic filter; empty string = whole library |
| `MED_RAG_MANIFEST` | `<plugin>/data/rag/manifest.json` | Override manifest path (tests) |
| `MED_DICOM_DERIVED_DIR` / `MED_DERIVED_DIR` | `<parent>/.med-tools-derived` | Preview/PNG output dir |

`med_trauma_rag_query` hits the remote med-rag service (`POST /retrieve`, evidence
only — generation stays with the PilotDeck main model) and falls back to the
in-plugin corpus when the service is unreachable. Check `retrieval_backend`
(`remote` / `local`) and `mode` (`remote` / `vector` / `lexical` /
`lexical-fallback`) in the response. Note that remote scores are RRF fusion
values on a different scale from local cosine, so `min_score` is applied to the
local vector path only. `med_trauma_rag_status` probes the service and reports
`rag_service.reachable` plus `active_backend`.

Only `MED_RAG_SERVICE_API_BASE` normally needs setting — the retrieve and health
URLs derive from it.

When `MED_VLM_FALLBACK_*` are unset, med-tools reads `$PILOT_HOME/pilotdeck.yaml` (then `.pilotdeck-home/pilotdeck.yaml` / `~/.pilotdeck/pilotdeck.yaml`) and uses `agent.model` plus that provider's `url` / `apiKey`.

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
