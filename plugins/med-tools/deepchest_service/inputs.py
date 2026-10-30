"""Validate and bind a single uploaded CT to an isolated job (no demo fallback)."""

import csv
import hashlib
import math
import stat
import zipfile
from pathlib import Path

MAX_BYTES = 2 * 1024**3
MAX_VOXELS = 256 * 1024**2


def extract_archive(source, destination, max_bytes=MAX_BYTES):
    destination = Path(destination)
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 10000 or sum(x.file_size for x in entries) > max_bytes:
            raise ValueError("Archive exceeds expanded size or file count limit")
        for entry in entries:
            path = Path(entry.filename)
            if (
                path.is_absolute()
                or ".." in path.parts
                or "\\" in entry.filename
                or stat.S_ISLNK(entry.external_attr >> 16)
                or entry.flag_bits & 1
            ):
                raise ValueError("Unsafe archive member")
        destination.mkdir(parents=True, exist_ok=False)
        archive.extractall(destination)


def _dicom_volume(directory, output):
    import numpy as np
    import pydicom
    import SimpleITK as sitk

    rows = []
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        if path.name.startswith(".") or "__MACOSX" in path.parts:
            continue
        try:
            d = pydicom.dcmread(path, stop_before_pixels=True)
        except Exception as exc:
            raise ValueError("Archive must contain only one DICOM CT series") from exc
        if str(d.get("Modality", "")) != "CT" or int(d.get("NumberOfFrames", 1)) != 1:
            raise ValueError("Only single-frame CT series is supported in DICOM ZIP")
        region = str(d.get("BodyPartExamined", "")).upper()
        if region and region not in ("CHEST", "THORAX", "LUNG"):
            raise ValueError("DICOM body region is not exclusively chest")
        if "LOCALIZER" in str(d.get("ImageType", "")).upper():
            raise ValueError("Localizer image is not a volumetric CT series")
        required = (
            "SeriesInstanceUID",
            "ImagePositionPatient",
            "ImageOrientationPatient",
            "PixelSpacing",
            "Rows",
            "Columns",
            "RescaleSlope",
            "RescaleIntercept",
        )
        if any(key not in d for key in required):
            raise ValueError("DICOM missing CT geometry or HU calibration")
        if str(d.get("RescaleType", "HU")).upper() != "HU":
            raise ValueError("DICOM intensity must be HU")
        rows.append((path, d))
    if len(rows) < 16 or len({str(d.SeriesInstanceUID) for _, d in rows}) != 1:
        raise ValueError("Expected a single CT series with at least 16 slices")
    first = rows[0][1]
    orient = np.asarray(first.ImageOrientationPatient, dtype=float)
    if orient.shape != (6,) or not np.isfinite(orient).all():
        raise ValueError("Invalid DICOM orientation")
    normal = np.cross(orient[:3], orient[3:])
    if not np.isclose(np.linalg.norm(normal), 1, atol=1e-4):
        raise ValueError("Invalid DICOM orientation")
    positions = []
    for _, d in rows:
        if (
            not np.allclose(d.ImageOrientationPatient, orient, atol=1e-4)
            or not np.allclose(d.PixelSpacing, first.PixelSpacing)
            or (d.Rows, d.Columns) != (first.Rows, first.Columns)
        ):
            raise ValueError("Inconsistent DICOM series geometry")
        positions.append(np.asarray(d.ImagePositionPatient, dtype=float))
    order = np.argsort([np.dot(p, normal) for p in positions])
    offsets = np.diff(np.asarray(positions)[order], axis=0)
    distances = offsets @ normal
    spacing = float(np.median(distances))
    if (
        not np.isfinite(offsets).all()
        or spacing <= 0
        or not np.allclose(distances, spacing, rtol=0.02, atol=0.05)
        or not np.allclose(offsets, distances[:, None] * normal, atol=0.05)
    ):
        raise ValueError("Duplicate, missing, tilted or irregular CT slices")
    if int(first.Rows) * int(first.Columns) * len(rows) > MAX_VOXELS:
        raise ValueError("CT exceeds decoded voxel limit")
    reader = sitk.ImageSeriesReader()
    reader.SetFileNames([str(rows[i][0]) for i in order])
    image = reader.Execute()
    sitk.WriteImage(image, str(output))


def prepare_input(source, job, body_region, modality, intensity_units):
    if (body_region, modality, intensity_units) != ("chest", "CT", "HU"):
        raise ValueError("Confirm complete chest CT in HU before submitting")
    source, job = Path(source), Path(job)
    if not source.is_file() or source.is_symlink() or source.stat().st_size > MAX_BYTES:
        raise ValueError("Input is missing or exceeds upload limit")
    import nibabel as nib
    import numpy as np

    digest = hashlib.sha256()
    with source.open("rb") as handle:
        for block in iter(lambda: handle.read(1024**2), b""):
            digest.update(block)
    volume = source
    if source.name.lower().endswith(".zip"):
        extracted = job / "dicom"
        extract_archive(source, extracted)
        volume = job / "converted.nii.gz"
        _dicom_volume(extracted, volume)
    elif not source.name.lower().endswith((".nii", ".nii.gz")):
        raise ValueError("Expected NIfTI or DICOM series ZIP")
    image = nib.load(volume)
    shape = image.shape
    affine = np.asarray(image.affine)
    if (
        len(shape) != 3
        or min(shape) < 16
        or math.prod(shape) > MAX_VOXELS
        or np.dtype(image.get_data_dtype()).kind not in "iuf"
        or not np.isfinite(affine).all()
    ):
        raise ValueError("Expected a finite numeric 3D CT volume within voxel limit")
    linear = affine[:3, :3]
    scale = np.linalg.norm(linear, axis=0)
    if np.any(scale <= 0) or abs(np.linalg.det(linear)) < 1e-8:
        raise ValueError("Invalid CT affine")
    # Reject oblique geometry instead of silently interpreting it as axial HWD.
    normalized = np.abs(linear / scale)
    if not np.allclose(normalized.max(axis=0), 1, atol=1e-4):
        raise ValueError("Oblique CT requires validated resampling before analysis")
    # Match the LPS storage orientation used by the verified DeepChest pipeline.
    transform = nib.orientations.ornt_transform(
        nib.orientations.io_orientation(affine),
        nib.orientations.axcodes2ornt(("L", "P", "S")),
    )
    image = image.as_reoriented(transform)
    data = np.asarray(image.dataobj, dtype=np.float32)
    if not np.isfinite(data).all():
        raise ValueError("CT contains nonfinite voxels")
    job.mkdir(parents=True, exist_ok=True)
    target = job / "volumes" / "upload" / "img" / f"{job.name}.nii.gz"
    target.parent.mkdir(parents=True, exist_ok=True)
    # New header avoids propagating names/free text embedded in uploaded headers.
    nib.save(nib.Nifti1Image(data, image.affine), target)
    with (job / "case.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["Image ID", "dataset"])
        writer.writeheader()
        writer.writerow({"Image ID": job.name, "dataset": "upload"})
    return {
        "case_id": job.name,
        "sha256": digest.hexdigest(),
        "shape": list(image.shape),
        "orientation": "LPS",
        "spacing": [float(x) for x in image.header.get_zooms()],
        "body_region": "chest",
        "modality": "CT",
        "intensity_units": "HU",
        "context_source": "caller confirmation; DICOM metadata checked where present",
        "volume": str(target.relative_to(job)),
    }
