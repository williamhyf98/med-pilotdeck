# med-tools (PilotDeck plugin)

MCP plugin that adds **multi-source medical parsing**, local **G9-V-Med** reports,
remote **DAMO RADAR abdominal CT analysis**, **DeepChest 3DMedAgent chest CT
workflow**, **war-trauma RAG Q&A**, and **six-stage formal care plans** to
PilotDeck.

## Tools

| Tool | Role |
|------|------|
| `med_dicom_route` | Local read-only DICOM modality/body-part/series preflight and Skill recommendation |
| `med_parse_medical` | Parse medical file/folder + G9 report |
| `med_tools_health` | VLM / deps / RAG summary |
| `med_radar_status` | Check the node12 RADAR service, resident model, and CUDA |
| `med_radar_analyze_ct` | Run RADAR on NIfTI or a DICOM CT series and return ranked scores |
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
  ├─【自动识别 DICOM 模态/部位】── Skill med-dicom-router
  │                  └─ med_dicom_route（本地只读元数据）
  │                     ├─ 非 CT / 不完整 / 不确定 → med-medical
  │                     ├─ 非腹部且部位明确的完整 CT → med-deepchest-3dmedagent
  │                     └─ 腹部/盆腔完整 CT → med-radar-ct → RADAR → 主智能体按用户问题回答
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
  ├─【RADAR 腹部 CT 分析】── Skill med-radar-ct
  │                  ├─ med_radar_status（按需检查运行环境）
  │                  └─ med_radar_analyze_ct → 结构化异常评分 + CSV
  │
  ├─【DeepChest 胸部 CT / 3DMedAgent】── Skill med-deepchest-3dmedagent
  │                  └─ 本地 shell workflow → dry-run / CT-CLIP / Agent 产物
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
- `med-radar-ct` — node12 RADAR 三维 CT 推理；只把分数当作需复核的模型信号
- `med-deepchest-3dmedagent` — `/data1/chenchi/3D-MLLM` 中的 DeepChestVQA / CT-CLIP / 3DMedAgent 胸部流程；这是 shell workflow，不是新的 MCP 工具
- `med-dicom-router` — 本地只读 DICOM 预检和 Skill 路由；不会解码像素、调用模型或上传 node12

3DMedAgent 与 RADAR 是两个独立医学流程。完整腹部/盆腔 CT 自动调用 RADAR；其他部位明确的完整 CT 先进入 3DMedAgent。胸部具备完整 DeepChest/CT-CLIP 支持；头颈、脊柱、四肢等当前不在器官词表内时必须明确兼容性降级。两套证据、分数、产物和限制分别保留，不把 RADAR 分数写入 3DMedAgent `facts_memory`。

### MCP 调用前的 Skill 门禁

所有 `mcp__med-tools__*` 工具都经过会话级 Skill 门禁：

1. 若本会话已经通过 `read_skill` 加载了对应医学 Skill，工具正常执行。
2. 若模型跳过 `read_skill` 直接调用 MCP，首次调用**不执行医学工具**；运行时自动加载完整 Skill，并把正文和“重新规划、重新调用”的提示返回模型。
3. 模型按 Skill 重新规划并再次调用后，MCP 才真正执行。

映射关系：

- `med_dicom_route` → `med-dicom-router`；已加载 `med-medical` 时也可使用。
- `med_parse_medical` → `med-medical`；已加载 `med-case-report` 或 `med-trauma-stage-plan` 时也可使用。
- `med_trauma_rag_query` / `med_trauma_rag_status` → `med-trauma-assist`。
- `med_trauma_stage_plan` → `med-trauma-stage-plan`。
- `med_radar_analyze_ct` / `med_radar_status` → `med-radar-ct`。
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

## DAMO RADAR（腹部 CT）

`med_radar_analyze_ct(path, top_k?, threshold?, max_cases?, study_context?)` reads
data on node36 and uploads it to the persistent RADAR service on node12. It accepts:

- one `.nii` / `.nii.gz` volume;
- a directory containing NIfTI volumes; or
- a DICOM CT series directory. Files are validated as CT by DICOM metadata before upload.

Node12 keeps one FastAPI process and one loaded model on GPU 4. Requests are accepted
one at a time. NIfTI data or a ZIP containing the validated DICOM series is uploaded
over authenticated HTTPS on the private network; the raw upload and staged input are deleted after inference,
and the remote result directory is deleted after node36 downloads the CSV (with a
one-hour TTL as a fallback). Every request requires a bearer key.
The service accepts NIfTI volumes, DICOM CT series directories, and single
multi-frame CT DICOM files with at least three frames. DICOM inputs are converted to
temporary NIfTI volumes on node12 before the existing RADAR preprocessing runs;
single-frame DICOM and non-CT DICOM are rejected. The service enforces authentication,
single-request admission, and actual streamed request size before multipart parsing.
NIfTI headers are checked for a bounded 3D numeric volume, axis-aligned geometry, and
both decoded and model-resampled memory budgets before voxel data reaches the model.
The GPU budget includes RADAR's three peak 37-channel mask tensors rather than only
the input image.

```text
node12 /local_data/radar-service/
  app.py
  radar_inference.py
  radar.env                  # mode 600; not committed
  venv/
  damo-radar/
  models/
```

The node36 key is read from `$PILOT_HOME/secrets/med-radar-api-key` by default.
Raw scores and a JSON summary are kept in a unique directory under
`derived/radar/<study>-<hash>/<request-uuid>/`; the MCP response contains only bounded
ranked results. RADAR was trained primarily on contrast-enhanced abdominal CT. Scores
are not calibrated probabilities or diagnoses, low scores do not exclude disease, and
out-of-domain studies must be labeled as such.

### Node12 service deployment

The deployment unit and pinned service dependencies live in `radar-service/`. Create a
`--system-site-packages` venv so the host CUDA build of PyTorch is reused, then install
`radar-service/requirements.txt`. Copy the official RADAR source to `damo-radar/`, model
files to `models/`, and `scripts/radar_inference.py` beside `app.py`. Create a dedicated
`radar` system user, copy `radar.env.example` to `radar.env`, replace the API key, set
mode `600`, install `radar.service`, and start it with systemd. The unit binds only
`10.31.112.13:18120` with a certificate containing that IP as a SAN, sets
`CUDA_VISIBLE_DEVICES=4`, and runs the service as `radar`. Place the trusted certificate
on node36 at `$PILOT_HOME/certs/med-radar-ca.crt`.

Before starting the unit, create its writable paths and TLS files:

```bash
install -d -o radar -g radar -m 0700 \
  /local_data/radar-service/{work,tmp,cache,tls}
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
  -keyout /local_data/radar-service/tls/server.key \
  -out /local_data/radar-service/tls/server.crt \
  -subj '/CN=10.31.112.13' -addext 'subjectAltName=IP:10.31.112.13'
chown radar:radar /local_data/radar-service/tls/server.{key,crt}
chmod 0600 /local_data/radar-service/tls/server.key
```

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
`run.sh` remains for manual use. `timeoutMs: 900000` (15 minutes) for this MCP only.

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
| `MED_RADAR_API_BASE` | `https://10.31.112.13:18120` | Persistent node12 RADAR service base |
| `MED_RADAR_API_KEY` | *(empty)* | Bearer key; takes precedence over the key file |
| `MED_RADAR_API_KEY_FILE` | `$PILOT_HOME/secrets/med-radar-api-key` | Node36 key file; keep mode `600` |
| `MED_RADAR_CA_BUNDLE` | `$PILOT_HOME/certs/med-radar-ca.crt` | Trusted node12 service certificate |
| `MED_RADAR_TIMEOUT_SECONDS` | `840` | Upload + inference + download timeout (30-3600 seconds) |
| `MED_RADAR_MAX_UPLOAD_BYTES` | `8589934592` | Maximum selected input bytes before upload |
| `MED_RADAR_OUTPUT_DIR` | `$PILOT_HOME/artifacts/radar` in `plugin.json` | Central artifact root on node36; direct clients otherwise use `<input-parent>/derived/radar` |

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

.venv/bin/python -c "
from server.radar import radar_status
print(radar_status(validate_runtime=True))
"
```
