"""Unit tests for node12 RADAR service helpers and request lifecycle."""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid


def write_multiframe_dicom(path: Path, *, frames: int = 4, modality: str = "CT") -> None:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2.1"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dataset = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    dataset.SOPClassUID = meta.MediaStorageSOPClassUID
    dataset.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    dataset.Modality = modality
    dataset.NumberOfFrames = frames
    dataset.Rows = 4
    dataset.Columns = 4
    dataset.SamplesPerPixel = 1
    dataset.PhotometricInterpretation = "MONOCHROME2"
    dataset.BitsAllocated = 16
    dataset.BitsStored = 16
    dataset.HighBit = 15
    dataset.PixelRepresentation = 1
    dataset.PixelSpacing = [1.0, 1.0]
    dataset.SliceThickness = 5.0
    dataset.PixelData = np.arange(frames * 16, dtype=np.int16).tobytes()
    dataset.save_as(path, enforce_file_format=True)


def load_service_module():
    path = Path(__file__).resolve().parents[1] / "radar-service" / "app.py"
    spec = importlib.util.spec_from_file_location("radar_service_app", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RadarServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        try:
            import fastapi  # noqa: F401
        except ImportError as exc:
            raise unittest.SkipTest("RADAR service dependencies are not installed") from exc
        os.environ.setdefault("RADAR_API_KEY", "unit-test-key")
        cls.service = load_service_module()

    def test_safe_extract_rejects_parent_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / "bad.zip"
            with zipfile.ZipFile(archive, "w") as handle:
                handle.writestr("../escaped.nii.gz", b"bad")
            with self.assertRaisesRegex(ValueError, "unsafe archive member"):
                self.service.safe_extract(archive, Path(temp) / "output")

    def test_cleanup_removes_only_expired_inactive_requests(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            expired = root / ("a" * 32)
            active = root / ("b" * 32)
            current = root / ("c" * 32)
            for path in (expired, active, current):
                path.mkdir()
            os.utime(expired, (1, 1))
            os.utime(active, (1, 1))
            self.service.runtime.active_request_id = active.name
            with patch.object(self.service, "WORK_ROOT", root), patch.object(
                self.service, "RETENTION_SECONDS", 300
            ):
                removed = self.service.cleanup_expired_requests(now=1000)
            self.assertEqual(removed, 1)
            self.assertFalse(expired.exists())
            self.assertTrue(active.exists())
            self.assertTrue(current.exists())
            self.service.runtime.active_request_id = ""

    def test_request_id_validation(self) -> None:
        self.assertTrue(self.service.re_full_request_id("a" * 32))
        self.assertFalse(self.service.re_full_request_id("A" * 32))
        self.assertFalse(self.service.re_full_request_id("../" + "a" * 29))

    def test_noncontrast_chest_ct_sets_both_domain_flags(self) -> None:
        self.assertEqual(
            self.service.domain_flags("noncontrast chest CT"),
            [
                "anatomic_region_outside_primary_training_domain",
                "contrast_phase_unverified_or_noncontrast",
            ],
        )

    def test_authorize_requires_exact_bearer_key(self) -> None:
        from starlette.requests import Request

        allowed = Request(
            {"type": "http", "headers": [(b"authorization", b"Bearer unit-test-key")]}
        )
        denied = Request(
            {"type": "http", "headers": [(b"authorization", b"Bearer wrong")]}
        )
        with patch.object(self.service, "API_KEY", "unit-test-key"):
            self.service.authorize(allowed)
            with self.assertRaises(self.service.HTTPException) as raised:
                self.service.authorize(denied)
        self.assertEqual(raised.exception.status_code, 401)

    def test_save_upload_removes_partial_file_via_caller_cleanup_contract(self) -> None:
        class AsyncUpload:
            def __init__(self):
                self.chunks = iter((b"12345", b""))

            async def read(self, _size):
                return next(self.chunks)

        async def exercise():
            upload = AsyncUpload()
            with tempfile.TemporaryDirectory() as temp:
                destination = Path(temp) / "upload"
                with patch.object(self.service, "MAX_UPLOAD_BYTES", 4):
                    with self.assertRaises(self.service.HTTPException) as raised:
                        await self.service.save_upload(upload, destination)
                self.assertEqual(raised.exception.status_code, 413)
                self.assertTrue(destination.exists())
                self.service._remove_path(destination)
                self.assertFalse(destination.exists())

        import asyncio

        asyncio.run(exercise())

    def test_guard_rejects_chunked_oversize_body_before_downstream(self) -> None:
        async def exercise():
            downstream_completed = False

            async def downstream(_scope, receive, _send):
                nonlocal downstream_completed
                await receive()
                downstream_completed = True

            messages = iter(
                [
                    {"type": "http.request", "body": b"12345", "more_body": False},
                ]
            )
            sent = []

            async def receive():
                return next(messages)

            async def send(message):
                sent.append(message)

            scope = {
                "type": "http",
                "path": "/v1/analyze",
                "headers": [(b"authorization", b"Bearer unit-test-key")],
                "state": {},
            }
            middleware = self.service.RadarGuardMiddleware(downstream)
            with patch.object(self.service, "API_KEY", "unit-test-key"), patch.object(
                self.service, "MAX_UPLOAD_BYTES", 4
            ), patch.object(self.service, "MAX_MULTIPART_OVERHEAD_BYTES", 0):
                await middleware(scope, receive, send)

            self.assertFalse(downstream_completed)
            self.assertEqual(sent[0]["status"], 413)
            self.assertFalse(self.service.runtime.lock.locked())

        import asyncio

        asyncio.run(exercise())

    def test_guard_rejects_concurrent_request_without_reading_body(self) -> None:
        async def exercise():
            receive_called = False

            async def downstream(_scope, _receive, _send):
                self.fail("busy request reached downstream")

            async def receive():
                nonlocal receive_called
                receive_called = True
                return {"type": "http.request", "body": b"", "more_body": False}

            sent = []

            async def send(message):
                sent.append(message)

            scope = {
                "type": "http",
                "path": "/v1/analyze",
                "headers": [(b"authorization", b"Bearer unit-test-key")],
            }
            await self.service.runtime.lock.acquire()
            try:
                middleware = self.service.RadarGuardMiddleware(downstream)
                with patch.object(self.service, "API_KEY", "unit-test-key"):
                    await middleware(scope, receive, send)
                self.assertEqual(sent[0]["status"], 429)
                self.assertFalse(receive_called)
            finally:
                self.service.runtime.lock.release()

        import asyncio

        asyncio.run(exercise())

    def test_stage_inputs_rejects_4d_and_over_budget_nifti(self) -> None:
        import nibabel as nib
        import numpy as np

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            four_d = root / "four-d.nii.gz"
            small = root / "small.nii.gz"
            nib.save(nib.Nifti1Image(np.zeros((2, 2, 2, 2)), np.eye(4)), four_d)
            nib.save(
                nib.Nifti1Image(np.zeros((2, 2, 2)), np.diag([1.0, 1.0, 5.0, 1.0])),
                small,
            )

            with self.assertRaisesRegex(ValueError, "3D volume"):
                self.service.stage_inputs(four_d, root / "stage-4d", 1)

            globals_ = self.service.stage_inputs.__globals__
            with patch.dict(globals_, {"MAX_NIFTI_VOXELS": 7}):
                with self.assertRaisesRegex(ValueError, "voxel count"):
                    self.service.stage_inputs(small, root / "stage-large", 1)
            with patch.dict(globals_, {"MAX_RADAR_GPU_WORKING_BYTES": 100}):
                with self.assertRaisesRegex(ValueError, "mask working set"):
                    self.service.stage_inputs(small, root / "stage-gpu-budget", 1)

    def test_stage_inputs_rejects_unsafe_radar_resampling_geometry(self) -> None:
        import nibabel as nib
        import numpy as np

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            extreme_spacing = root / "extreme-spacing.nii.gz"
            axis_permutation = root / "axis-permutation.nii.gz"
            nib.save(
                nib.Nifti1Image(np.zeros((2, 2, 2)), np.diag([1e9, 1e9, 1e9, 1.0])),
                extreme_spacing,
            )
            nib.save(
                nib.Nifti1Image(
                    np.zeros((2, 2, 2)),
                    np.array(
                        [
                            [0.0, 1.0, 0.0, 0.0],
                            [1.0, 0.0, 0.0, 0.0],
                            [0.0, 0.0, 1.0, 0.0],
                            [0.0, 0.0, 0.0, 1.0],
                        ]
                    ),
                ),
                axis_permutation,
            )

            with self.assertRaisesRegex(ValueError, "resampled voxel count"):
                self.service.stage_inputs(extreme_spacing, root / "stage-spacing", 1)
            with self.assertRaisesRegex(ValueError, "axis-aligned"):
                self.service.stage_inputs(axis_permutation, root / "stage-permutation", 1)

    def test_stage_inputs_converts_single_multiframe_ct_to_nifti(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "abdomen.dcm"
            write_multiframe_dicom(source, frames=5)

            manifest = self.service.stage_inputs(source, root / "stage", 1)

            self.assertEqual(len(manifest), 1)
            self.assertEqual(manifest[0]["kind"], "dicom-multiframe")
            self.assertEqual(manifest[0]["frame_count"], 5)
            self.assertEqual(manifest[0]["header"]["shape"], [4, 4, 5])
            self.assertTrue((root / "stage" / manifest[0]["staged_file"]).is_file())

    def test_stage_inputs_rejects_single_frame_or_non_ct_dicom(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            single = root / "single.dcm"
            mr = root / "mr.dcm"
            write_multiframe_dicom(single, frames=1)
            write_multiframe_dicom(mr, frames=5, modality="MR")

            with self.assertRaisesRegex(ValueError, "at least 3 frames"):
                self.service.stage_inputs(single, root / "stage-single", 1)
            with self.assertRaisesRegex(ValueError, "Modality=CT"):
                self.service.stage_inputs(mr, root / "stage-mr", 1)


if __name__ == "__main__":
    unittest.main()
