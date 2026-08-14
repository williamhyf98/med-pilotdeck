"""Six-stage war-trauma graded-care plan via G9-V-Med (+ GPT fallback)."""

from __future__ import annotations

from pathlib import Path
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Tuple, Union

from .vlm_client import chat_vlm, chat_vlm_stream

STAGES: Tuple[str, ...] = (
    "伤员发生地",
    "野战分类场",
    "收容处置组",
    "重伤救治组",
    "手术组",
    "洗消组",
)

STAGE_TASKS: Dict[str, str] = {
    "伤员发生地": (
        "请结合当前战现场条件，判断伤情和即时风险，"
        "给出现场急救处置、伤标/后送建议和安全禁忌。"
    ),
    "野战分类场": (
        "请复核前序处置，判断当前伤情优先级，"
        "给出分类、伤标、分流去向、后送或进一步处置建议。"
    ),
    "收容处置组": (
        "请根据当前伤情和已有交接信息，复查伤情，"
        "判断需要完善的检查、处置方向、分流去向和安全注意事项。"
    ),
    "重伤救治组": (
        "请围绕当前重伤救治阶段，识别危及生命的问题，"
        "给出复苏、监测、进一步检查、手术或后送决策。"
    ),
    "手术组": (
        "请根据当前手术阶段，给出围手术期评估、手术处置重点、"
        "术中支持、术后去向和交接建议。"
    ),
    "洗消组": (
        "请针对疑似污染/洗消场景，给出人员防护、污染控制、"
        "伤员处置、复测分流与安全注意事项。"
    ),
}

# Soft aliases → canonical stage name
_STAGE_ALIASES: Dict[str, str] = {
    "发生地": "伤员发生地",
    "现场": "伤员发生地",
    "poi": "伤员发生地",
    "分类场": "野战分类场",
    "野战分类": "野战分类场",
    "triage": "野战分类场",
    "收容": "收容处置组",
    "收容组": "收容处置组",
    "重伤": "重伤救治组",
    "重伤组": "重伤救治组",
    "手术": "手术组",
    "手术室": "手术组",
    "洗消": "洗消组",
    "洗消场": "洗消组",
}

SYSTEM_PROMPT = (
    "你是一名严谨的战时分级救治军医，请按《战伤救治规则》与战创伤救治原则作答，"
    "分点、结构化、可执行。"
)

MULTI_IMAGE_APPENDIX = (
    "\n\n【逐图像判读要求】\n"
    "当前如果为多张图像输入。在“一、图像/影像判读”中，请把图像类型作为标题，"
    "并按顺序分别论述各图像详细所见与判断，"
    "标题需根据图像内容给出合适的名称（如「创面照片」「受伤环境图」「心电图」「X光」「CT」等）。\n"
    "每张图像的判读都应尽量完整：写清部位、伤类/伤型所见（如有），以及图像支持的详细判读\n"
    "分图像写完后，用一小段做综合判读（结合图像判读结果与伤情背景）。\n"
    "综合段不能代替各影像本身的分别判读。"
)

OUTPUT_FORMAT = (
    "必须严格使用下列五个中文序号标题（不要改成 Markdown 的 ## 标题，不要增删合并章节）：\n"
    "一、图像/影像判读\n"
    "二、本阶段处置措施\n"
    "三、伤情特异处置\n"
    "四、分类、伤标、后送/分流和交接记录\n"
    "五、安全禁忌和不得遗漏事项"
)

PRESENTATION = (
    "若 care_plan 非空：将 care_plan 字段原样展示给用户；不要改写、压缩、转述或重新组织。"
    "最多可在方案前后各加 1–2 句说明（阶段名/来源模型/是否回退）。"
    "若 care_plan 为空且 agent_continue=true：主 Agent 必须按五段固定格式自行补写方案，"
    "并明确说明 G9/回退均失败。"
)
_SECTION_TITLES = (
    "一、图像/影像判读",
    "二、本阶段处置措施",
    "三、伤情特异处置",
    "四、分类、伤标、后送/分流和交接记录",
    "五、安全禁忌和不得遗漏事项",
)
_SECTION_TITLE_ALIASES = {
    "图像/影像判读": _SECTION_TITLES[0],
    "图像影像判读": _SECTION_TITLES[0],
    "本阶段处置措施": _SECTION_TITLES[1],
    "本阶段救治机构的处置": _SECTION_TITLES[1],
    "伤情特异处置": _SECTION_TITLES[2],
    "伤情特异处置方案": _SECTION_TITLES[2],
    "特异性救治处置方案": _SECTION_TITLES[2],
    "分类、伤标、后送/分流和交接记录": _SECTION_TITLES[3],
    "分类、伤标、后送与交接": _SECTION_TITLES[3],
    "安全禁忌和不得遗漏事项": _SECTION_TITLES[4],
    "安全与禁忌": _SECTION_TITLES[4],
}
_MARKDOWN_HEADING_RE = re.compile(r"^(\s*)#{1,6}\s*")


def normalize_stage(stage: str) -> Optional[str]:
    raw = (stage or "").strip()
    if not raw:
        return None
    if raw in STAGE_TASKS:
        return raw
    lower = raw.lower()
    if lower in _STAGE_ALIASES:
        return _STAGE_ALIASES[lower]
    for name in STAGES:
        if name in raw or raw in name:
            return name
    alias = _STAGE_ALIASES.get(raw)
    if alias:
        return alias
    return None


def build_user_prompt(
    *,
    stage: str,
    injury_text: str,
    has_images: bool,
) -> str:
    injury = (injury_text or "").strip() or "（未提供文字伤情描述）"
    task = STAGE_TASKS[stage]
    image_block = (
        "请基于图像本身判读，不要用文字脑测补全图像结论。"
        if has_images
        else "本次无图像输入；第一节可根据文字伤情作有限推断，并标明未见影像。"
    )
    body = (
        f"你是一名战时分级救治军医，当前阶段为【{stage}】。\n"
        "请根据当前可见伤情，给出符合战时分级救治场景的判断和处置建议。\n"
        "【可见伤情】\n"
        f"{injury}\n"
        "【图像输入】\n"
        f"{image_block}\n"
        "【任务要求】\n"
        f"{task}\n"
        "【输出格式】\n"
        f"{OUTPUT_FORMAT}"
    )
    if has_images:
        body += MULTI_IMAGE_APPENDIX
    return body


def _normalize_image_paths(image_paths: Optional[Union[Sequence[str], str]]) -> List[str]:
    if image_paths is None:
        return []
    if isinstance(image_paths, str):
        text = image_paths.strip()
        if not text:
            return []
        if text.startswith("["):
            import json

            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    return [str(p).strip() for p in parsed if str(p).strip()]
            except Exception:  # noqa: BLE001
                pass
        parts: List[str] = []
        for line in text.replace(",", "\n").splitlines():
            p = line.strip().strip('"').strip("'")
            if p:
                parts.append(p)
        return parts
    return [str(p).strip() for p in image_paths if str(p).strip()]


def _sanitize_section_line(line: str) -> str:
    newline = "\n" if line.endswith("\n") else ""
    had_markdown_heading = bool(_MARKDOWN_HEADING_RE.match(line))
    cleaned = _MARKDOWN_HEADING_RE.sub(r"\1", line)
    stripped = cleaned.strip()
    if stripped.startswith("**") and stripped.endswith("**"):
        stripped = stripped[2:-2].strip()
    if stripped in _SECTION_TITLES:
        return stripped + newline
    normalized = _SECTION_TITLE_ALIASES.get(stripped)
    if normalized:
        return normalized + newline
    return line if had_markdown_heading else cleaned


def sanitize_care_plan(text: str) -> str:
    """Keep the required section titles plain even if the VLM emits Markdown."""
    return "".join(
        _sanitize_section_line(line)
        for line in (text or "").splitlines(keepends=True)
    ).strip()


def generate_stage_plan(
    *,
    stage: str,
    injury_text: str,
    image_paths: Optional[Union[Sequence[str], str]] = None,
    max_images: int = 8,
    timeout_s: float = 180.0,
) -> Dict[str, Any]:
    """Build prompts and call G9 (with GPT fallback). Returns JSON-serializable dict."""
    canonical = normalize_stage(stage)
    paths = [p for p in _normalize_image_paths(image_paths) if Path(p).is_file()]
    max_images = max(1, min(int(max_images or 8), 16))

    if canonical is None:
        return {
            "ok": False,
            "error": (
                f"无效阶段「{stage}」。允许："
                + " / ".join(STAGES)
            ),
            "stage": stage,
            "stages_allowed": list(STAGES),
            "care_plan": "",
            "agent_continue": False,
            "presentation": PRESENTATION,
            "fallback_used": False,
        }

    injury = (injury_text or "").strip()
    if not injury and not paths:
        return {
            "ok": False,
            "error": "需要 injury_text 和/或 image_paths 至少一项。",
            "stage": canonical,
            "care_plan": "",
            "agent_continue": False,
            "presentation": PRESENTATION,
            "fallback_used": False,
        }

    user_prompt = build_user_prompt(
        stage=canonical,
        injury_text=injury,
        has_images=bool(paths),
    )
    result = chat_vlm(
        system_prompt=SYSTEM_PROMPT,
        user_text=user_prompt,
        png_paths=paths,
        max_images=max_images,
        timeout_s=timeout_s,
        primary_timeout_s=120.0,
        require_images=False,
        empty_continue_hint=(
            "请主 Agent 按五段固定格式（图像判读/本阶段处置/特异处置/"
            "分类伤标后送交接/安全禁忌）继续写出救治方案。"
        ),
    )

    care_plan = sanitize_care_plan(result.get("report") or "")
    payload: Dict[str, Any] = {
        "ok": bool(result.get("ok")) and bool(care_plan),
        "error": result.get("error") or "",
        "stage": canonical,
        "injury_text": injury,
        "image_paths_used": paths[:max_images],
        "image_count": min(len(paths), max_images),
        "model": result.get("model"),
        "api_base": result.get("api_base"),
        "fallback_used": bool(result.get("fallback_used")),
        "agent_continue": bool(result.get("agent_continue")),
        "care_plan": care_plan,
        "presentation": PRESENTATION,
        "generation_owner": "plugin-vlm",
        "prompt_stage_task": STAGE_TASKS[canonical],
    }
    if result.get("primary_model"):
        payload["primary_model"] = result["primary_model"]
    if result.get("primary_error"):
        payload["primary_error"] = result["primary_error"]
    if result.get("usage") is not None:
        payload["usage"] = result["usage"]
    if care_plan and not payload["ok"] and not result.get("stream_interrupted"):
        payload["ok"] = True
        payload["error"] = ""
        payload["agent_continue"] = False
    return payload


async def generate_stage_plan_stream(
    *,
    stage: str,
    injury_text: str,
    on_text: Callable[[str], Awaitable[None]],
    image_paths: Optional[Union[Sequence[str], str]] = None,
    max_images: int = 8,
    timeout_s: float = 180.0,
) -> Dict[str, Any]:
    """Generate a stage plan while forwarding each G9 text delta."""
    canonical = normalize_stage(stage)
    paths = [p for p in _normalize_image_paths(image_paths) if Path(p).is_file()]
    max_images = max(1, min(int(max_images or 8), 16))

    if canonical is None:
        return {
            "ok": False,
            "error": f"无效阶段「{stage}」。允许：" + " / ".join(STAGES),
            "stage": stage,
            "stages_allowed": list(STAGES),
            "care_plan": "",
            "agent_continue": False,
            "presentation": PRESENTATION,
            "fallback_used": False,
        }

    injury = (injury_text or "").strip()
    if not injury and not paths:
        return {
            "ok": False,
            "error": "需要 injury_text 和/或 image_paths 至少一项。",
            "stage": canonical,
            "care_plan": "",
            "agent_continue": False,
            "presentation": PRESENTATION,
            "fallback_used": False,
        }

    pending_line = ""

    async def emit_sanitized(text: str) -> None:
        nonlocal pending_line
        pending_line += text
        while "\n" in pending_line:
            line, pending_line = pending_line.split("\n", 1)
            await on_text(_sanitize_section_line(line + "\n"))

    result = await chat_vlm_stream(
        system_prompt=SYSTEM_PROMPT,
        user_text=build_user_prompt(
            stage=canonical,
            injury_text=injury,
            has_images=bool(paths),
        ),
        on_text=emit_sanitized,
        png_paths=paths,
        max_images=max_images,
        timeout_s=timeout_s,
        primary_timeout_s=120.0,
        require_images=False,
        empty_continue_hint=(
            "请主 Agent 按五段固定格式（图像判读/本阶段处置/特异处置/"
            "分类伤标后送交接/安全禁忌）继续写出救治方案。"
        ),
    )
    if pending_line:
        await on_text(_sanitize_section_line(pending_line))

    care_plan = sanitize_care_plan(result.get("report") or "")
    payload: Dict[str, Any] = {
        "ok": bool(result.get("ok")) and bool(care_plan),
        "error": result.get("error") or "",
        "stage": canonical,
        "injury_text": injury,
        "image_paths_used": paths[:max_images],
        "image_count": min(len(paths), max_images),
        "model": result.get("model"),
        "api_base": result.get("api_base"),
        "fallback_used": bool(result.get("fallback_used")),
        "agent_continue": bool(result.get("agent_continue")),
        "care_plan": care_plan,
        "presentation": PRESENTATION,
        "generation_owner": "plugin-vlm",
        "prompt_stage_task": STAGE_TASKS[canonical],
        "streamed": bool(result.get("streamed")),
    }
    for key in (
        "primary_model",
        "primary_error",
        "usage",
        "stream_interrupted",
    ):
        if result.get(key) is not None:
            payload[key] = result[key]
    return payload
