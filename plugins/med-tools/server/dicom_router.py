"""Local, read-only DICOM routing.

The router deliberately reads metadata only.  It does not decode pixels, call a
model, or upload an examination.  Its output is a conservative recommendation
for the existing MedPilotDeck skills; the caller still has to load the selected
skill and obtain any authorization required by that workflow.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


_DICOM_SUFFIXES = {".dcm", ".dicom", ".ima"}
_MAX_CANDIDATE_BYTES = 256 * 1024 * 1024

_REGION_KEYWORDS: Dict[str, Tuple[str, ...]] = {
    "chest": (
        "CHEST",
        "THORAX",
        "LUNG",
        "PULMON",
        "BRONCH",
        "PLEURA",
        "MEDIAST",
        "CARDIAC",
        "CORONARY",
        "HEART",
        "胸",
        "肺",
        "心脏",
        "冠脉",
        "气道",
        "支气管",
        "胸膜",
    ),
    "abdomen": (
        "ABDOMEN",
        "ABDOMINAL",
        "LIVER",
        "HEPATIC",
        "KIDNEY",
        "RENAL",
        "PANCREAS",
        "SPLEEN",
        "腹",
        "肝",
        "肾",
        "胰",
        "脾",
    ),
    "pelvis": (
        "PELVIS",
        "PELVIC",
        "PROSTATE",
        "UTERUS",
        "OVARY",
        "骨盆",
        "盆腔",
        "前列腺",
        "子宫",
        "卵巢",
    ),
    "head": (
        "HEAD",
        "BRAIN",
        "CRANI",
        "脑",
        "颅",
    ),
    "neck": ("NECK", "CERVICAL", "颈"),
    "spine": ("SPINE", "SPINAL", "VERTEBR", "脊柱", "腰椎", "胸椎", "颈椎"),
    "extremity": (
        "EXTREM",
        "ARM",
        "LEG",
        "HAND",
        "FOOT",
        "SHOULDER",
        "KNEE",
        "ANKLE",
        "肢",
        "手",
        "足",
        "肩",
        "膝",
        "踝",
    ),
}

_CONTRAST_KEYWORDS = (
    "CONTRAST",
    "ENHANCE",
    "增强",
    "造影",
    "动脉期",
    "静脉期",
    "门静脉",
    "ARTERIAL",
    "VENOUS",
    "PORTAL",
)
_NONCONTRAST_KEYWORDS = ("NONCONTRAST", "NON-CONTRAST", "PLAIN", "平扫", "无增强")


def _value(dataset: Any, name: str) -> Any:
    try:
        value = getattr(dataset, name, None)
    except Exception:
        return None
    if value in (None, ""):
        return None
    return value


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _int(value: Any) -> Optional[int]:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result if result > 0 else None


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return str(value)


def _candidate_files(root: Path, max_files: int) -> Tuple[List[Path], int]:
    if root.is_file():
        return [root], 1
    if not root.is_dir():
        return [], 0
    all_files: List[Path] = []
    for child in sorted(root.rglob("*")):
        if not child.is_file() or child.name.startswith("."):
            continue
        if ".med-tools-derived" in child.parts or child.name == "derived":
            continue
        try:
            if child.stat().st_size > _MAX_CANDIDATE_BYTES:
                continue
        except OSError:
            continue
        all_files.append(child)
    # DICOM extensions are common, but extensionless DICOM exports are also
    # valid.  Keep the full count for a useful truncation warning.
    preferred = [p for p in all_files if p.suffix.lower() in _DICOM_SUFFIXES]
    extensionless = [p for p in all_files if not p.suffix]
    other = [p for p in all_files if p.suffix and p.suffix.lower() not in _DICOM_SUFFIXES]
    ordered = preferred + extensionless + other
    return ordered[: max(1, int(max_files))], len(ordered)


def _read_header(path: Path) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    try:
        import pydicom  # type: ignore
    except ImportError:
        return None, "missing pydicom"

    dataset = None
    error = ""
    try:
        dataset = pydicom.dcmread(str(path), stop_before_pixels=True, force=False)
    except Exception as exc:
        error = f"{type(exc).__name__}: {str(exc)[:160]}"
        # A number of PACS exports omit the Part 10 preamble.  Only accept the
        # force=True result when it contains unmistakable DICOM identifiers.
        try:
            dataset = pydicom.dcmread(str(path), stop_before_pixels=True, force=True)
        except Exception:
            return None, error

    modality = _text(_value(dataset, "Modality")).upper()
    sop_class = _text(_value(dataset, "SOPClassUID"))
    if not modality and not sop_class:
        return None, error or "no DICOM identifiers"

    fields = (
        "Modality",
        "BodyPartExamined",
        "StudyDescription",
        "SeriesDescription",
        "ProtocolName",
        "StudyInstanceUID",
        "SeriesInstanceUID",
        "SOPInstanceUID",
        "SOPClassUID",
        "NumberOfFrames",
        "InstanceNumber",
        "Rows",
        "Columns",
        "ImageType",
        "ContrastBolusAgent",
        "ContrastBolusVolume",
        "ContrastBolusRoute",
        "SeriesNumber",
    )
    metadata = {field: _json_value(_value(dataset, field)) for field in fields}
    metadata = {key: value for key, value in metadata.items() if value not in (None, "")}
    try:
        image_position = _value(dataset, "ImagePositionPatient")
        if image_position is not None:
            metadata["ImagePositionPatient"] = _json_value(image_position)
    except Exception:
        pass
    return metadata, None


def _evidence_text(metadata: Dict[str, Any]) -> str:
    return " ".join(
        _text(metadata.get(name))
        for name in ("BodyPartExamined", "StudyDescription", "SeriesDescription", "ProtocolName")
    ).upper()


def _region_scores(rows: Iterable[Dict[str, Any]]) -> Counter[str]:
    scores: Counter[str] = Counter()
    for row in rows:
        text = _evidence_text(row)
        body = _text(row.get("BodyPartExamined")).upper()
        for region, keywords in _REGION_KEYWORDS.items():
            for keyword in keywords:
                if keyword.upper() in text:
                    # BodyPartExamined is the strongest structured clue.
                    scores[region] += 3 if keyword.upper() in body else 1
    return scores


def _body_region(rows: List[Dict[str, Any]]) -> Tuple[str, str, float, List[str]]:
    scores = _region_scores(rows)
    if not scores:
        return "unknown", "low", 0.0, []
    ordered = scores.most_common()
    best_region, best_score = ordered[0]
    second_score = ordered[1][1] if len(ordered) > 1 else 0
    if len(ordered) > 1 and best_score == second_score:
        if {best_region, ordered[1][0]} == {"abdomen", "pelvis"}:
            return "abdomen_pelvis", "high", 0.82, []
        return "mixed", "low", 0.25, [f"部位证据冲突：{', '.join(region for region, _ in ordered[:4])}"]
    total = sum(scores.values())
    ratio = best_score / total if total else 0.0
    if ratio >= 0.75 and best_score >= 3:
        confidence, numeric = "high", min(0.99, 0.65 + ratio * 0.34)
    elif best_score >= 2:
        confidence, numeric = "medium", min(0.79, 0.45 + ratio * 0.30)
    else:
        confidence, numeric = "low", 0.35
    return best_region, confidence, round(numeric, 2), []


def _contrast_hint(rows: Iterable[Dict[str, Any]]) -> str:
    text = " ".join(_evidence_text(row) for row in rows)
    if any(_text(row.get("ContrastBolusAgent")) or _text(row.get("ContrastBolusVolume")) for row in rows):
        return "contrast"
    if any(keyword.upper() in text for keyword in _CONTRAST_KEYWORDS):
        return "contrast"
    if any(keyword.upper() in text for keyword in _NONCONTRAST_KEYWORDS):
        return "noncontrast"
    return "unknown"


def _is_complete_3d(rows: List[Dict[str, Any]]) -> Tuple[bool, int, List[str]]:
    warnings: List[str] = []
    if not rows:
        return False, 0, warnings
    frame_counts = [_int(row.get("NumberOfFrames")) or 1 for row in rows]
    total_frames = sum(frame_counts)
    if total_frames > 1 and any(((_int(row.get("NumberOfFrames")) or 1) > 1) for row in rows):
        return True, total_frames, warnings
    instances = {
        _text(row.get("SOPInstanceUID")) or _text(row.get("InstanceNumber"))
        for row in rows
    }
    instances.discard("")
    if len(instances) >= 3:
        return True, len(instances), warnings
    warnings.append("CT 序列少于 3 个可识别实例，不能确认是完整三维序列")
    return False, len(instances), warnings


def _series_key(row: Dict[str, Any], index: int) -> str:
    return _text(row.get("SeriesInstanceUID")) or f"series-{index}"


def route_dicom(path: str | Path, *, max_files: int = 512) -> Dict[str, Any]:
    """Inspect a DICOM file/series and return a conservative skill route."""

    root = Path(path).expanduser()
    if not root.is_absolute():
        root = (Path.cwd() / root).resolve()
    else:
        root = root.resolve()
    payload: Dict[str, Any] = {
        "tool": "med_dicom_route",
        "status": "error",
        "path": str(root),
        "modality": "UNKNOWN",
        "modalities": [],
        "body_region": "unknown",
        "body_region_confidence": "low",
        "body_region_confidence_score": 0.0,
        "contrast_hint": "unknown",
        "is_complete_3d_series": False,
        "frame_count": 0,
        "series_count": 0,
        "dicom_file_count": 0,
        "non_dicom_file_count": 0,
        "candidate_skills": ["med-medical"],
        "recommended_skill": "med-medical",
        "recommended_tool": "mcp__med-tools__med_parse_medical",
        "requires_main_agent_synthesis": False,
        "route_mode": "general-medical",
        "specialized_support": "not-applicable",
        "next_action": "使用 med-medical 进行通用医学附件解析；不要调用专用 CT 模型。",
        "authorization_required": False,
        "domain_flags": [],
        "series": [],
        "warnings": [],
    }
    if not root.exists():
        payload["warnings"] = [f"路径不存在：{root}"]
        return payload

    candidates, discovered_count = _candidate_files(root, max_files)
    if not candidates:
        payload["status"] = "degraded"
        payload["warnings"] = ["路径中没有可检查的文件；请使用 med-medical 处理该附件。"]
        return payload
    if discovered_count > len(candidates):
        payload["warnings"].append(
            f"共发现 {discovered_count} 个文件，本次仅检查前 {len(candidates)} 个；请拆分目录或提高 max_files。"
        )

    rows: List[Dict[str, Any]] = []
    read_errors: List[str] = []
    for candidate in candidates:
        metadata, error = _read_header(candidate)
        if metadata is None:
            if error and candidate.suffix.lower() in _DICOM_SUFFIXES:
                read_errors.append(f"{candidate.name}: {error}")
            continue
        metadata["path"] = str(candidate)
        rows.append(metadata)

    payload["dicom_file_count"] = len(rows)
    payload["non_dicom_file_count"] = max(0, len(candidates) - len(rows))
    if not rows:
        payload["status"] = "degraded"
        payload["warnings"].append("未识别到 DICOM 元数据；这可能不是 DICOM，已回退到 med-medical。")
        if read_errors:
            payload["warnings"].extend(read_errors[:5])
        return payload

    modalities = sorted({_text(row.get("Modality")).upper() or "UNKNOWN" for row in rows})
    payload["modalities"] = modalities
    if len(modalities) == 1:
        payload["modality"] = modalities[0]
    elif modalities:
        payload["modality"] = "MIXED"
        payload["warnings"].append(f"目录包含多个模态：{', '.join(modalities)}。只对 CT 序列生成专用候选。")

    grouped: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for index, row in enumerate(rows, start=1):
        grouped[_series_key(row, index)].append(row)
    payload["series_count"] = len(grouped)
    all_region_rows = [row for row in rows if _text(row.get("Modality")).upper() == "CT"] or rows
    region, confidence, confidence_score, region_warnings = _body_region(all_region_rows)
    payload["body_region"] = region
    payload["body_region_confidence"] = confidence
    payload["body_region_confidence_score"] = confidence_score
    payload["warnings"].extend(region_warnings)

    series_output: List[Dict[str, Any]] = []
    complete_ct = False
    for key, series_rows in grouped.items():
        modality = _text(series_rows[0].get("Modality")).upper() or "UNKNOWN"
        complete, instance_count, series_warnings = _is_complete_3d(series_rows)
        if modality == "CT":
            complete_ct = complete_ct or complete
        series_region, series_confidence, _, _ = _body_region(series_rows)
        series_output.append(
            {
                "series_instance_uid": _text(series_rows[0].get("SeriesInstanceUID")) or None,
                "modality": modality,
                "file_count": len(series_rows),
                "instance_count": instance_count,
                "is_complete_3d_series": complete,
                "body_region": series_region,
                "body_region_confidence": series_confidence,
                "contrast_hint": _contrast_hint(series_rows),
                "warnings": series_warnings,
            }
        )
    payload["series"] = series_output
    payload["is_complete_3d_series"] = complete_ct
    payload["frame_count"] = sum(int(item["instance_count"]) for item in series_output)
    payload["contrast_hint"] = _contrast_hint(all_region_rows)
    if payload["modality"] == "CT" and complete_ct:
        if region in {"abdomen", "pelvis", "abdomen_pelvis"}:
            payload["candidate_skills"] = ["med-radar-ct", "med-medical"]
            payload["recommended_skill"] = "med-radar-ct"
            payload["recommended_tool"] = "mcp__med-tools__med_radar_analyze_ct"
            payload["requires_main_agent_synthesis"] = True
            payload["route_mode"] = "radar"
            payload["specialized_support"] = "full"
            payload["authorization_required"] = False
            if payload["contrast_hint"] != "contrast":
                payload["domain_flags"].append(
                    "未确认增强期；RADAR 主要面向增强腹部 CT，结果必须按域外或阶段未知信号复核。"
                )
            payload["next_action"] = (
                "加载 med-radar-ct 并调用 med_radar_analyze_ct；"
                "完成后由主智能体结合 RADAR 结果回答用户原始问题。"
            )
        elif region not in {"unknown", "mixed"}:
            payload["candidate_skills"] = ["med-deepchest-3dmedagent", "med-medical"]
            payload["recommended_skill"] = "med-deepchest-3dmedagent"
            payload["recommended_tool"] = "mcp__med-tools__med_deepchest_submit" if region == "chest" else None
            payload["requires_main_agent_synthesis"] = True
            payload["route_mode"] = "3dmedagent"
            payload["specialized_support"] = "full" if region == "chest" else "compatibility-check"
            payload["authorization_required"] = False
            if region != "chest":
                payload["domain_flags"].append(
                    "当前 3DMedAgent 的器官 mask 与 CT-CLIP 词表主要覆盖胸腹部；"
                    "该非腹部、非胸部 CT 必须先做兼容性检查，不得伪造不受支持的 3D 证据。"
                )
            payload["next_action"] = (
                "加载 med-deepchest-3dmedagent 并按其非腹部 CT 流程执行；"
                "胸部运行完整 3DMedAgent，其他部位先检查器官与产物兼容性，"
                "完成或降级后由主智能体回答用户原始问题。"
            )
        else:
            payload["warnings"].append(
                "检查部位不确定；完整 CT 仍不能安全选择 RADAR 或 3DMedAgent，"
                "请用户确认后再选择专用 Skill。"
            )
    else:
        if payload["modality"] != "CT":
            payload["warnings"].append("当前附件不是单一 CT；不调用 RADAR 或 DeepChest 专用流程。")
        elif not complete_ct:
            payload["warnings"].append("当前 CT 不是已确认的完整三维序列；不调用专用 CT 流程。")
        if region == "unknown" or region == "mixed":
            payload["warnings"].append("检查部位不确定；请用户确认后再选择专用 Skill。")

    if read_errors:
        payload["warnings"].extend(read_errors[:5])
    payload["status"] = "ready" if not payload["warnings"] else "degraded"
    return payload
