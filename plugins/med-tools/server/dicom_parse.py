"""Lightweight single-file DICOM parser (dialogue-style).

Adapted from med-integration dialogue ingestion: metadata + uniform frame
sampling to PNG. Returns absolute PNG paths for downstream VLM calls.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class DicomParseResult:
    status: str
    summary: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    png_paths: List[str] = field(default_factory=list)
    selected_indices: List[int] = field(default_factory=list)


def parse_dicom_file(
    path: Path,
    *,
    derived_dir: Path,
    max_frames: int = 8,
    max_long_side: int = 1600,
) -> DicomParseResult:
    path = path.expanduser().resolve()
    if not path.is_file():
        return DicomParseResult(
            status="error",
            summary=f"文件不存在：{path}",
            warnings=[f"missing file: {path}"],
        )

    suffix = path.suffix.lower()
    if suffix not in {".dcm", ".dicom"} and suffix != "":
        # Allow extension-less DICOM; warn on unexpected suffixes.
        if suffix not in {".dcm", ".dicom"}:
            # still try to read; many DICOMs have no/odd extension
            pass

    try:
        import pydicom  # type: ignore
    except ImportError:
        return DicomParseResult(
            status="degraded",
            summary="DICOM 文件；当前环境缺少 pydicom，未读取元数据和像素。",
            warnings=["未安装 pydicom"],
        )

    artifact_id = f"dicom_{uuid.uuid4().hex[:12]}"
    warnings: List[str] = []
    try:
        dataset = pydicom.dcmread(str(path), force=True)
    except Exception as exc:
        return DicomParseResult(
            status="error",
            summary="DICOM 文件读取失败。",
            warnings=[f"pydicom 读取失败：{type(exc).__name__}: {str(exc)[:250]}"],
        )

    fields = (
        "Modality",
        "StudyDescription",
        "SeriesDescription",
        "BodyPartExamined",
        "StudyDate",
        "SeriesDate",
        "Manufacturer",
        "ManufacturerModelName",
        "Rows",
        "Columns",
        "NumberOfFrames",
        "PhotometricInterpretation",
        "StudyInstanceUID",
        "SeriesInstanceUID",
        "SOPInstanceUID",
    )
    metadata: Dict[str, Any] = {"source_path": str(path)}
    metadata_degraded = False
    for field_name in fields:
        try:
            value = getattr(dataset, field_name, None)
            if value not in (None, ""):
                metadata[field_name] = _jsonable(value)
        except Exception as exc:
            metadata_degraded = True
            warnings.append(
                f"DICOM 元数据字段 {field_name} 读取失败："
                f"{type(exc).__name__}: {str(exc)[:120]}"
            )

    declared_frames = _positive_int(metadata.get("NumberOfFrames")) or 1
    metadata.update(
        {
            "total_frames": declared_frames,
            "selected_frames": 0,
            "selected_indices": [],
        }
    )

    png_paths: List[str] = []
    selected_indices: List[int] = []
    render_degraded = False
    try:
        png_paths, total_frames, selected_indices, requested_indices, render_warnings = (
            _render_dicom_frames(
                dataset,
                artifact_id,
                derived_dir,
                max_frames=max_frames,
                max_long_side=max_long_side,
            )
        )
        metadata["total_frames"] = total_frames
        metadata["selected_frames"] = len(selected_indices)
        metadata["selected_indices"] = selected_indices
        metadata["max_image_long_side"] = max(256, int(max_long_side or 1600))
        warnings.extend(render_warnings)
        render_degraded = len(selected_indices) != len(requested_indices)
        if total_frames != declared_frames:
            warnings.append(
                "DICOM 声明帧数与解码数组不一致："
                f"NumberOfFrames={declared_frames}, total_frames={total_frames}"
            )
        if total_frames > max(1, int(max_frames)):
            warnings.append(
                "DICOM 多帧已按每文件预算均匀截断："
                f"total_frames={total_frames}, "
                f"selected_frames={len(selected_indices)}, "
                f"selected_indices={selected_indices}"
            )
    except Exception as exc:
        render_degraded = True
        warnings.append(
            "DICOM 像素解码/渲染失败："
            f"{type(exc).__name__}: {str(exc)[:250]}"
        )

    modality = str(metadata.get("Modality") or "UNKNOWN")
    dimensions = ""
    if metadata.get("Rows") and metadata.get("Columns"):
        dimensions = f"，{metadata['Columns']}×{metadata['Rows']}"
    frames = int(metadata.get("total_frames") or 0)
    selected_detail = (
        f"已生成 {len(png_paths)} 张预览图（帧索引 {selected_indices}）"
        if png_paths
        else "未生成可用预览图"
    )
    summary = (
        f"DICOM 医学影像：模态 {modality}{dimensions}，总帧数 {frames}；{selected_detail}。"
    )
    if metadata.get("SeriesDescription"):
        summary += f" 序列：{_cap(str(metadata['SeriesDescription']), 200)}。"

    status = (
        "ready"
        if png_paths and not render_degraded and not metadata_degraded
        else ("degraded" if png_paths or metadata.get("Modality") else "error")
    )
    return DicomParseResult(
        status=status,
        summary=summary,
        metadata=metadata,
        warnings=warnings,
        png_paths=png_paths,
        selected_indices=selected_indices,
    )


def _render_dicom_frames(
    dataset: Any,
    artifact_id: str,
    derived_dir: Path,
    *,
    max_frames: int,
    max_long_side: int = 1600,
) -> Tuple[List[str], int, List[int], List[int], List[str]]:
    import numpy as np  # type: ignore

    pixels = np.asarray(dataset.pixel_array)
    frames = _split_dicom_frames(pixels, dataset)
    total_frames = len(frames)
    requested_indices = _uniform_frame_indices(total_frames, max_frames)
    derived_dir.mkdir(parents=True, exist_ok=True)
    paths: List[str] = []
    selected_indices: List[int] = []
    warnings: List[str] = []
    for frame_index in requested_indices:
        try:
            image = _dicom_frame_to_image(
                frames[frame_index],
                dataset,
                max_long_side=max_long_side,
            )
            out_path = derived_dir / f"{artifact_id}_frame_{frame_index:06d}.png"
            image.save(out_path, format="PNG", optimize=True)
            paths.append(str(out_path.resolve()))
            selected_indices.append(frame_index)
        except Exception as exc:
            warnings.append(
                f"DICOM 第 {frame_index} 帧渲染失败："
                f"{type(exc).__name__}: {str(exc)[:200]}"
            )
    return paths, total_frames, selected_indices, requested_indices, warnings


def _split_dicom_frames(pixels: Any, dataset: Any) -> List[Any]:
    shape = tuple(int(item) for item in getattr(pixels, "shape", ()))
    samples_per_pixel = _positive_int(getattr(dataset, "SamplesPerPixel", None)) or 1
    if pixels.ndim == 2:
        return [pixels]
    if pixels.ndim == 3:
        if samples_per_pixel > 1:
            return [pixels]
        return [pixels[index] for index in range(shape[0])]
    if pixels.ndim == 4:
        if shape[-1] not in {3, 4} and shape[1] not in {3, 4}:
            raise ValueError(f"不支持的多帧彩色像素维度：{shape}")
        return [pixels[index] for index in range(shape[0])]
    raise ValueError(f"不支持的 DICOM 像素维度：{shape}")


def _uniform_frame_indices(total_frames: int, max_frames: int) -> List[int]:
    if total_frames <= 0:
        raise ValueError("DICOM 解码后没有像素帧")
    count = min(total_frames, max(1, int(max_frames)))
    if count == total_frames:
        return list(range(total_frames))
    if count == 1:
        return [0]
    denominator = count - 1
    return [
        (index * (total_frames - 1) + denominator // 2) // denominator
        for index in range(count)
    ]


def _dicom_frame_to_image(
    frame: Any,
    dataset: Any,
    *,
    max_long_side: int = 1600,
) -> Any:
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    array = np.asarray(frame)
    if array.ndim == 2:
        normalized = _percentile_uint8(array)
        if str(getattr(dataset, "PhotometricInterpretation", "")).upper() == "MONOCHROME1":
            normalized = 255 - normalized
        image = Image.fromarray(normalized).convert("RGB")
    elif array.ndim == 3:
        if array.shape[-1] in {3, 4}:
            color = array[..., :3]
        elif array.shape[0] in {3, 4}:
            color = np.moveaxis(array[:3], 0, -1)
        else:
            raise ValueError(f"不支持的彩色帧维度：{tuple(array.shape)}")
        if color.dtype == np.uint8 and np.isfinite(color).all():
            normalized = color
        else:
            normalized = _percentile_uint8(color)
        image = Image.fromarray(normalized)
    else:
        raise ValueError(f"不支持的单帧像素维度：{tuple(array.shape)}")

    side = max(256, int(max_long_side or 1600))
    image.thumbnail((side, side), Image.Resampling.LANCZOS)
    return image


def _percentile_uint8(array: Any) -> Any:
    import numpy as np  # type: ignore

    values = np.asarray(array).astype("float32")
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        raise ValueError("像素全部为非有限值")
    low, high = np.percentile(finite, [1, 99])
    low = float(low)
    high = float(high)
    if not math.isfinite(low) or not math.isfinite(high) or high <= low:
        low, high = float(finite.min()), float(finite.max())
    if high <= low:
        high = low + 1.0
    normalized = np.clip((values - low) / (high - low), 0.0, 1.0)
    normalized = np.nan_to_num(normalized, nan=0.0, posinf=1.0, neginf=0.0)
    return (normalized * 255).astype("uint8")


def _positive_int(value: Any) -> Optional[int]:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _cap(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return str(value)
