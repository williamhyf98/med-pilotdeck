# med-tools (PilotDeck plugin)

MCP plugin that adds **multi-source medical parsing** + local **G9-V-Med (27B)** reports to PilotDeck.

## Primary tool: `med_parse_medical`

Unified entry (aligned with offline-301 suffixes):

1. Accept a **file or directory** (for chat/Files folder uploads, pass the folder root once).
2. Parse locally by type: DICOM, PDF, images, CDA/XML, text/markdown, JSON, WFDB/ECG (some ECG types degraded).
3. Call local **G9-V-Med** (`http://127.0.0.1:8030/v1`) for one structured Chinese report.
4. Agent should show the returned `report` **verbatim**.

Directory batches default to `max_items=64` (max 64); truncated folders surface a warning with discovered vs parsed counts.

Supported suffixes: `.cda .xml .json .xml1 .txt .md .markdown .pdf .png .jpg .jpeg .bmp .dcm .dicom .ecg .wfdb .hea .dat .atr .qrs .edf .scp`

## Setup

Prefer the project-local launcher so `PILOT_HOME` points at
`PilotDeck/.pilotdeck-home` (no `~/.pilotdeck`):

```bash
# from PilotDeck root
./scripts/bootstrap-runtime.sh   # once
./scripts/start-local.sh         # creates .pilotdeck-home + links this plugin
```

Manual venv only:

```bash
cd plugins/med-tools
bash setup.sh
```

`scripts/start-local.sh` symlinks this directory to
`$PILOT_HOME/plugins/med-tools`. MCP command uses
`${pilotHome}/plugins/med-tools/run.sh`.

`plugin.json` sets `timeoutMs: 300000` (5 minutes) for this MCP only; other MCP servers keep the global default (60s).

Restart PilotDeck (or reload plugins). Tools appear as:

- `mcp__med-tools__med_parse_medical`
- `mcp__med-tools__med_tools_health`

Skill: `med-medical`.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `MED_VLM_API_BASE` | `http://127.0.0.1:8030/v1` | OpenAI-compatible base |
| `MED_VLM_MODEL` | `G9-V-Med` | Model id |
| `MED_VLM_API_KEY` | `EMPTY` | Bearer token if required |
| `MED_VLM_MAX_TOKENS` | `8192` | Max generation tokens |
| `MED_DICOM_DERIVED_DIR` / `MED_DERIVED_DIR` | `<parent>/.med-tools-derived` | Preview/PNG output dir |

Optional Python deps (degraded if missing): `pymupdf`, `wfdb`.

## Manual smoke test

```bash
.venv/bin/python -c "
from pathlib import Path
from server.parsers import parse_medical_file, SUPPORTED_SUFFIXES
print('suffixes', len(SUPPORTED_SUFFIXES))
r = parse_medical_file(Path('sample.txt'), derived_dir=Path('/tmp/med-derived'))
print(r.status, r.kind, r.summary[:80])
"
```
