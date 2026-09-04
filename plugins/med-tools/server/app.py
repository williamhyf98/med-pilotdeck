"""PilotDeck MCP server: unified medical parse + local G9-V-Med (27B)."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from mcp.server.fastmcp import Context, FastMCP

from .parsers import SUPPORTED_SUFFIXES, collect_medical_files, parse_medical_file
from .vlm_client import analyze_medical_with_vlm, get_vlm_config

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
MEDICAL_PROMPT_PATH = PLUGIN_ROOT / "prompts" / "medical_read.md"
DICOM_PROMPT_PATH = PLUGIN_ROOT / "prompts" / "dicom_read.md"

PRESENTATION = (
    "若 report 非空：将 report 字段原样展示给用户；不要改写、压缩、转述或重新组织。"
    "最多可在报告前后各加 1–2 句说明（来源模型/是否回退/文件名/错误）。"
    "若 report 为空且 agent_continue=true：主 Agent 必须根据 summary / png_paths / warnings "
    "继续完成结构化中文医学解读，不要因 VLM 失败而中止任务。"
)

mcp = FastMCP(
    "med-tools",
    instructions=(
        "Medical helper tools for PilotDeck. "
        "Prefer med_parse_medical for any supported medical attachment "
        f"(suffixes: {', '.join(sorted(SUPPORTED_SUFFIXES))}): parse locally, "
        "then call on-box G9-V-Med for a structured report "
        "(falls back to the main agent model when G9 is unavailable). "
        "If report is non-empty, show it verbatim. "
        "If report is empty and agent_continue=true, continue the medical "
        "interpretation yourself using summary/png_paths. "
        "For war-trauma knowledge Q&A: call med_trauma_rag_query, then the main "
        "model answers from chunks (brief tips OK; not the formal five-section plan). "
        "For adding document-ingest chunks to RAG, call med_trauma_rag_import_mineru_bundle; "
        "it creates a new merged bundle and does not activate it unless explicitly requested. "
        "For a formal six-stage graded care plan: call med_trauma_stage_plan "
        "(G9 inside the plugin; show care_plan verbatim)."
    ),
)


def _load_prompt(prefer_medical: bool = True) -> str:
    if prefer_medical and MEDICAL_PROMPT_PATH.is_file():
        return MEDICAL_PROMPT_PATH.read_text(encoding="utf-8").strip()
    if DICOM_PROMPT_PATH.is_file():
        return DICOM_PROMPT_PATH.read_text(encoding="utf-8").strip()
    return (
        "你是医学多模态辅助分析助手。请根据本地解析摘要与预览图输出结构化中文报告。"
    )


def _resolve_derived_dir(anchor: Path) -> Path:
    override = os.environ.get("MED_DICOM_DERIVED_DIR", "").strip() or os.environ.get(
        "MED_DERIVED_DIR", ""
    ).strip()
    if override:
        derived = Path(override).expanduser().resolve()
    else:
        base = anchor if anchor.is_dir() else anchor.parent
        derived = base / ".med-tools-derived"
    derived.mkdir(parents=True, exist_ok=True)
    return derived


def _resolve_path(path: str) -> Path:
    file_path = Path(path).expanduser()
    if not file_path.is_absolute():
        file_path = (Path.cwd() / file_path).resolve()
    else:
        file_path = file_path.resolve()
    return file_path


def _cap_summary(text: str, limit: int = 12_000) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n…[已截断]"


def _prepare_medical_parse(
    *,
    path: str,
    max_items: int = 64,
    max_frames: int = 8,
    skip_vlm: bool = False,
    tool_name: str = "med_parse_medical",
) -> Dict[str, Any]:
    """Parse phase only (no VLM). Returns the base payload plus VLM inputs.

    The returned dict carries a private ``_vlm`` key describing whether the VLM
    should run and with what summary/images. Callers strip it before returning.
    """
    root = _resolve_path(path)
    derived_dir = _resolve_derived_dir(root)
    max_items = max(1, min(int(max_items or 64), 64))
    max_frames = max(1, min(int(max_frames or 8), 32))

    payload: Dict[str, Any] = {
        "tool": tool_name,
        "status": "error",
        "path": str(root),
        "supported_suffixes": sorted(SUPPORTED_SUFFIXES),
        "items": [],
        "summary": "",
        "warnings": [],
        "png_paths": [],
        "report": "",
        "model": None,
        "api_base": None,
        "vlm_ok": False,
        "vlm_error": "",
        "fallback_used": False,
        "agent_continue": False,
        "primary_model": None,
        "primary_error": "",
        "presentation": PRESENTATION,
    }

    if not root.exists():
        payload["warnings"] = [f"路径不存在：{root}"]
        payload["vlm_error"] = "path missing"
        return payload

    # Discover generously so truncation warnings report true folder size;
    # parse still respects max_items (≤64).
    files = collect_medical_files(root, max_files=max(512, max_items * 8))
    discovered_count = len(files)

    if not files and root.is_file():
        files = [root]
        discovered_count = 1

    if not files:
        payload["warnings"] = [
            f"未找到可解析的医学附件。支持扩展名：{', '.join(sorted(SUPPORTED_SUFFIXES))}"
        ]
        payload["vlm_error"] = "no files"
        return payload

    truncated = False
    if len(files) > max_items:
        truncated = True
        files = files[:max_items]
    items: List[Dict[str, Any]] = []
    all_warnings: List[str] = []
    if truncated or (root.is_dir() and discovered_count > len(files)):
        all_warnings.append(
            f"目录共发现 {discovered_count} 个可解析医学文件，本次仅解析前 {len(files)} 个"
            f"（max_items={max_items}）。如需更多，请提高 max_items（上限 64）或拆分目录。"
        )
    all_pngs: List[str] = []
    summary_parts: List[str] = []
    any_ready = False

    for index, file_path in enumerate(files, start=1):
        outcome = parse_medical_file(
            file_path,
            derived_dir=derived_dir,
            max_text_chars=6_000,
            max_dicom_frames=max_frames,
            max_image_long_side=1600,
        )
        pngs = [p for p in (outcome.model_image_refs or []) if Path(p).is_file()]
        item = {
            "index": index,
            "path": str(file_path),
            "filename": file_path.name,
            "kind": outcome.kind,
            "subtype": outcome.subtype,
            "status": outcome.status,
            "included": outcome.included,
            "summary": outcome.summary,
            "metadata": outcome.metadata,
            "warnings": outcome.warnings,
            "png_paths": pngs,
        }
        items.append(item)
        all_warnings.extend(outcome.warnings or [])
        all_pngs.extend(pngs)
        if outcome.status in {"ready", "degraded"} and outcome.included:
            any_ready = True
        summary_parts.append(
            f"### 附件 {index}: {file_path.name} [{outcome.kind}/{outcome.subtype}] "
            f"status={outcome.status}\n{outcome.summary}"
        )

    seen = set()
    unique_pngs: List[str] = []
    for png in all_pngs:
        if png in seen:
            continue
        seen.add(png)
        unique_pngs.append(png)

    combined_summary = _cap_summary(
        f"共解析 {len(items)} 个医学附件。\n\n" + "\n\n".join(summary_parts)
    )
    if any_ready:
        status = "ready"
    elif items:
        status = "degraded"
    else:
        status = "error"

    payload.update(
        {
            "status": status,
            "items": items,
            "summary": combined_summary,
            "warnings": all_warnings,
            "png_paths": unique_pngs,
        }
    )

    if skip_vlm:
        payload["vlm_error"] = "skipped"
        payload["_vlm"] = {"run": False}
        return payload

    if not combined_summary.strip() and not unique_pngs:
        payload["vlm_error"] = "parse failed; skipped VLM"
        payload["_vlm"] = {"run": False}
        return payload

    payload["_vlm"] = {
        "run": True,
        "summary": combined_summary,
        "png_paths": unique_pngs,
        "max_images": max(1, min(max(len(unique_pngs), 1), max_frames * max(1, len(items)))),
    }
    return payload


def _apply_vlm_result(payload: Dict[str, Any], vlm: Dict[str, Any]) -> Dict[str, Any]:
    payload["vlm_ok"] = bool(vlm.get("ok"))
    payload["vlm_error"] = str(vlm.get("error") or "")
    payload["report"] = str(vlm.get("report") or "")
    # `ok` marks a directly-usable report so the runtime can finalize the turn
    # with the streamed text (mirrors med_trauma_stage_plan's contract).
    payload["ok"] = bool(vlm.get("ok")) and bool(payload["report"].strip())
    payload["model"] = vlm.get("model")
    payload["api_base"] = vlm.get("api_base")
    payload["fallback_used"] = bool(vlm.get("fallback_used"))
    payload["agent_continue"] = bool(vlm.get("agent_continue"))
    payload["primary_model"] = vlm.get("primary_model")
    payload["primary_error"] = str(vlm.get("primary_error") or "")
    if vlm.get("usage") is not None:
        payload["usage"] = vlm["usage"]
    if not payload["vlm_ok"] and payload["status"] == "ready":
        payload["status"] = "degraded"
    elif payload["fallback_used"] and payload["vlm_ok"] and payload["status"] == "ready":
        payload["status"] = "degraded"
        payload["warnings"] = list(payload.get("warnings") or []) + [
            f"G9-V-Med 不可用，已回退到 {payload.get('model')} 生成报告。"
            f" primary_error={payload.get('primary_error') or 'unknown'}"
        ]
    return payload


def _run_medical_parse(
    *,
    path: str,
    max_items: int = 64,
    max_frames: int = 8,
    skip_vlm: bool = False,
    tool_name: str = "med_parse_medical",
) -> Dict[str, Any]:
    """Blocking parse + non-streaming VLM report (used by tests / fallback callers)."""
    payload = _prepare_medical_parse(
        path=path,
        max_items=max_items,
        max_frames=max_frames,
        skip_vlm=skip_vlm,
        tool_name=tool_name,
    )
    vlm_plan = payload.pop("_vlm", {"run": False})
    if not vlm_plan.get("run"):
        return payload

    vlm = analyze_medical_with_vlm(
        system_prompt=_load_prompt(prefer_medical=True),
        summary=vlm_plan["summary"],
        png_paths=vlm_plan["png_paths"],
        max_images=vlm_plan["max_images"],
        require_images=False,
    )
    return _apply_vlm_result(payload, vlm)


async def _run_medical_parse_stream(
    *,
    path: str,
    on_text: Callable[[str], Awaitable[None]],
    max_items: int = 64,
    max_frames: int = 8,
    skip_vlm: bool = False,
    tool_name: str = "med_parse_medical",
) -> Dict[str, Any]:
    """Parse then stream the G9 report through ``on_text`` (with main-agent fallback)."""
    from .vlm_client import analyze_medical_with_vlm_stream

    payload = _prepare_medical_parse(
        path=path,
        max_items=max_items,
        max_frames=max_frames,
        skip_vlm=skip_vlm,
        tool_name=tool_name,
    )
    vlm_plan = payload.pop("_vlm", {"run": False})
    if not vlm_plan.get("run"):
        return payload

    vlm = await analyze_medical_with_vlm_stream(
        system_prompt=_load_prompt(prefer_medical=True),
        summary=vlm_plan["summary"],
        on_text=on_text,
        png_paths=vlm_plan["png_paths"],
        max_images=vlm_plan["max_images"],
        require_images=False,
    )
    payload = _apply_vlm_result(payload, vlm)
    if vlm.get("streamed"):
        payload["streamed"] = True
    if vlm.get("stream_interrupted"):
        payload["stream_interrupted"] = True
    return payload


@mcp.tool()
async def med_parse_medical(
    path: str,
    ctx: Context,
    max_items: int = 64,
    max_frames: int = 8,
    skip_vlm: bool = False,
) -> str:
    """Unified medical attachment parser + G9-V-Med report (301-aligned suffixes).

    Accepts a single file or a directory. Supported suffixes include:
    .dcm/.dicom, .pdf, .png/.jpg/.jpeg/.bmp, .xml/.cda, .txt/.md,
    .json/.xml1, .hea/.dat and other ECG-related names (some degraded).

    Steps:
    1. Local parse (metadata / text / preview images).
    2. Unless skip_vlm, call G9-V-Med and return one structured Chinese report.

    Agent presentation rule (important):
    If `report` is non-empty, show it VERBATIM (do not rewrite).
    If `report` is empty and `agent_continue` is true, continue the medical
    interpretation yourself with the main agent using summary/png_paths.

    The G9 report streams live to the chat while it is generated; on success the
    runtime shows `report` directly, so do not paste it again.

    Args:
        path: Absolute or relative path to a medical file or folder.
        max_items: Max files to parse from a directory (default 64, max 64).
        max_frames: Max DICOM frames / images per file for VLM (default 8).
        skip_vlm: If true, only parse; do not call the 27B model.
    """
    streamed_chars = 0
    pending_chunks: List[str] = []

    async def flush_text() -> None:
        nonlocal streamed_chars
        text = "".join(pending_chunks)
        if not text:
            return
        pending_chunks.clear()
        streamed_chars += len(text)
        await ctx.report_progress(progress=streamed_chars, message=text)

    async def emit_text(text: str) -> None:
        pending_chunks.append(text)
        buffered = "".join(pending_chunks)
        if len(buffered) >= 24 or "\n" in buffered:
            await flush_text()

    payload = await _run_medical_parse_stream(
        path=path,
        on_text=emit_text,
        max_items=max_items,
        max_frames=max_frames,
        skip_vlm=skip_vlm,
        tool_name="med_parse_medical",
    )
    await flush_text()
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool()
def med_tools_health() -> str:
    """Check med-tools dependencies and medical VLM / fallback reachability."""
    from .vlm_client import get_fallback_vlm_config

    cfg = get_vlm_config()
    fallback = get_fallback_vlm_config()
    info: Dict[str, Any] = {
        "ok": True,
        "plugin_root": str(PLUGIN_ROOT),
        "vlm": {
            "api_base": cfg["api_base"],
            "model": cfg["model"],
            "fallback_enabled": cfg["fallback_enabled"],
            "fallback_api_base": cfg["fallback_api_base"],
            "fallback_model": cfg["fallback_model"],
            "fallback_source": cfg.get("fallback_source", "unset"),
            "fallback_agent_ref": cfg.get("fallback_agent_ref", ""),
        },
        "supported_suffixes": sorted(SUPPORTED_SUFFIXES),
        "pydicom": False,
        "pillow": False,
        "numpy": False,
        "pypdf": False,
        "pymupdf": False,
        "wfdb": False,
        "models": None,
        "fallback_models": None,
        "primary_ok": False,
        "fallback_ok": False,
        "error": "",
    }

    for mod_name, key in (
        ("pydicom", "pydicom"),
        ("PIL", "pillow"),
        ("numpy", "numpy"),
        ("pypdf", "pypdf"),
        ("fitz", "pymupdf"),
        ("wfdb", "wfdb"),
    ):
        try:
            __import__(mod_name)
            info[key] = True
        except Exception as exc:
            info[key] = False
            optional = key in {"pymupdf", "wfdb", "pypdf"}
            if not optional:
                info["ok"] = False
                prefix = (info["error"] + "; ") if info["error"] else ""
                info["error"] = f"{prefix}{key}: {exc}"

    try:
        import httpx

        with httpx.Client(timeout=5.0) as client:
            response = client.get(
                f"{cfg['api_base']}/models",
                headers={"Authorization": f"Bearer {cfg['api_key']}"},
            )
            response.raise_for_status()
            info["models"] = response.json()
            info["primary_ok"] = True
    except Exception as exc:
        prefix = (info["error"] + "; ") if info["error"] else ""
        info["error"] = f"{prefix}vlm: {exc}"

    if fallback is not None:
        try:
            import httpx

            with httpx.Client(timeout=8.0) as client:
                response = client.get(
                    f"{fallback['api_base']}/models",
                    headers={"Authorization": f"Bearer {fallback['api_key']}"},
                )
                response.raise_for_status()
                info["fallback_models"] = response.json()
                info["fallback_ok"] = True
        except Exception as exc:
            prefix = (info["error"] + "; ") if info["error"] else ""
            info["error"] = f"{prefix}fallback: {exc}"

    # Plugin remains usable when primary is down but fallback is healthy
    # (or when the main agent can continue from parse-only results).
    if not info["primary_ok"] and not info["fallback_ok"]:
        info["ok"] = False

    try:
        from .rag import rag_status

        info["rag"] = rag_status(validate=False)
    except Exception as exc:  # noqa: BLE001
        info["rag"] = {"ready": False, "reason": f"{type(exc).__name__}: {exc}"}

    return json.dumps(info, ensure_ascii=False, indent=2)


@mcp.tool()
def med_trauma_rag_status(validate: bool = False) -> str:
    """Report military-medicine RAG corpus readiness (rows, dimension, mode hints).

    Args:
        validate: If true, load and SHA-256-check corpus/embedding artifacts now.
    """
    from .rag import rag_status

    payload = rag_status(validate=bool(validate))
    payload["tool"] = "med_trauma_rag_status"
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool()
def med_trauma_rag_query(
    query: str,
    top_k: int = 3,
    min_score: float = 0.35,
    prefer_lexical: bool = False,
) -> str:
    """Retrieve military-medicine textbook evidence for Q&A (not the formal stage plan).

    Returns evidence only (`chunks`, `context_chunks`, sources, and optional
    `interleave_context` image attachments). The PilotDeck main model answers
    the knowledge question and may add brief disposition tips. For process /
    step / figure questions, prefer one dominant source corpus and use any
    `context_chunks` only as adjacent context from the same source; do not mix
    unrelated books into one answer. Use this for textbook evidence and
    textbook figures; do not use web_search/web_fetch to find replacement
    textbook figures. For a formal five-section graded care plan, use
    med_trauma_stage_plan instead.

    Args:
        query: Chinese/English search text (concept / keywords / injury question).
        top_k: Number of chunks to return (1–8, default 3).
        min_score: Minimum cosine score for vector mode (ignored on lexical fallback).
        prefer_lexical: Force deterministic lexical search (no embedding call).
    """
    from .rag import query_rag

    payload = query_rag(
        query=query,
        top_k=top_k,
        min_score=min_score,
        prefer_lexical=prefer_lexical,
    )
    payload["tool"] = "med_trauma_rag_query"
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool()
def med_trauma_rag_import_mineru_bundle(
    ingest_manifest_path: str,
    target_corpus_id: str,
    base_manifest_path: str = "",
    name: str = "",
    version: str = "",
    license_id: str = "",
    destination: str = "",
    activate: bool = False,
    validate: bool = True,
) -> str:
    """Append a MinerU ingest bundle to the current RAG corpus as a new version.

    This never mutates the base bundle in place.  It reads the active/base RAG
    manifest, appends chunks from the MinerU ingest bundle, embeds only the new
    chunks, and writes a new self-contained RAG bundle.  Pass ``activate=true``
    only after you intentionally want PilotDeck RAG to switch to the new
    manifest.

    Args:
        ingest_manifest_path: Absolute path to MinerU job/batch bundle manifest.
        target_corpus_id: Stable id for the newly merged RAG corpus version.
        base_manifest_path: Optional base RAG manifest; defaults to active RAG.
        name: Display name for the new corpus; defaults to target_corpus_id.
        version: Version string; defaults to target_corpus_id.
        license_id: Optional license/auth id; defaults to the base manifest's id.
        destination: Optional exact output directory; defaults beside base bundle.
        activate: If true, validate and switch the personal RAG manifest pointer.
        validate: If true, load/check the produced bundle before returning.
    """

    from .rag.rag_bundle import build_incremental_rag_bundle
    from .rag.store import activate_manifest, get_active_manifest_path

    target = str(target_corpus_id or "").strip()
    if not target:
        raise ValueError("target_corpus_id is required")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", target):
        raise ValueError("target_corpus_id must be a safe directory name: letters/digits/._-, max 128 chars")
    base_manifest = Path(base_manifest_path).expanduser().resolve() if base_manifest_path.strip() else get_active_manifest_path()
    if destination.strip():
        destination_path = Path(destination).expanduser().resolve()
    else:
        destination_path = base_manifest.parent.parent / target
    payload = build_incremental_rag_bundle(
        base_manifest_path=base_manifest,
        ingest_manifest_path=Path(ingest_manifest_path),
        destination=destination_path,
        corpus_id=target,
        name=name.strip() or target,
        version=version.strip() or target,
        license_id=license_id.strip() or None,
        validate=bool(validate),
    )
    if activate:
        pointer = activate_manifest(Path(payload["manifest_path"]))
        payload["activated"] = True
        payload["active_pointer_path"] = str(pointer)
    payload["summary"] = {
        "base_manifest_path": str(base_manifest),
        "ingest_manifest_path": str(Path(ingest_manifest_path).expanduser().resolve()),
        "old_chunk_count": payload.get("old_chunk_count"),
        "new_chunk_count": payload.get("new_chunk_count"),
        "total_chunk_count": payload.get("total_chunk_count"),
        "embedding_dimension": payload.get("embedding_dimension"),
        "asset_count": payload.get("asset_count"),
        "activated": payload.get("activated"),
    }
    payload["next_step"] = (
        "Run med_trauma_rag_status validate=true and query the new corpus"
        if payload.get("activated")
        else "Inspect validation/summary, then call med_trauma_rag_activate_manifest with manifest_path when ready"
    )
    payload["tool"] = "med_trauma_rag_import_mineru_bundle"
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool()
def med_trauma_rag_activate_manifest(manifest_path: str) -> str:
    """Validate and switch the personal RAG manifest pointer to an existing bundle."""

    from .rag.store import activate_manifest

    pointer = activate_manifest(Path(manifest_path))
    payload = {
        "tool": "med_trauma_rag_activate_manifest",
        "activated": True,
        "manifest_path": str(Path(manifest_path).expanduser().resolve()),
        "active_pointer_path": str(pointer),
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool()
async def med_trauma_stage_plan(
    stage: str,
    injury_text: str,
    ctx: Context,
    image_paths: Optional[List[str]] = None,
    max_images: int = 8,
) -> str:
    """Generate a formal six-stage war-trauma graded care plan via G9-V-Med.

    One stage per call. Plugin builds the fixed Chinese prompt (stage-specific
    task + five output sections + multi-image reading rules), calls on-box
    G9-V-Med, and falls back to the configured main agent model when G9 fails.

    Agent presentation rule (important):
    If `care_plan` is non-empty, show it VERBATIM (do not rewrite).
    If `care_plan` is empty and `agent_continue` is true, write the five-section
    plan yourself and state that G9/fallback failed.

    Args:
        stage: One of 伤员发生地 / 野战分类场 / 收容处置组 / 重伤救治组 / 手术组 / 洗消组.
        injury_text: Visible injury narrative for 【可见伤情】. Prefer the user's
            compliant description verbatim; otherwise rewrite user text into a proper
            injury narrative. Fold med_parse_medical report/summary here when present.
            Do NOT invent image findings from photos in the Agent — pass photos via
            image_paths so G9 reads them.
        image_paths: Optional absolute paths to ordinary injury photos for G9.
        max_images: Max images to send (default 8, max 16).
    """
    from .trauma_stage_plan import generate_stage_plan_stream

    streamed_chars = 0
    pending_chunks: List[str] = []

    async def flush_text() -> None:
        nonlocal streamed_chars
        text = "".join(pending_chunks)
        if not text:
            return
        pending_chunks.clear()
        streamed_chars += len(text)
        await ctx.report_progress(
            progress=streamed_chars,
            message=text,
        )

    async def emit_text(text: str) -> None:
        pending_chunks.append(text)
        buffered = "".join(pending_chunks)
        if len(buffered) >= 24 or "\n" in buffered:
            await flush_text()

    payload = await generate_stage_plan_stream(
        stage=stage,
        injury_text=injury_text,
        image_paths=image_paths,
        max_images=max_images,
        on_text=emit_text,
    )
    await flush_text()
    payload["tool"] = "med_trauma_stage_plan"
    return json.dumps(payload, ensure_ascii=False, indent=2)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
