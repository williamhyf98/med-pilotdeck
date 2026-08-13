"""Stateless NPY/NIfTI volume metadata and limited axial previews."""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import hashlib
import math
from pathlib import Path
import struct
import tempfile
from typing import Any, Callable, Sequence
import zlib

from ..npy import NpyArray
from .contracts import VolumeMetadata


@dataclass(frozen=True)
class VolumeLimits:
    max_volume_bytes: int
    max_voxels: int
    max_preview_slices: int
    max_preview_long_side: int = 1024
    max_preview_bytes: int = 4 * 1024 * 1024


@dataclass(frozen=True)
class _LoadedVolume:
    depth: int
    height: int
    width: int
    spacing: tuple[float, float, float] | None
    dtype: str
    samples: tuple[float, ...]
    read_slice: Callable[[int], Sequence[float]]


def prepare_volume(
    data: bytes,
    *,
    filename: str,
    limits: VolumeLimits,
    requested_slices: int = 8,
) -> dict[str, Any]:
    if not data or len(data) > limits.max_volume_bytes:
        raise ValueError("volume byte size is empty or exceeds the configured budget")
    extension = _detect_extension(filename)
    if extension is None:
        raise ValueError("volume extension must be .npy, .nii, or .nii.gz")
    loaded = _load_volume_data(data, extension, limits)
    if loaded is None:
        return {
            "status": "unavailable",
            "reason": "dependency_missing:nibabel_or_numpy",
            "filename": filename,
            "extension": extension,
            "storage": "none",
        }
    if not loaded.samples:
        raise ValueError("volume contains no numeric samples")
    actual_min = min(loaded.samples)
    actual_max = max(loaded.samples)
    low, high = _robust_window(loaded.samples)
    selected = _uniform_indices(
        loaded.depth,
        min(max(1, int(requested_slices)), limits.max_preview_slices),
    )
    previews: list[dict[str, Any]] = []
    warnings: list[str] = []
    remaining_preview_bytes = 16 * 1024 * 1024
    for output_index, source_index in enumerate(selected):
        plane = loaded.read_slice(source_index)
        preview = _volume_preview(
            plane,
            width=loaded.width,
            height=loaded.height,
            low=low,
            high=high,
            source_index=source_index,
            output_index=output_index,
            limits=limits,
        )
        if preview is None or int(preview["byte_size"]) > remaining_preview_bytes:
            warnings.append(f"slice {source_index} exceeded preview byte budget")
        else:
            previews.append(preview)
            remaining_preview_bytes -= int(preview["byte_size"])
    if not previews:
        raise ValueError("volume produced no preview within the configured budget")

    digest = hashlib.sha256(data).hexdigest()
    volume_id = f"vol-{digest[:24]}"
    metadata = VolumeMetadata(
        volume_id=volume_id,
        filename=Path(filename).name,
        extension=extension,
        original_shape=(loaded.depth, loaded.height, loaded.width),
        spacing=loaded.spacing,
        modality="CT" if extension in {".nii", ".nii.gz"} else "unknown",
        preview_slices=len(previews),
        thumbnail_index=len(previews) // 2,
        value_range=(actual_min, actual_max),
        byte_size=len(data),
        sha256=digest,
    ).validate(
        max_volume_bytes=limits.max_volume_bytes,
        max_voxels=limits.max_voxels,
        max_preview_slices=limits.max_preview_slices,
    )
    return {
        "status": "ready",
        "volume": {
            **metadata.to_dict(),
            "dtype": loaded.dtype,
            "window": [low, high],
            "source_slice_indices": [item["source_index"] for item in previews],
        },
        "previews": previews,
        "warnings": warnings + ["预览为归一化轴位切片，不用于诊断"],
        "storage": "none",
    }


def render_volume_slice(
    data: bytes,
    *,
    filename: str,
    index: int,
    limits: VolumeLimits,
) -> dict[str, Any]:
    """Render one exact axial slice without retaining data or local paths."""

    if not data or len(data) > limits.max_volume_bytes:
        raise ValueError("volume byte size is empty or exceeds the configured budget")
    extension = _detect_extension(filename)
    if extension is None:
        raise ValueError("volume extension must be .npy, .nii, or .nii.gz")
    loaded = _load_volume_data(data, extension, limits)
    if loaded is None:
        return {
            "status": "unavailable",
            "reason": "dependency_missing:nibabel_or_numpy",
            "index": index,
        }
    if not 0 <= index < loaded.depth:
        raise ValueError("volume slice index is outside the volume")
    low, high = _robust_window(loaded.samples)
    preview = _volume_preview(
        loaded.read_slice(index),
        width=loaded.width,
        height=loaded.height,
        low=low,
        high=high,
        source_index=index,
        output_index=index,
        limits=limits,
    )
    if preview is None:
        raise ValueError("volume slice exceeds the configured preview byte budget")
    return {
        "status": "ready",
        "slice": preview,
        "window": [low, high],
        "warnings": ["预览为归一化轴位切片，不用于诊断"],
    }


def _load_volume_data(
    data: bytes,
    extension: str,
    limits: VolumeLimits,
) -> _LoadedVolume | None:
    if extension == ".npy":
        array = NpyArray.from_bytes(
            data,
            max_items=limits.max_voxels,
            max_dimensions=3,
        )
        if len(array.shape) != 3:
            raise ValueError("NPY volume must have shape [D,H,W]")
        depth, height, width = array.shape
        return _LoadedVolume(
            depth=depth,
            height=height,
            width=width,
            spacing=None,
            dtype=array.dtype,
            samples=array.sampled_values(),
            read_slice=array.read_depth_slice,
        )

    nifti = _load_nifti(data, extension, limits)
    if nifti is None:
        return None
    volume, spacing, dtype = nifti
    depth, height, width = (int(item) for item in volume.shape)
    if depth * height * width > limits.max_voxels:
        raise ValueError("NIfTI voxel count exceeds the configured budget")
    samples = tuple(
        float(item)
        for item in volume.ravel()[:: max(1, volume.size // 200_000)]
    )

    def read_slice(index: int) -> Sequence[float]:
        return tuple(float(item) for item in volume[index].ravel())

    return _LoadedVolume(
        depth=depth,
        height=height,
        width=width,
        spacing=spacing,
        dtype=dtype,
        samples=samples,
        read_slice=read_slice,
    )


def _load_nifti(
    data: bytes,
    extension: str,
    limits: VolumeLimits,
) -> tuple[Any, tuple[float, float, float] | None, str] | None:
    try:
        import nibabel as nib  # type: ignore
        import numpy as np  # type: ignore
    except ImportError:
        return None
    with tempfile.TemporaryDirectory(prefix="medical-volume-") as temp:
        path = Path(temp) / f"volume{extension}"
        path.write_bytes(data)
        image = nib.load(str(path))
        raw = np.asarray(image.dataobj, dtype="float32")
        raw = np.squeeze(raw)
        if raw.ndim == 4:
            raw = raw[..., 0]
        if raw.ndim != 3:
            raise ValueError("NIfTI volume must resolve to exactly three dimensions")
        volume = np.transpose(raw, (2, 1, 0))
        if volume.size > limits.max_voxels:
            raise ValueError("NIfTI voxel count exceeds the configured budget")
        zooms = image.header.get_zooms()
        spacing = (
            (float(zooms[2]), float(zooms[1]), float(zooms[0]))
            if len(zooms) >= 3
            else None
        )
        return volume, spacing, str(raw.dtype)


def _volume_preview(
    values: Sequence[float],
    *,
    width: int,
    height: int,
    low: float,
    high: float,
    source_index: int,
    output_index: int,
    limits: VolumeLimits,
) -> dict[str, Any] | None:
    if len(values) != width * height:
        raise ValueError("volume slice length does not match shape")
    scale = min(1.0, limits.max_preview_long_side / max(width, height))
    out_width = max(1, round(width * scale))
    out_height = max(1, round(height * scale))
    denominator = high - low if high > low else 1.0
    gray = bytearray(out_width * out_height)
    for y in range(out_height):
        source_y = min(height - 1, int(y / scale)) if scale < 1 else y
        for x in range(out_width):
            source_x = min(width - 1, int(x / scale)) if scale < 1 else x
            value = float(values[source_y * width + source_x])
            normalized = max(0.0, min(1.0, (value - low) / denominator))
            gray[y * out_width + x] = round(normalized * 255)
    png = _encode_grayscale_png(bytes(gray), out_width, out_height)
    if len(png) > limits.max_preview_bytes:
        return None
    return {
        "kind": "image",
        "media_type": "image/png",
        "data": base64.b64encode(png).decode("ascii"),
        "byte_size": len(png),
        "width": out_width,
        "height": out_height,
        "index": output_index,
        "source_index": source_index,
        "diagnostic_grade": False,
    }


def _encode_grayscale_png(pixels: bytes, width: int, height: int) -> bytes:
    if len(pixels) != width * height:
        raise ValueError("PNG pixel buffer does not match dimensions")
    rows = b"".join(
        b"\x00" + pixels[offset : offset + width]
        for offset in range(0, len(pixels), width)
    )

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", binascii.crc32(kind + payload) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows, level=6))
        + chunk(b"IEND", b"")
    )


def _robust_window(values: Sequence[float]) -> tuple[float, float]:
    finite = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not finite:
        raise ValueError("volume contains no finite values")
    low = finite[round((len(finite) - 1) * 0.005)]
    high = finite[round((len(finite) - 1) * 0.995)]
    if high <= low:
        low, high = finite[0], finite[-1]
    if high <= low:
        high = low + 1.0
    return low, high


def _uniform_indices(total: int, maximum: int) -> list[int]:
    count = min(total, max(1, maximum))
    if count == total:
        return list(range(total))
    if count == 1:
        return [0]
    return [round(index * (total - 1) / (count - 1)) for index in range(count)]


def _detect_extension(filename: str) -> str | None:
    lowered = (filename or "").lower()
    for extension in (".nii.gz", ".nii", ".npy"):
        if lowered.endswith(extension):
            return extension
    return None

