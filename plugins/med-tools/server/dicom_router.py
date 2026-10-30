"""Local, read-only medical imaging routing.

The router reads DICOM metadata or NIfTI headers only. It does not decode
volumes, call a model, or upload an examination.
"""

from __future__ import annotations

from collections import Counter, defaultdict
import gzip
import math
import os
from pathlib import Path
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple


_DICOM_SUFFIXES = {".dcm", ".dicom", ".ima"}
_MAX_CANDIDATE_BYTES = 256 * 1024 * 1024
SPECIALIZED_CT_ENABLED_ENV = "MED_SPECIALIZED_CT_ENABLED"


def specialized_ct_enabled() -> bool:
    """Return whether RADAR/DeepChest routing is explicitly enabled."""
    return os.environ.get(SPECIALIZED_CT_ENABLED_ENV, "") == "1"

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
        if not specialized_ct_enabled():
            payload["warnings"].append(
                "RADAR 和 DeepChest 专用流程当前暂时关闭，已回退到 med-medical。"
            )
            if region in {"unknown", "mixed"}:
                payload["warnings"].append("检查部位不确定；通用解析时注明此限制。")
            payload["next_action"] = (
                "使用 med-medical 进行本地医学附件解析；当前不调用 RADAR 或 DeepChest。"
            )
        elif region in {"abdomen", "pelvis", "abdomen_pelvis"}:
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
        elif region == "chest":
            payload["candidate_skills"] = ["med-deepchest-3dmedagent", "med-medical"]
            payload["recommended_skill"] = "med-deepchest-3dmedagent"
            payload["recommended_tool"] = "mcp__med-tools__med_deepchest_submit"
            payload["requires_main_agent_synthesis"] = True
            payload["route_mode"] = "3dmedagent"
            payload["specialized_support"] = "full"
            payload["authorization_required"] = False
            payload["next_action"] = (
                "加载 med-deepchest-3dmedagent 并对完整胸部 CT 执行 DeepChest；"
                "完成后由主智能体回答用户原始问题。"
            )
        elif region not in {"unknown", "mixed"}:
            payload["next_action"] = (
                "该部位 DICOM 不适用 RADAR 或 DeepChest；"
                "加载 med-medical 并调用 med_parse_medical 进行通用解析。"
            )
        else:
            payload["warnings"].append(
                "检查部位不确定；不能安全选择 RADAR 或 DeepChest，"
                "先使用 med-medical 做通用解析并注明此限制。"
            )
            payload["next_action"] = "加载 med-medical 并调用 med_parse_medical；不要提交专用 CT 模型。"
    else:
        if payload["modality"] != "CT":
            payload["warnings"].append("当前附件不是单一 CT；不调用 RADAR 或 DeepChest 专用流程。")
        elif not complete_ct:
            payload["warnings"].append("当前 CT 不是已确认的完整三维序列；不调用专用 CT 流程。")
        if region == "unknown" or region == "mixed":
            payload["warnings"].append("检查部位不确定；使用通用解析并注明此限制。")

    if read_errors:
        payload["warnings"].extend(read_errors[:5])
    payload["status"] = "ready" if not payload["warnings"] else "degraded"
    return payload


def _is_nifti(path: Path) -> bool:
    return bool(re.search(r"\.nii(?:\(\d+\))?\.gz$|\.nii$", path.name.lower()))


def _nifti_header(path: Path) -> Dict[str, Any]:
    import nibabel as nib
    import numpy as np

    try:
        if re.search(r"\.nii\(\d+\)\.gz$", path.name.lower()):
            with gzip.open(path, "rb") as handle:
                version_bytes = handle.read(4)
            header_sizes = {
                int.from_bytes(version_bytes, "little"),
                int.from_bytes(version_bytes, "big"),
            }
            version = (
                nib.Nifti1Image if 348 in header_sizes
                else nib.Nifti2Image if 540 in header_sizes
                else None
            )
            if version is None:
                raise ValueError("Invalid NIfTI header")
            file_map = version.make_file_map()
            file_map["image"].filename = str(path)
            image = version.from_file_map(file_map, mmap=False)
        else:
            image = nib.load(str(path), mmap=False)
    except nib.filebasedimages.ImageFileError as exc:
        raise ValueError("Invalid NIfTI header") from exc
    shape = tuple(int(size) for size in image.shape)
    affine = np.asarray(image.affine, dtype=np.float64)
    dtype = np.dtype(image.get_data_dtype())
    zooms = image.header.get_zooms()[:3]
    if (
        len(shape) != 3
        or min(shape) < 3
        or math.prod(shape) > 256 * 1024**2
        or dtype.kind not in "iuf"
        or affine.shape != (4, 4)
        or not np.isfinite(affine).all()
        or abs(float(np.linalg.det(affine[:3, :3]))) < 1e-8
        or len(zooms) != 3
        or any(not math.isfinite(float(z)) or float(z) <= 0 for z in zooms)
    ):
        raise ValueError("NIfTI must be a finite numeric 3D volume with valid geometry")
    linear = affine[:3, :3]
    normalized = np.abs(linear / np.linalg.norm(linear, axis=0))
    diagonal = np.diag(linear)
    return {
        "shape": list(shape),
        "dtype": str(dtype),
        "spacing_mm": [float(z) for z in zooms],
        "radar_spacing_mm": [float(abs(value)) for value in diagonal],
        "file_bytes": path.stat().st_size,
        "axis_aligned": bool(np.allclose(normalized.max(axis=0), 1, atol=1e-4)),
        "radar_axis_aligned": bool(
            np.all(np.abs(diagonal) >= 1e-6)
            and np.all(
                np.abs(linear - np.diag(diagonal))
                <= max(1e-5, float(np.max(np.abs(linear))) * 1e-3)
            )
        ),
    }


def route_image(
    path: str | Path,
    *,
    max_files: int = 512,
    modality: str = "",
    body_region: str = "",
    intensity_units: str = "",
    requested_model: str = "",
) -> Dict[str, Any]:
    """Route DICOM or NIfTI using header evidence and explicitly supplied context."""
    root = Path(path).expanduser().resolve()
    result: Dict[str, Any] = {
        "tool": "med_image_route",
        "path": str(root),
        "format": "nifti",
        "status": "degraded",
        "modality": "UNKNOWN",
        "body_region": "unknown",
        "contrast_hint": "unknown",
        "is_complete_3d_series": None,
        "is_3d_volume": False,
        "volumes": [],
        "candidate_skills": [],
        "recommended_skill": None,
        "recommended_tool": None,
        "requires_main_agent_synthesis": False,
        "route_mode": "needs-context",
        "specialized_support": "not-applicable",
        "authorization_required": False,
        "domain_flags": [],
        "required_context": [],
        "warnings": [],
        "next_action": "",
    }
    if not root.exists():
        if _is_nifti(root):
            result["status"] = "error"
            result["route_mode"] = "invalid-input"
            result["warnings"].append("NIfTI 路径不存在。")
            result["next_action"] = "请确认文件路径，不要调用 med_parse_medical。"
            return result
        result = route_dicom(root, max_files=max_files)
        result["tool"] = "med_image_route"
        return result

    if root.is_file():
        nifti = [root] if _is_nifti(root) else []
        other = [] if nifti else [root]
    elif root.is_dir():
        # NIfTI volumes can exceed the DICOM header reader's 256 MiB limit.
        # Detect them separately before applying that DICOM-specific filter.
        nifti, other = [], []
        for file in root.rglob("*"):
            relative = file.relative_to(root)
            if any(part.startswith(".") or part == "derived" for part in relative.parts):
                continue
            if not file.is_file():
                continue
            (nifti if _is_nifti(file) else other).append(file)
            if len(nifti) > 1 or (nifti and other):
                break
    else:
        nifti, other = [], []
    if not nifti:
        result = route_dicom(root, max_files=max_files)
        result["tool"] = "med_image_route"
        if requested_model.strip().lower() == "deepchest" and specialized_ct_enabled():
            if result["recommended_tool"] != "mcp__med-tools__med_deepchest_submit":
                result["warnings"].append("该 DICOM 检查不能提交给 DeepChest；按检查部位选择适用流程。")
                if result["recommended_skill"] == "med-medical":
                    result["next_action"] = "DeepChest 仅支持完整胸部 CT；加载 med-medical 并调用 med_parse_medical。"
                result["status"] = "degraded"
            return result
        if requested_model.strip().lower() == "radar" and specialized_ct_enabled() and result["recommended_skill"] != "med-radar-ct":
            result["warnings"].append("该 DICOM 检查不属于完整腹部/盆腔 CT，不能提交给 RADAR。")
            if result["recommended_skill"] == "med-medical":
                result["next_action"] = "加载 med-medical 并调用 med_parse_medical；不提交给 RADAR。"
            result["status"] = "degraded"
        return result

    result["format"] = "nifti" if not other else "mixed"
    if other or (root.is_dir() and len(nifti) > 1):
        result["route_mode"] = "ambiguous-input"
        result["warnings"].append("目录包含多个影像或不同格式；请先选择单个 NIfTI 文件。")
        result["next_action"] = "请用户选择本轮要分析的一份影像，不自动提交专用模型。"
        return result

    volume = nifti[0]
    try:
        result["volumes"] = [{"path": str(volume), **_nifti_header(volume)}]
    except (OSError, ValueError, ImportError) as exc:
        result["route_mode"] = "invalid-input"
        result["warnings"].append(f"NIfTI 文件头或三维几何无效：{type(exc).__name__}")
        result["next_action"] = "请用户提供有效的三维影像文件。"
        return result
    result["is_3d_volume"] = True
    volume_info = result["volumes"][0]

    modality = modality.strip().upper()
    region = body_region.strip().lower()
    units = intensity_units.strip().upper()
    model = requested_model.strip().lower()
    if (
        modality not in {"", "CT", "MR", "OTHER"}
        or region not in {"", "abdomen", "pelvis", "abdomen_pelvis", "chest", "head", "neck", "spine", "extremity", "other"}
        or units not in {"", "HU", "UNKNOWN", "OTHER"}
        or model not in {"", "radar", "deepchest"}
    ):
        result["route_mode"] = "invalid-context"
        result["warnings"].append("检查信息不在允许值范围内；请核对用户提供的模态、部位和模型名称。")
        result["next_action"] = "请核对检查信息后重新预检；不要直接提交模型。"
        return result
    result["modality"] = modality or "UNKNOWN"
    result["body_region"] = region or "unknown"

    if not specialized_ct_enabled():
        result["route_mode"] = "disabled"
        result["warnings"].append("专用 CT 能力未启用；通用解析器也不支持 NIfTI。")
        result["next_action"] = "请告知用户当前无法解析 NIfTI，不要调用 med_parse_medical。"
        return result
    if modality != "CT":
        if modality:
            result["route_mode"] = "incompatible"
            result["next_action"] = "已确认不是 CT，不能提交给 RADAR 或 DeepChest。"
        else:
            result["required_context"].append("modality")
            if not model and not region:
                result["required_context"].append("body_region")
            result["next_action"] = "请用户确认检查模态和部位；不能从 NIfTI 文件头推断是 CT。"
        return result
    if model == "deepchest" and region != "chest":
        if region:
            result["route_mode"] = "incompatible"
            result["next_action"] = "已确认不是胸部 CT，不能提交给 DeepChest。"
        else:
            result["required_context"].append("body_region")
            result["next_action"] = "DeepChest 仅支持胸部 CT；请用户确认检查部位。"
        return result
    if model == "radar" or (not model and region in {"abdomen", "pelvis", "abdomen_pelvis"}):
        shape = volume_info["shape"]
        spacing = volume_info["radar_spacing_mm"]
        if not volume_info["radar_axis_aligned"] or min(
            int(shape[0] * spacing[1]),
            int(shape[1] * spacing[0]),
            int(shape[2] * spacing[2] / 5),
        ) <= 0:
            result["route_mode"] = "incompatible"
            result["warnings"].append("RADAR 不支持当前 NIfTI 的轴置换、斜切几何或重采样后的空维度。")
            result["next_action"] = "请提供经校验、与轴对齐且具有足够切片的 CT 体数据。"
            return result
        result.update(
            candidate_skills=["med-radar-ct"],
            recommended_skill="med-radar-ct",
            recommended_tool="mcp__med-tools__med_radar_analyze_ct",
            route_mode="radar",
            specialized_support="full" if region in {"abdomen", "pelvis", "abdomen_pelvis"} else "domain-unverified",
            requires_main_agent_synthesis=True,
            next_action="加载 med-radar-ct，检查服务后提交该 NIfTI；按适用范围解释结果。",
        )
        if region not in {"abdomen", "pelvis", "abdomen_pelvis"}:
            result["domain_flags"].append("检查部位不是已确认的腹部/盆腔 CT；RADAR 结果存在域偏移风险。")
        result["domain_flags"].append("NIfTI 无法确认增强期；RADAR 结果需结合原始检查信息复核。")
    elif region == "chest":
        if (
            min(volume_info["shape"]) < 16
            or not volume_info["axis_aligned"]
            or volume_info["file_bytes"] > 2 * 1024**3
        ):
            result["route_mode"] = "incompatible"
            result["warnings"].append("DeepChest 要求各维至少 16 个体素、非斜切几何且文件不超过 2 GiB。")
            result["next_action"] = "请提供符合 DeepChest 输入要求的完整胸部 CT；不要直接提交。"
            return result
        if units == "OTHER":
            result["route_mode"] = "incompatible"
            result["next_action"] = "已确认体素单位不是 HU，不能提交 DeepChest。"
            return result
        if units != "HU":
            result["required_context"].append("intensity_units")
            result["next_action"] = "请用户确认胸部 CT 体素单位为 HU，之后才能提交 DeepChest。"
            return result
        result.update(
            candidate_skills=["med-deepchest-3dmedagent"],
            recommended_skill="med-deepchest-3dmedagent",
            recommended_tool="mcp__med-tools__med_deepchest_submit",
            route_mode="deepchest",
            specialized_support="full",
            next_action="加载 med-deepchest-3dmedagent，检查服务并提交本轮胸部 CT。",
        )
    else:
        if not region:
            result["required_context"].append("body_region")
        result["next_action"] = "请用户确认检查部位；当前没有适合该部位的 NIfTI 专用流程。"
        return result
    result["status"] = "ready" if not result["domain_flags"] else "degraded"
    return result
