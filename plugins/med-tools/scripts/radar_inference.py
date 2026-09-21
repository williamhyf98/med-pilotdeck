#!/usr/bin/env python3
"""Run official DAMO RADAR inference and write a compact machine-readable summary."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any


MAX_NIFTI_VOXELS = max(1, int(os.environ.get("RADAR_MAX_NIFTI_VOXELS", "536870912")))
MAX_NIFTI_DECODED_BYTES = max(
    1, int(os.environ.get("RADAR_MAX_NIFTI_DECODED_BYTES", str(4 * 1024**3)))
)
MAX_RADAR_RESAMPLED_VOXELS = max(
    1, int(os.environ.get("RADAR_MAX_RESAMPLED_VOXELS", "268435456"))
)
MAX_RADAR_RESAMPLED_BYTES = max(
    1, int(os.environ.get("RADAR_MAX_RESAMPLED_BYTES", str(2 * 1024**3)))
)
MAX_RADAR_GPU_WORKING_BYTES = max(
    1, int(os.environ.get("RADAR_MAX_GPU_WORKING_BYTES", str(24 * 1024**3)))
)
RADAR_MASK_CHANNELS = 37
RADAR_MASK_PEAK_COPIES = 3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--summary-json", required=True)
    parser.add_argument("--radar-root", required=True)
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--text-embedding", required=True)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--top-k", type=int, default=15)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--max-cases", type=int, default=4)
    parser.add_argument("--study-context", default="")
    return parser.parse_args()


def is_nifti(path: Path) -> bool:
    name = path.name.lower()
    return name.endswith(".nii") or name.endswith(".nii.gz")


def safe_stem(path: Path) -> str:
    name = path.name.removesuffix(".gz").removesuffix(".nii")
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-._") or "study"


def validate_nifti_header(source: Path) -> dict[str, Any]:
    """Validate NIfTI geometry and decoded size without loading voxel data."""
    import nibabel as nib
    import numpy as np

    try:
        image = nib.load(str(source), mmap=False)
        shape = tuple(int(value) for value in image.shape)
        dtype = np.dtype(image.get_data_dtype())
        affine = np.asarray(image.affine, dtype=np.float64)
        spacing = tuple(float(value) for value in image.header.get_zooms()[:3])
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Invalid NIfTI header for {source.name}: {exc}") from exc

    if len(shape) != 3 or any(value <= 0 for value in shape):
        raise ValueError(f"NIfTI must be a non-empty 3D volume: {source.name} has shape {shape}")
    if dtype.kind not in {"i", "u", "f"}:
        raise ValueError(f"NIfTI must use a real numeric dtype: {source.name} uses {dtype}")

    voxel_count = math.prod(shape)
    decoded_bytes = voxel_count * max(dtype.itemsize, 4)
    if voxel_count > MAX_NIFTI_VOXELS:
        raise ValueError(
            f"NIfTI voxel count exceeds RADAR_MAX_NIFTI_VOXELS: "
            f"{source.name} has {voxel_count}"
        )
    if decoded_bytes > MAX_NIFTI_DECODED_BYTES:
        raise ValueError(
            f"NIfTI decoded size exceeds RADAR_MAX_NIFTI_DECODED_BYTES: "
            f"{source.name} needs at least {decoded_bytes} bytes"
        )
    if affine.shape != (4, 4) or not np.isfinite(affine).all():
        raise ValueError(f"NIfTI affine must be a finite 4x4 matrix: {source.name}")
    spatial_affine = affine[:3, :3]
    if abs(float(np.linalg.det(spatial_affine))) < 1e-8:
        raise ValueError(f"NIfTI affine is singular: {source.name}")
    if len(spacing) != 3 or any(not math.isfinite(value) or value <= 0 for value in spacing):
        raise ValueError(f"NIfTI voxel spacing must be finite and positive: {source.name}")

    # The upstream RADAR loader derives spacing from affine diagonal entries and
    # does not apply an orientation transform. Reject permutations/obliquity that
    # it would otherwise turn into zero or misleading resampling dimensions.
    diagonal = np.diag(spatial_affine)
    axis_scale = float(np.max(np.abs(spatial_affine)))
    off_axis = spatial_affine - np.diag(diagonal)
    if np.any(np.abs(diagonal) < 1e-6) or np.any(
        np.abs(off_axis) > max(1e-5, axis_scale * 1e-3)
    ):
        raise ValueError(
            f"NIfTI affine must be axis-aligned for the RADAR preprocessing pipeline: {source.name}"
        )

    model_spacing = tuple(float(abs(value)) for value in diagonal)
    target_shape = (
        int(shape[0] * model_spacing[1]),
        int(shape[1] * model_spacing[0]),
        int(shape[2] * model_spacing[2] / 5.0),
    )
    if any(value <= 0 for value in target_shape):
        raise ValueError(
            f"NIfTI spacing produces an empty RADAR resampling dimension: {source.name}"
        )
    resampled_voxels = math.prod(target_shape)
    resampled_bytes = resampled_voxels * 4
    gpu_working_bytes = (
        resampled_voxels * RADAR_MASK_CHANNELS * 4 * RADAR_MASK_PEAK_COPIES
    )
    if resampled_voxels > MAX_RADAR_RESAMPLED_VOXELS:
        raise ValueError(
            f"RADAR resampled voxel count exceeds RADAR_MAX_RESAMPLED_VOXELS: "
            f"{source.name} would produce {resampled_voxels}"
        )
    if resampled_bytes > MAX_RADAR_RESAMPLED_BYTES:
        raise ValueError(
            f"RADAR resampled size exceeds RADAR_MAX_RESAMPLED_BYTES: "
            f"{source.name} needs at least {resampled_bytes} bytes"
        )
    if gpu_working_bytes > MAX_RADAR_GPU_WORKING_BYTES:
        raise ValueError(
            f"RADAR mask working set exceeds RADAR_MAX_GPU_WORKING_BYTES: "
            f"{source.name} needs at least {gpu_working_bytes} bytes"
        )

    return {
        "shape": list(shape),
        "dtype": str(dtype),
        "voxel_count": voxel_count,
        "decoded_bytes": decoded_bytes,
        "spacing": list(spacing),
        "radar_model_spacing": list(model_spacing),
        "radar_target_shape": list(target_shape),
        "radar_resampled_voxels": resampled_voxels,
        "radar_resampled_bytes": resampled_bytes,
        "radar_mask_working_bytes": gpu_working_bytes,
    }


def stage_nifti(source: Path, staging: Path, index: int) -> Path:
    suffix = ".nii.gz" if source.name.lower().endswith(".nii.gz") else ".nii"
    destination = staging / f"{index:03d}-{safe_stem(source)}{suffix}"
    if destination.exists() or destination.is_symlink():
        destination.unlink()
    try:
        destination.symlink_to(source.resolve())
    except OSError:
        shutil.copy2(source, destination)
    return destination


def stage_multiframe_dicom(source: Path, staging: Path, index: int) -> dict[str, Any]:
    """Convert one multi-frame CT DICOM into the NIfTI volume RADAR consumes."""
    import SimpleITK as sitk

    reader = sitk.ImageFileReader()
    reader.SetFileName(str(source))
    try:
        reader.ReadImageInformation()
    except RuntimeError as exc:
        raise ValueError(f"Single-file DICOM could not be read: {source.name}") from exc

    modality = (
        reader.GetMetaData("0008|0060").strip().upper()
        if reader.HasMetaDataKey("0008|0060")
        else ""
    )
    if modality != "CT":
        raise ValueError(
            f"Single-file RADAR DICOM input must use Modality=CT, got {modality or 'UNKNOWN'}"
        )
    size = tuple(int(value) for value in reader.GetSize())
    if reader.GetDimension() != 3 or len(size) != 3 or size[2] < 3:
        raise ValueError(
            "Single-file RADAR DICOM input must contain a 3D multi-frame CT volume "
            "with at least 3 frames"
        )

    try:
        image = reader.Execute()
    except RuntimeError as exc:
        raise ValueError(f"Multi-frame DICOM pixel decoding failed: {source.name}") from exc
    staged = staging / f"{index:03d}-dicom-multiframe-{safe_stem(source)}.nii.gz"
    sitk.WriteImage(image, str(staged), useCompression=True)
    header = validate_nifti_header(staged)
    return {
        "staged_file": staged.name,
        "source": str(source.resolve()),
        "kind": "dicom-multiframe",
        "frame_count": size[2],
        "header": header,
    }


def dicom_series(root: Path) -> list[tuple[Path, str, list[str]]]:
    import SimpleITK as sitk

    start = root if root.is_dir() else root.parent
    directories = [start] + sorted(path for path in start.rglob("*") if path.is_dir())
    selected_file = str(root.resolve()) if root.is_file() else ""
    found: list[tuple[Path, str, list[str]]] = []
    seen: set[tuple[str, str]] = set()
    for directory in directories:
        try:
            series_ids = sitk.ImageSeriesReader.GetGDCMSeriesIDs(str(directory)) or []
        except RuntimeError:
            continue
        for series_id in series_ids:
            key = (str(directory.resolve()), str(series_id))
            if key in seen:
                continue
            files = list(
                sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(directory), series_id)
            )
            resolved_files = {str(Path(item).resolve()) for item in files}
            if selected_file and selected_file not in resolved_files:
                continue
            seen.add(key)
            found.append((directory, str(series_id), files))
    return found


def stage_inputs(input_path: Path, staging: Path, max_cases: int) -> list[dict[str, Any]]:
    import SimpleITK as sitk

    staging.mkdir(parents=True, exist_ok=True)
    if input_path.is_file() and is_nifti(input_path):
        direct = [input_path]
    elif input_path.is_dir():
        direct = sorted(
            path for path in input_path.rglob("*") if path.is_file() and is_nifti(path)
        )
    else:
        direct = []

    manifest: list[dict[str, Any]] = []
    validated: list[tuple[Path, dict[str, Any]]] = []
    total_voxels = 0
    total_decoded_bytes = 0
    total_resampled_voxels = 0
    total_resampled_bytes = 0
    for source in direct[:max_cases]:
        metadata = validate_nifti_header(source)
        total_voxels += int(metadata["voxel_count"])
        total_decoded_bytes += int(metadata["decoded_bytes"])
        total_resampled_voxels += int(metadata["radar_resampled_voxels"])
        total_resampled_bytes += int(metadata["radar_resampled_bytes"])
        if total_voxels > MAX_NIFTI_VOXELS or total_decoded_bytes > MAX_NIFTI_DECODED_BYTES:
            raise ValueError("Selected NIfTI volumes exceed the configured aggregate decode budget")
        if (
            total_resampled_voxels > MAX_RADAR_RESAMPLED_VOXELS
            or total_resampled_bytes > MAX_RADAR_RESAMPLED_BYTES
        ):
            raise ValueError(
                "Selected NIfTI volumes exceed the configured aggregate RADAR resampling budget"
            )
        validated.append((source, metadata))
    for source, metadata in validated:
        staged = stage_nifti(source, staging, len(manifest) + 1)
        manifest.append(
            {
                "staged_file": staged.name,
                "source": str(source.resolve()),
                "kind": "nifti",
                "header": metadata,
            }
        )
    if manifest:
        return manifest

    if input_path.is_file():
        return [stage_multiframe_dicom(input_path, staging, 1)]

    for directory, series_id, files in dicom_series(input_path)[:max_cases]:
        reader = sitk.ImageSeriesReader()
        reader.SetFileNames(files)
        image = reader.Execute()
        staged = staging / f"{len(manifest) + 1:03d}-dicom-{safe_stem(directory)}.nii.gz"
        sitk.WriteImage(image, str(staged), useCompression=True)
        header = validate_nifti_header(staged)
        manifest.append(
            {
                "staged_file": staged.name,
                "source": str(directory.resolve()),
                "kind": "dicom-series",
                "series_id": series_id,
                "slice_count": len(files),
                "header": header,
            }
        )
    if not manifest:
        raise ValueError(
            "No NIfTI volume or readable DICOM series was found. "
            "RADAR requires a 3D CT volume, not a standalone 2D image."
        )
    return manifest


def as_score(value: str) -> float | None:
    if not value.strip():
        return None
    try:
        score = float(value)
    except ValueError:
        return None
    return score if math.isfinite(score) else None


def summarize_csv(
    csv_path: Path,
    manifest: list[dict[str, Any]],
    top_k: int,
    threshold: float,
) -> list[dict[str, Any]]:
    sources = {item["staged_file"]: item for item in manifest}
    cases: list[dict[str, Any]] = []
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or len(reader.fieldnames) < 2:
            raise ValueError(f"RADAR CSV has no finding columns: {csv_path}")
        filename_key = reader.fieldnames[0]
        for row in reader:
            filename = str(row.get(filename_key) or "")
            scores = [
                (name, as_score(str(row.get(name) or ""))) for name in reader.fieldnames[1:]
            ]
            valid = [(name, score) for name, score in scores if score is not None]
            valid.sort(key=lambda item: item[1], reverse=True)
            missing = [name for name, score in scores if score is None]
            source = sources.get(filename, {"staged_file": filename, "source": filename})
            cases.append(
                {
                    "file_name": filename,
                    "source": source,
                    "score_count": len(scores),
                    "valid_score_count": len(valid),
                    "missing_scores": missing,
                    "threshold": threshold,
                    "findings_at_or_above_threshold": [
                        {"finding": name, "score": score}
                        for name, score in valid
                        if score >= threshold
                    ][:top_k],
                    "top_scores": [
                        {"finding": name, "score": score} for name, score in valid[:top_k]
                    ],
                }
            )
    return cases


def domain_flags(study_context: str) -> list[str]:
    text = study_context.strip().lower()
    flags: list[str] = []
    if not text:
        flags.append("anatomic_region_and_contrast_phase_unverified")
        return flags
    if not any(token in text for token in ("abdomen", "abdominal", "pelvis", "腹", "盆")):
        flags.append("anatomic_region_outside_primary_training_domain")
    noncontrast_tokens = (
        "noncontrast",
        "non-contrast",
        "unenhanced",
        "without contrast",
        "plain ct",
        "平扫",
        "非增强",
    )
    if any(token in text for token in noncontrast_tokens) or not any(
        token in text for token in ("contrast", "enhanced", "增强")
    ):
        flags.append("contrast_phase_unverified_or_noncontrast")
    return flags


def main() -> None:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    staging = output_dir / "input"
    if staging.exists():
        shutil.rmtree(staging)
    manifest = stage_inputs(input_path, staging, max(1, min(args.max_cases, 8)))

    radar_root = Path(args.radar_root).expanduser().resolve()
    model_root = Path(args.model_root).expanduser().resolve()
    os.environ["MODEL_ROOT"] = str(model_root)
    os.environ["CONFIGS_ROOT"] = str(model_root)
    os.environ["TEXT_EMBEDDING_PATH"] = str(Path(args.text_embedding).expanduser().resolve())
    sys.path.insert(0, str(radar_root / "RADAR_inference"))

    import torch
    from inference_demo import inference, initialize

    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is not available in the RADAR runtime.")

    save_tag = "pilotdeck"
    initialized = initialize(device)
    inference(initialized, str(staging), str(output_dir), save_tag, device, 0)
    csv_path = output_dir / f"RADAR_infer_results_{save_tag}.csv"
    summary = {
        "ok": True,
        "status": "completed",
        "model": "DAMO RADAR",
        "device": str(device),
        "input": str(input_path),
        "study_context": args.study_context.strip(),
        "training_domain": "primarily contrast-enhanced abdominal CT",
        "domain_flags": domain_flags(args.study_context),
        "warnings": [
            "RADAR scores are uncalibrated model signals, not clinical probabilities or diagnoses.",
            "A low score does not establish absence, and a high score requires image-level and clinical review.",
            "Use outside contrast-enhanced abdominal CT is subject to domain shift.",
        ],
        "cases": summarize_csv(
            csv_path,
            manifest,
            max(1, min(args.top_k, 50)),
            max(0.0, min(args.threshold, 1.0)),
        ),
        "artifacts": {
            "scores_csv": str(csv_path),
            "summary_json": str(Path(args.summary_json).expanduser().resolve()),
            "staged_input_dir": str(staging),
        },
    }
    summary_path = Path(args.summary_json).expanduser().resolve()
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"ok": True, "summary_json": str(summary_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
