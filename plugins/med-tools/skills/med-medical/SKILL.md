---
name: med-medical
description: Parse medical attachments (DICOM, PDF reports, report screenshots, CDA/XML, lab text, JSON, ECG/WFDB) via med-tools MCP. Prefer local G9-V-Med report; if unavailable, use GPT-5.5 fallback report or continue with the main agent. Use whenever the user uploads or points to medical imaging, reports, documents, labs, or ECG files — including a whole folder of mixed formats.
---

# Medical multi-source (med-tools)

When the user provides **medical materials** — single file, multiple files, or a folder — including any of:

- Imaging: `.dcm` / `.dicom`
- Reports / screenshots: `.pdf`, `.png` / `.jpg` / `.jpeg` / `.bmp`
- Documents: `.xml` / `.cda`, `.txt` / `.md` / `.markdown`, `.json` / `.xml1`
- ECG: `.hea` / `.dat`, `.ecg` / `.wfdb` / `.atr` / `.qrs` / `.edf` / `.scp`

Do this:

1. Call **`mcp__med-tools__med_parse_medical`** (unified entry).
2. Pass `path` as an absolute path when possible (file **or** directory).
3. Do **not** open these with `read_file` / ad-hoc parsing yourself — the tool parses locally and prefers on-box **G9-V-Med** (`:8030`). If G9 is down, the tool may fall back to the main agent model (GPT-5.5) inside the plugin.
4. After the tool returns JSON:
   - If `report` is non-empty: **paste `report` verbatim** (原样展示). Do not rewrite / compress / re-outline. At most 1–2 short lines before/after noting model name and whether `fallback_used` is true.
   - If `report` is empty and `agent_continue` is true: **do not stop**. Use `summary`, `png_paths`, `warnings`, and `vlm_error` to continue the medical interpretation with the **main agent model**, following the same structured Chinese report sections expected by med-tools. Clearly state that G9 was unavailable and this is a main-agent fallback reading.

## Chat attachments

Folder upload and paperclip multi-file upload use the **same** attachment path:

```text
[Files attached by user and available for reading in the project:]
- name: /absolute/path/to/file
...
[Attachment diagnostics]
- File extension .xml / .dcm / ... is not in the inline text whitelist; skipped.
```

- Medical binaries / XML / CDA are **not** inlined. Call MCP; do not `read_file` them.
- One file → call `med_parse_medical` on that path.
- Several medical files in one turn (folder or multi-select) → prefer **one** `med_parse_medical` on their common parent directory under `.tmp/chat-attachments/` when paths clearly share a folder; otherwise call per file.
- Project Files panel: `@`-mention a workspace directory and call once on that directory.

Optional:

- `max_items` (default **64**, max **64**) for directory batches.
- `max_frames` (default 8) for DICOM / image sampling into the VLM.
- `skip_vlm: true` only if the user wants metadata/preview extraction without a model report.
- `med_tools_health` to check primary VLM / fallback / dependency status.
