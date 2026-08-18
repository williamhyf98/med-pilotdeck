"""Configuration-driven, root-confined Gallery scanning and slice rendering."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

from ..config import GalleryDatasetSettings, GallerySettings, ImagingLimits
from ..ingestion.contracts import resolve_under_root
from .contracts import GalleryCaseMetadata, GalleryDatasetMetadata, validate_identifier


class GalleryUnavailableError(RuntimeError):
    pass


class GalleryNotFoundError(LookupError):
    pass


@dataclass(frozen=True)
class _ScannedCase:
    config: GalleryDatasetSettings
    case_id: str
    directory: Path
    slices: tuple[Path, ...]
    report_available: bool


class GalleryScanner:
    def __init__(
        self,
        settings: GallerySettings,
        limits: ImagingLimits,
        *,
        data_root: str | None,
        max_pixels: int,
    ) -> None:
        self.settings = settings
        self.limits = limits
        self.data_root = data_root
        self.max_pixels = max_pixels

    def status(self) -> dict[str, Any]:
        if not self.settings.enabled:
            return {
                "status": "unavailable",
                "available": False,
                "reason": "feature_disabled",
                "datasets": 0,
            }
        if not self.data_root:
            return {
                "status": "unavailable",
                "available": False,
                "reason": "data_root_not_configured",
                "datasets": 0,
            }
        try:
            datasets = self.list_datasets()["datasets"]
        except (OSError, ValueError, GalleryUnavailableError):
            return {
                "status": "unavailable",
                "available": False,
                "reason": "gallery_root_unreadable",
                "datasets": 0,
            }
        return {
            "status": "ready",
            "available": True,
            "reason": None,
            "datasets": len([item for item in datasets if item["available"]]),
        }

    def list_datasets(self) -> dict[str, Any]:
        gallery_root = self._gallery_root()
        datasets: list[dict[str, Any]] = []
        for configured in self.settings.datasets:
            try:
                dataset_root = resolve_under_root(
                    gallery_root,
                    configured.path,
                    must_exist=True,
                )
                if not dataset_root.is_dir() or dataset_root.is_symlink():
                    raise OSError("dataset is not a regular directory")
                case_count = len(self._case_directories(dataset_root))
                available = True
            except (OSError, ValueError):
                case_count = None
                available = False
            datasets.append(
                GalleryDatasetMetadata(
                    dataset_id=configured.dataset_id,
                    label=configured.label or configured.dataset_id,
                    description=configured.description,
                    modality=configured.modality,
                    available=available,
                    case_count=case_count,
                    has_report_text=bool(configured.report_names),
                    version=configured.version,
                    license_id=configured.license_id,
                )
                .validate()
                .to_dict()
            )
        return {
            "status": "ready",
            "datasets": datasets,
            "storage_paths_exposed": False,
        }

    def list_cases(self, dataset_id: str) -> dict[str, Any]:
        configured, dataset_root = self._dataset(dataset_id)
        cases: list[dict[str, Any]] = []
        warnings: list[str] = []
        for directory in self._case_directories(dataset_root):
            try:
                scanned = self._scan_case(configured, directory)
            except (OSError, ValueError):
                warnings.append("one case was skipped because its identifier or files were unsafe")
                continue
            if not scanned.slices:
                continue
            cases.append(self._case_metadata(scanned))
        return {
            "status": "ready",
            "dataset_id": configured.dataset_id,
            "cases": cases,
            "warnings": warnings,
            "storage_paths_exposed": False,
        }

    def get_case(self, dataset_id: str, case_id: str) -> dict[str, Any]:
        scanned = self._find_case(dataset_id, case_id)
        metadata = self._case_metadata(scanned)
        return {
            "status": "ready",
            "case": metadata,
            "slices": [
                {
                    "index": index,
                    "slice_id": f"{case_id}:{index}",
                    "diagnostic_grade": False,
                }
                for index in range(len(scanned.slices))
            ],
            "warnings": ["切片未评估烧录文字或 PHI，不用于诊断"],
            "storage_paths_exposed": False,
        }

    def get_slice(self, dataset_id: str, case_id: str, index: int) -> dict[str, Any]:
        scanned = self._find_case(dataset_id, case_id)
        if not 0 <= index < len(scanned.slices):
            raise GalleryNotFoundError("gallery slice index is outside the case")
        path = resolve_under_root(
            scanned.directory,
            scanned.slices[index].name,
            must_exist=True,
        )
        if not path.is_file() or path.is_symlink():
            raise GalleryNotFoundError("gallery slice is no longer a regular file")
        size = path.stat().st_size
        if not 1 <= size <= self.settings.max_slice_bytes:
            raise ValueError("gallery slice exceeds the configured byte budget")
        try:
            from PIL import Image
        except ImportError as exc:
            raise GalleryUnavailableError("dependency_missing:Pillow") from exc

        raw = path.read_bytes()
        try:
            with Image.open(BytesIO(raw)) as image:
                image.load()
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > self.max_pixels:
                    raise ValueError("gallery slice exceeds the configured pixel budget")
                normalized = image.convert("L" if image.mode in {"1", "L", "I", "F"} else "RGB")
                output = BytesIO()
                normalized.save(output, format="PNG", optimize=True)
        except (OSError, ValueError) as exc:
            raise ValueError("gallery slice is not a supported safe image") from exc
        png = output.getvalue()
        if len(png) > self.settings.max_slice_bytes:
            raise ValueError("normalized gallery slice exceeds the configured byte budget")
        return {
            "status": "ready",
            "dataset_id": scanned.config.dataset_id,
            "case_id": scanned.case_id,
            "index": index,
            "media_type": "image/png",
            "data": base64.b64encode(png).decode("ascii"),
            "byte_size": len(png),
            "width": width,
            "height": height,
            "diagnostic_grade": False,
            "warnings": ["切片未评估烧录文字或 PHI，不用于诊断"],
        }

    def _gallery_root(self) -> Path:
        if not self.settings.enabled:
            raise GalleryUnavailableError("Gallery is disabled by configuration")
        if not self.data_root:
            raise GalleryUnavailableError("Gallery data root is not configured")
        root = resolve_under_root(
            self.data_root,
            self.settings.root,
            must_exist=True,
        )
        if not root.is_dir() or root.is_symlink():
            raise GalleryUnavailableError("Gallery root is not a regular directory")
        return root

    def _dataset(self, dataset_id: str) -> tuple[GalleryDatasetSettings, Path]:
        normalized = validate_identifier(dataset_id, "dataset_id")
        configured = next(
            (item for item in self.settings.datasets if item.dataset_id == normalized),
            None,
        )
        if configured is None:
            raise GalleryNotFoundError("unknown Gallery dataset")
        root = resolve_under_root(
            self._gallery_root(),
            configured.path,
            must_exist=True,
        )
        if not root.is_dir() or root.is_symlink():
            raise GalleryUnavailableError("Gallery dataset is unavailable")
        return configured, root

    def _case_directories(self, dataset_root: Path) -> tuple[Path, ...]:
        directories = tuple(
            sorted(
                (
                    item
                    for item in dataset_root.iterdir()
                    if item.is_dir() and not item.is_symlink()
                ),
                key=lambda item: item.name.casefold(),
            )
        )
        if len(directories) > self.settings.max_cases_per_dataset:
            raise ValueError("Gallery case count exceeds the configured budget")
        return directories

    def _find_case(self, dataset_id: str, case_id: str) -> _ScannedCase:
        configured, dataset_root = self._dataset(dataset_id)
        normalized = validate_identifier(case_id, "case_id")
        directory = resolve_under_root(dataset_root, normalized, must_exist=True)
        if not directory.is_dir() or directory.is_symlink():
            raise GalleryNotFoundError("unknown Gallery case")
        scanned = self._scan_case(configured, directory)
        if not scanned.slices:
            raise GalleryNotFoundError("Gallery case has no configured slices")
        return scanned

    def _scan_case(
        self,
        configured: GalleryDatasetSettings,
        directory: Path,
    ) -> _ScannedCase:
        case_id = validate_identifier(directory.name, "case_id")
        slices = tuple(
            sorted(
                (
                    item
                    for item in directory.iterdir()
                    if item.is_file()
                    and not item.is_symlink()
                    and item.suffix.lower() in self.settings.slice_extensions
                    and 1 <= item.stat().st_size <= self.settings.max_slice_bytes
                ),
                key=lambda item: item.name.casefold(),
            )
        )
        if len(slices) > self.limits.max_gallery_slices:
            raise ValueError("Gallery case slice count exceeds the configured budget")
        reports = {
            item.name
            for item in directory.iterdir()
            if item.is_file() and not item.is_symlink()
        }
        return _ScannedCase(
            config=configured,
            case_id=case_id,
            directory=directory,
            slices=slices,
            report_available=any(name in reports for name in configured.report_names),
        )

    def _case_metadata(self, scanned: _ScannedCase) -> dict[str, Any]:
        return (
            GalleryCaseMetadata(
                dataset_id=scanned.config.dataset_id,
                case_id=scanned.case_id,
                slice_count=len(scanned.slices),
                thumbnail_index=len(scanned.slices) // 2,
                modality=scanned.config.modality,
                report_available=scanned.report_available,
            )
            .validate(max_slices=self.limits.max_gallery_slices)
            .to_dict()
        )
