"""Storage-neutral Volume and Gallery metadata contracts."""

from __future__ import annotations

from dataclasses import dataclass
import math
import re
from typing import Any, Mapping, Sequence


IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
VOLUME_EXTENSIONS = {".nii", ".nii.gz", ".npy"}


def validate_identifier(value: str, field: str) -> str:
    normalized = (value or "").strip()
    if not IDENTIFIER_RE.fullmatch(normalized):
        raise ValueError(f"{field} must match {IDENTIFIER_RE.pattern}")
    return normalized


@dataclass(frozen=True)
class VolumeMetadata:
    volume_id: str
    filename: str
    extension: str
    original_shape: tuple[int, int, int]
    spacing: tuple[float, float, float] | None
    modality: str
    preview_slices: int
    thumbnail_index: int
    value_range: tuple[float, float] | None
    byte_size: int
    sha256: str
    schema_version: int = 1

    @classmethod
    def from_mapping(cls, body: Mapping[str, Any]) -> "VolumeMetadata":
        shape_raw = body.get("original_shape", body.get("orig_shape"))
        spacing_raw = body.get("spacing")
        value_range_raw = body.get("value_range")
        return cls(
            volume_id=str(body.get("volume_id", body.get("vid", ""))),
            filename=str(body.get("filename", "")),
            extension=str(body.get("extension", body.get("ext", ""))).lower(),
            original_shape=_triple_int(shape_raw, "original_shape"),
            spacing=(
                _triple_float(spacing_raw, "spacing")
                if spacing_raw is not None
                else None
            ),
            modality=str(body.get("modality", "unknown")),
            preview_slices=int(body.get("preview_slices", body.get("n_slices", 0))),
            thumbnail_index=int(body.get("thumbnail_index", body.get("thumb_index", 0))),
            value_range=(
                _pair_float(value_range_raw, "value_range")
                if value_range_raw is not None
                else None
            ),
            byte_size=int(body.get("byte_size", 0)),
            sha256=str(body.get("sha256", "")),
        )

    def validate(
        self,
        *,
        max_volume_bytes: int = 512 * 1024 * 1024,
        max_voxels: int = 512 * 1024 * 1024,
        max_preview_slices: int = 64,
    ) -> "VolumeMetadata":
        validate_identifier(self.volume_id, "volume_id")
        if not self.filename or "/" in self.filename or "\\" in self.filename:
            raise ValueError("filename must be a basename")
        if self.extension not in VOLUME_EXTENSIONS:
            raise ValueError("extension must be .nii, .nii.gz, or .npy")
        if any(value <= 0 for value in self.original_shape):
            raise ValueError("original_shape values must be positive")
        if math.prod(self.original_shape) > max_voxels:
            raise ValueError("volume voxel count exceeds the configured budget")
        if self.spacing is not None and any(value <= 0 or not math.isfinite(value) for value in self.spacing):
            raise ValueError("spacing values must be finite and positive")
        if not 1 <= self.byte_size <= max_volume_bytes:
            raise ValueError("volume byte_size exceeds the configured budget")
        if not 1 <= self.preview_slices <= max_preview_slices:
            raise ValueError("preview_slices is outside the configured budget")
        if not 0 <= self.thumbnail_index < self.preview_slices:
            raise ValueError("thumbnail_index is outside preview_slices")
        if self.value_range is not None:
            low, high = self.value_range
            if not all(math.isfinite(value) for value in self.value_range) or high < low:
                raise ValueError("value_range must contain finite ascending values")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", self.sha256):
            raise ValueError("sha256 must be a SHA-256 hex digest")
        return self

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "volume_id": self.volume_id,
            "vid": self.volume_id,
            "filename": self.filename,
            "extension": self.extension,
            "ext": self.extension,
            "original_shape": list(self.original_shape),
            "orig_shape": list(self.original_shape),
            "spacing": list(self.spacing) if self.spacing else None,
            "modality": self.modality,
            "preview_slices": self.preview_slices,
            "n_slices": self.preview_slices,
            "thumbnail_index": self.thumbnail_index,
            "thumb_index": self.thumbnail_index,
            "value_range": list(self.value_range) if self.value_range else None,
            "byte_size": self.byte_size,
            "sha256": self.sha256.lower(),
            "diagnostic_grade": False,
        }


@dataclass(frozen=True)
class GalleryDatasetMetadata:
    dataset_id: str
    label: str
    description: str
    modality: str
    available: bool
    case_count: int | None
    has_report_text: bool
    version: str
    license_id: str
    schema_version: int = 1

    @classmethod
    def from_mapping(cls, body: Mapping[str, Any]) -> "GalleryDatasetMetadata":
        raw_count = body.get("case_count", body.get("n_cases"))
        return cls(
            dataset_id=str(body.get("dataset_id", body.get("id", ""))),
            label=str(body.get("label", "")),
            description=str(body.get("description", body.get("desc", ""))),
            modality=str(body.get("modality", "")),
            available=bool(body.get("available", False)),
            case_count=(int(raw_count) if raw_count is not None else None),
            has_report_text=bool(body.get("has_report_text", body.get("has_text", False))),
            version=str(body.get("version", "")),
            license_id=str(body.get("license_id", "")),
        )

    def validate(self) -> "GalleryDatasetMetadata":
        validate_identifier(self.dataset_id, "dataset_id")
        if self.case_count is not None and self.case_count < 0:
            raise ValueError("case_count cannot be negative")
        if self.available and (not self.version or not self.license_id):
            raise ValueError("available datasets require version and license_id")
        return self

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "id": self.dataset_id,
            "dataset_id": self.dataset_id,
            "label": self.label,
            "desc": self.description,
            "modality": self.modality,
            "available": self.available,
            "n_cases": self.case_count,
            "has_text": self.has_report_text,
            "version": self.version,
            "license_id": self.license_id,
        }


@dataclass(frozen=True)
class GalleryCaseMetadata:
    dataset_id: str
    case_id: str
    slice_count: int
    thumbnail_index: int
    modality: str
    report_available: bool
    schema_version: int = 1

    @classmethod
    def from_mapping(cls, body: Mapping[str, Any]) -> "GalleryCaseMetadata":
        return cls(
            dataset_id=str(body.get("dataset_id", body.get("dataset", ""))),
            case_id=str(body.get("case_id", "")),
            slice_count=int(body.get("slice_count", body.get("n_slices", 0))),
            thumbnail_index=int(body.get("thumbnail_index", body.get("thumb_index", 0))),
            modality=str(body.get("modality", "")),
            report_available=bool(body.get("report_available", body.get("has_text", False))),
        )

    def validate(self, *, max_slices: int = 4096) -> "GalleryCaseMetadata":
        validate_identifier(self.dataset_id, "dataset_id")
        validate_identifier(self.case_id, "case_id")
        if not 1 <= self.slice_count <= max_slices:
            raise ValueError("slice_count is outside the configured budget")
        if not 0 <= self.thumbnail_index < self.slice_count:
            raise ValueError("thumbnail_index is outside slice_count")
        return self

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "dataset": self.dataset_id,
            "case_id": self.case_id,
            "n_slices": self.slice_count,
            "thumb_index": self.thumbnail_index,
            "modality": self.modality,
            "has_text": self.report_available,
            # Report text and storage paths are intentionally absent.
        }


def _triple_int(value: Any, field: str) -> tuple[int, int, int]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) != 3:
        raise ValueError(f"{field} must contain exactly three integers")
    try:
        return tuple(int(item) for item in value)  # type: ignore[return-value]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must contain exactly three integers") from exc


def _triple_float(value: Any, field: str) -> tuple[float, float, float]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) != 3:
        raise ValueError(f"{field} must contain exactly three numbers")
    try:
        return tuple(float(item) for item in value)  # type: ignore[return-value]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must contain exactly three numbers") from exc


def _pair_float(value: Any, field: str) -> tuple[float, float]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) != 2:
        raise ValueError(f"{field} must contain exactly two numbers")
    try:
        return float(value[0]), float(value[1])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must contain exactly two numbers") from exc

