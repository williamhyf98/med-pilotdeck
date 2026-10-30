"""Safe, read-only DICOM pixel preview for the PilotDeck file viewer.

The module deliberately returns a small allow-listed metadata surface and a
bounded set of PNG frames. It never serializes the source dataset, patient
identity tags, or the input path.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
from pathlib import Path
from typing import Any, Dict, List


DEFAULT_MAX_FRAMES = 12
MAX_FRAMES = 24
MAX_LONG_SIDE = 1600
MAX_TOTAL_BYTES = 24 * 1024 * 1024


def _safe_text(value: Any, fallback: str = "UNKNOWN") -> str:
    if value is None:
        return fallback
    text = str(value).strip()
    return text[:80] if text else fallback


def _selected_indices(total: int, max_frames: int) -> List[int]:
    total = max(1, int(total))
    count = max(1, min(int(max_frames), MAX_FRAMES, total))
    if count == 1:
        return [0]
    values = [round(index * (total - 1) / (count - 1)) for index in range(count)]
    return list(dict.fromkeys(max(0, min(total - 1, value)) for value in values))


def _window_values(values: Any, dataset: Any) -> Any:
    """Apply a conservative CT window, otherwise percentile normalization."""
    import numpy as np

    array = np.asarray(values, dtype=np.float32)
    try:
        slope = float(getattr(dataset, "RescaleSlope", 1) or 1)
        intercept = float(getattr(dataset, "RescaleIntercept", 0) or 0)
    except (TypeError, ValueError):
        slope, intercept = 1.0, 0.0
    array = array * slope + intercept
    center = getattr(dataset, "WindowCenter", None)
    width = getattr(dataset, "WindowWidth", None)
    try:
        if isinstance(center, (list, tuple)):
            center = center[0]
        if isinstance(width, (list, tuple)):
            width = width[0]
        if center is not None and width is not None and float(width) > 1:
            low = float(center) - float(width) / 2.0
            high = float(center) + float(width) / 2.0
        else:
            finite = array[np.isfinite(array)]
            if finite.size == 0:
                return np.zeros(array.shape, dtype=np.uint8)
            low, high = np.percentile(finite, [1, 99])
            if not math.isfinite(float(low)) or not math.isfinite(float(high)) or high <= low:
                low, high = float(finite.min()), float(finite.max())
    except (TypeError, ValueError, IndexError):
        finite = array[np.isfinite(array)]
        if finite.size == 0:
            return np.zeros(array.shape, dtype=np.uint8)
        low, high = float(finite.min()), float(finite.max())

    if high <= low:
        return np.zeros(array.shape, dtype=np.uint8)
    clipped = np.clip(array, low, high)
    return ((clipped - low) * (255.0 / (high - low))).astype(np.uint8)


def _frame_png(frame: Any, dataset: Any) -> bytes:
    import numpy as np
    from PIL import Image

    array = np.asarray(frame)
    photometric = _safe_text(getattr(dataset, "PhotometricInterpretation", ""), "")
    if array.ndim >= 3 and array.shape[-1] in (3, 4):
        image = Image.fromarray(array.astype(np.uint8), mode="RGBA" if array.shape[-1] == 4 else "RGB")
    else:
        image = Image.fromarray(_window_values(array, dataset), mode="L")
        if photometric.upper() == "MONOCHROME1":
            image = Image.eval(image, lambda value: 255 - value)
    if max(image.size) > MAX_LONG_SIDE:
        image.thumbnail((MAX_LONG_SIDE, MAX_LONG_SIDE), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


def preview_dicom(
    path: str | Path,
    *,
    max_frames: int = DEFAULT_MAX_FRAMES,
    max_total_bytes: int = MAX_TOTAL_BYTES,
    metadata_only: bool = False,
) -> Dict[str, Any]:
    """Decode a bounded set of frames and return a privacy-safe payload."""
    source = Path(path)
    payload: Dict[str, Any] = {
        "ok": False,
        "modality": "UNKNOWN",
        "bodyPart": "UNKNOWN",
        "rows": 0,
        "columns": 0,
        "totalFrames": 0,
        "selectedFrames": [],
        "frames": [],
        "pixelDataAvailable": False,
        "warnings": [],
    }
    if not source.is_file():
        payload["warnings"].append("DICOM 文件不存在或不是普通文件。")
        return payload

    try:
        import numpy as np
        import pydicom
    except ImportError as exc:
        payload["errorCode"] = "DICOM_PREVIEW_UNAVAILABLE"
        payload["warnings"].append(f"DICOM 预览依赖不可用：{exc.name or 'pydicom/numpy'}。")
        return payload

    try:
        dataset = pydicom.dcmread(str(source), force=False)
    except Exception as exc:
        payload["warnings"].append(f"无法读取 DICOM 元数据：{type(exc).__name__}。")
        return payload

    payload["modality"] = _safe_text(getattr(dataset, "Modality", None))
    payload["bodyPart"] = _safe_text(
        getattr(dataset, "BodyPartExamined", None)
        or getattr(dataset, "AnatomicRegionSequence", None),
    )
    payload["rows"] = int(getattr(dataset, "Rows", 0) or 0)
    payload["columns"] = int(getattr(dataset, "Columns", 0) or 0)
    try:
        total_frames = int(getattr(dataset, "NumberOfFrames", 1) or 1)
    except (TypeError, ValueError):
        total_frames = 1
    payload["totalFrames"] = max(1, total_frames)

    payload["pixelDataAvailable"] = hasattr(dataset, "PixelData")
    if not payload["pixelDataAvailable"]:
        payload["warnings"].append("该 DICOM 不包含可渲染的像素数据。")
        return payload
    if metadata_only:
        payload["ok"] = True
        payload["selectedFrames"] = _selected_indices(payload["totalFrames"], max_frames)
        return payload

    try:
        pixels = dataset.pixel_array
        if pixels.ndim == 2:
            pixels = pixels[np.newaxis, ...]
        elif pixels.ndim == 3 and pixels.shape[-1] not in (3, 4):
            # Multi-frame grayscale: (frames, rows, columns).
            pass
        elif pixels.ndim == 3:
            # Single-frame RGB: (rows, columns, channels).
            pixels = pixels[np.newaxis, ...]
        indices = _selected_indices(pixels.shape[0], max_frames)
        payload["selectedFrames"] = indices
        encoded_bytes = 0
        for index in indices:
            encoded = _frame_png(pixels[index], dataset)
            if len(encoded) > max_total_bytes or encoded_bytes + len(encoded) > max_total_bytes:
                payload["warnings"].append("预览帧总大小超过限制，已停止继续抽帧。")
                break
            payload["frames"].append({
                "index": index,
                "data": base64.b64encode(encoded).decode("ascii"),
                "mimeType": "image/png",
            })
            encoded_bytes += len(encoded)
        payload["ok"] = bool(payload["frames"])
        if not payload["ok"]:
            payload["warnings"].append("未能生成可显示的预览帧。")
    except Exception as exc:
        payload["warnings"].append(f"DICOM 像素解码失败：{type(exc).__name__}。")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Render bounded DICOM preview frames as JSON")
    parser.add_argument("--path", required=True)
    parser.add_argument("--max-frames", type=int, default=DEFAULT_MAX_FRAMES)
    parser.add_argument("--metadata-only", action="store_true")
    args = parser.parse_args()
    result = preview_dicom(
        args.path,
        max_frames=max(1, min(args.max_frames, MAX_FRAMES)),
        metadata_only=args.metadata_only,
    )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
