"""PilotDeck MCP server: unified medical parse + local G9-V-Med (27B)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from mcp.server.fastmcp import FastMCP

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
        "For war-trauma care assistance: the main model first describes injuries "
        "(especially from images), then call med_trauma_rag_query for evidence, "
        "then the main model writes the care plan from returned chunks "
        "(tools never generate the final care plan)."
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


def _run_medical_parse(
    *,
    path: str,
    max_items: int = 64,
    max_frames: int = 8,
    skip_vlm: bool = False,
    tool_name: str = "med_parse_medical",
) -> Dict[str, Any]:
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
        return payload

    if not combined_summary.strip() and not unique_pngs:
        payload["vlm_error"] = "parse failed; skipped VLM"
        return payload

    vlm = analyze_medical_with_vlm(
        system_prompt=_load_prompt(prefer_medical=True),
        summary=combined_summary,
        png_paths=unique_pngs,
        max_images=max(1, min(max(len(unique_pngs), 1), max_frames * max(1, len(items)))),
        require_images=False,
    )
    payload["vlm_ok"] = bool(vlm.get("ok"))
    payload["vlm_error"] = str(vlm.get("error") or "")
    payload["report"] = str(vlm.get("report") or "")
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


@mcp.tool()
def med_parse_medical(
    path: str,
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

    Args:
        path: Absolute or relative path to a medical file or folder.
        max_items: Max files to parse from a directory (default 64, max 64).
        max_frames: Max DICOM frames / images per file for VLM (default 8).
        skip_vlm: If true, only parse; do not call the 27B model.
    """
    payload = _run_medical_parse(
        path=path,
        max_items=max_items,
        max_frames=max_frames,
        skip_vlm=skip_vlm,
        tool_name="med_parse_medical",
    )
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
    """Report war-trauma RAG corpus readiness (rows, dimension, mode hints).

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
    """Retrieve war-trauma textbook evidence chunks for the main agent.

    Returns evidence only (`chunks` + sources). The PilotDeck main model must
    write the care plan. Prefer this after describing an injury image in text,
    or directly when the user already provided a clear text query.

    Args:
        query: Chinese/English search text (injury description or keywords).
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


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
