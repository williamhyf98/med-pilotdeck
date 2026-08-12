"""Call local G9-V-Med (OpenAI-compatible) for medical multimodal reports.

When the primary medical VLM is down, optionally fall back to the main agent
model (GPT-5.5 by default) so medical tasks still produce a report.
"""

from __future__ import annotations

import base64
import mimetypes
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx


DEFAULT_API_BASE = "http://127.0.0.1:8030/v1"
DEFAULT_MODEL = "G9-V-Med"
DEFAULT_FALLBACK_API_BASE = "https://llm-center.modelbest.co/llm/v1"
DEFAULT_FALLBACK_MODEL = "gpt-5.5"


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def _truthy(name: str, default: str = "1") -> bool:
    return _env(name, default).lower() in {"1", "true", "yes", "on"}


def get_vlm_config() -> Dict[str, str]:
    return {
        "api_base": _env("MED_VLM_API_BASE", DEFAULT_API_BASE).rstrip("/"),
        "model": _env("MED_VLM_MODEL", DEFAULT_MODEL),
        "api_key": _env("MED_VLM_API_KEY", "EMPTY"),
        "fallback_enabled": "1" if _truthy("MED_VLM_FALLBACK_ENABLED", "1") else "0",
        "fallback_api_base": _env(
            "MED_VLM_FALLBACK_API_BASE", DEFAULT_FALLBACK_API_BASE
        ).rstrip("/"),
        "fallback_model": _env("MED_VLM_FALLBACK_MODEL", DEFAULT_FALLBACK_MODEL),
        "fallback_api_key": _env("MED_VLM_FALLBACK_API_KEY", ""),
    }


def get_fallback_vlm_config() -> Optional[Dict[str, str]]:
    cfg = get_vlm_config()
    if cfg["fallback_enabled"] != "1":
        return None
    api_key = cfg["fallback_api_key"]
    if not api_key:
        # Reuse primary key only when it looks like a real secret.
        primary = cfg["api_key"]
        if primary and primary.upper() not in {"EMPTY", "NONE", "NULL"}:
            api_key = primary
    if not api_key or not cfg["fallback_api_base"] or not cfg["fallback_model"]:
        return None
    return {
        "api_base": cfg["fallback_api_base"],
        "model": cfg["fallback_model"],
        "api_key": api_key,
    }


def _image_to_data_url(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    if not mime:
        mime = "image/png"
    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def build_medical_user_content(
    *,
    summary: str,
    png_paths: Optional[List[str]] = None,
    max_images: int = 8,
) -> List[Dict[str, Any]]:
    """Build OpenAI multimodal user content: text summary + optional images."""
    text = (
        f"{summary.strip()}\n\n"
        "请基于上述本地解析摘要"
        + ("与下方预览图像" if png_paths else "")
        + "，按系统提示的证据化卡片格式输出完整医学解读报告。"
        "内容需充分展开，覆盖【资料概况】【初步判断】【图像判读】【可见证据 / 文本要点】"
        "【推理依据】【可能情况 / 鉴别诊断】【风险提示】【下一步建议】，最后附免责声明。"
        "不要只给简短摘要。"
    )
    content: List[Dict[str, Any]] = [{"type": "text", "text": text}]
    for png in (png_paths or [])[: max(0, int(max_images))]:
        path = Path(png)
        if not path.is_file():
            continue
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": _image_to_data_url(path)},
            }
        )
    return content


def build_multimodal_user_content(
    *,
    summary: str,
    metadata: Dict[str, Any],
    png_paths: List[str],
    max_images: int = 8,
) -> List[Dict[str, Any]]:
    """Backward-compatible DICOM helper used by older call sites."""
    meta_lines = []
    for key in (
        "Modality",
        "BodyPartExamined",
        "StudyDescription",
        "SeriesDescription",
        "Rows",
        "Columns",
        "total_frames",
        "selected_frames",
        "selected_indices",
        "StudyDate",
        "Manufacturer",
        "ManufacturerModelName",
    ):
        if key in metadata and metadata[key] not in (None, ""):
            meta_lines.append(f"- {key}: {metadata[key]}")
    dicom_summary = (
        f"{summary}\n\n## DICOM 元数据\n"
        + ("\n".join(meta_lines) if meta_lines else "- （无）")
    )
    return build_medical_user_content(
        summary=dicom_summary,
        png_paths=png_paths,
        max_images=max_images,
    )


def _chat_completion(
    *,
    cfg: Dict[str, str],
    system_prompt: str,
    user_content: List[Dict[str, Any]],
    max_tokens: int,
    timeout_s: float,
    include_chat_template_kwargs: bool,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "stream": False,
        "temperature": 0.2,
        "max_tokens": max(512, max_tokens),
    }
    if include_chat_template_kwargs:
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    url = f"{cfg['api_base']}/chat/completions"
    with httpx.Client(timeout=timeout_s) as client:
        response = client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        return response.json()


def analyze_medical_with_vlm(
    *,
    system_prompt: str,
    summary: str,
    png_paths: Optional[List[str]] = None,
    max_images: int = 8,
    timeout_s: float = 180.0,
    require_images: bool = False,
) -> Dict[str, Any]:
    """Call G9-V-Med first; on failure optionally fall back to GPT-5.5."""
    cfg = get_vlm_config()
    paths = [p for p in (png_paths or []) if p]
    if require_images and not paths:
        return {
            "ok": False,
            "error": "没有可用的预览图像，无法调用视觉模型。",
            "model": cfg["model"],
            "api_base": cfg["api_base"],
            "fallback_used": False,
            "agent_continue": True,
            "report": "",
        }
    if not (summary or "").strip() and not paths:
        return {
            "ok": False,
            "error": "没有可用的摘要或图像，跳过 VLM。",
            "model": cfg["model"],
            "api_base": cfg["api_base"],
            "fallback_used": False,
            "agent_continue": True,
            "report": "",
        }

    user_content = build_medical_user_content(
        summary=summary or "（无文本摘要）",
        png_paths=paths,
        max_images=max_images,
    )
    if require_images and not any(part.get("type") == "image_url" for part in user_content):
        return {
            "ok": False,
            "error": "预览图像无法读取，无法调用视觉模型。",
            "model": cfg["model"],
            "api_base": cfg["api_base"],
            "fallback_used": False,
            "agent_continue": True,
            "report": "",
        }

    max_tokens = int(_env("MED_VLM_MAX_TOKENS", "8192"))
    primary_error = ""
    try:
        data = _chat_completion(
            cfg={
                "api_base": cfg["api_base"],
                "model": cfg["model"],
                "api_key": cfg["api_key"],
            },
            system_prompt=system_prompt,
            user_content=user_content,
            max_tokens=max_tokens,
            timeout_s=min(timeout_s, 30.0),
            include_chat_template_kwargs=True,
        )
        report = _extract_assistant_text(data)
        if report.strip():
            return {
                "ok": True,
                "error": "",
                "model": cfg["model"],
                "api_base": cfg["api_base"],
                "fallback_used": False,
                "agent_continue": False,
                "report": report,
                "usage": data.get("usage"),
            }
        primary_error = "主医疗模型返回空内容"
    except Exception as exc:
        primary_error = f"调用医疗视觉模型失败：{type(exc).__name__}: {exc}"

    fallback = get_fallback_vlm_config()
    if fallback is None:
        return {
            "ok": False,
            "error": primary_error,
            "model": cfg["model"],
            "api_base": cfg["api_base"],
            "fallback_used": False,
            "agent_continue": True,
            "report": "",
        }

    fallback_max_tokens = int(
        _env("MED_VLM_FALLBACK_MAX_TOKENS", _env("MED_VLM_MAX_TOKENS", "8192"))
    )
    try:
        data = _chat_completion(
            cfg=fallback,
            system_prompt=system_prompt,
            user_content=user_content,
            max_tokens=fallback_max_tokens,
            timeout_s=timeout_s,
            include_chat_template_kwargs=False,
        )
        report = _extract_assistant_text(data)
        if not report.strip():
            return {
                "ok": False,
                "error": (
                    f"{primary_error}；回退模型 {fallback['model']} 也返回空内容。"
                    "请主 Agent 根据 summary / png_paths 继续完成医学解读。"
                ),
                "model": fallback["model"],
                "api_base": fallback["api_base"],
                "primary_model": cfg["model"],
                "primary_error": primary_error,
                "fallback_used": True,
                "agent_continue": True,
                "report": "",
            }
        return {
            "ok": True,
            "error": "",
            "model": fallback["model"],
            "api_base": fallback["api_base"],
            "primary_model": cfg["model"],
            "primary_error": primary_error,
            "fallback_used": True,
            "agent_continue": False,
            "report": report,
            "usage": data.get("usage"),
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": (
                f"{primary_error}；回退模型也失败：{type(exc).__name__}: {exc}。"
                "请主 Agent 根据 summary / png_paths 继续完成医学解读。"
            ),
            "model": fallback["model"],
            "api_base": fallback["api_base"],
            "primary_model": cfg["model"],
            "primary_error": primary_error,
            "fallback_used": True,
            "agent_continue": True,
            "report": "",
        }


def analyze_dicom_with_vlm(
    *,
    system_prompt: str,
    summary: str,
    metadata: Dict[str, Any],
    png_paths: List[str],
    max_images: int = 8,
    timeout_s: float = 180.0,
) -> Dict[str, Any]:
    """DICOM-oriented wrapper (requires images)."""
    meta_lines = []
    for key, value in (metadata or {}).items():
        if value not in (None, ""):
            meta_lines.append(f"- {key}: {value}")
    dicom_summary = (
        f"{summary}\n\n## DICOM 元数据\n"
        + ("\n".join(meta_lines[:40]) if meta_lines else "- （无）")
    )
    return analyze_medical_with_vlm(
        system_prompt=system_prompt,
        summary=dicom_summary,
        png_paths=png_paths,
        max_images=max_images,
        timeout_s=timeout_s,
        require_images=True,
    )


def _extract_assistant_text(data: Dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        return ""
    message = (choices[0] or {}).get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(p for p in parts if p).strip()
    return str(content or "").strip()
