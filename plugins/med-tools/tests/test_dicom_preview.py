"""DICOM preview renderer tests (local only, no network)."""

from __future__ import annotations

import base64
import io
import tempfile
import unittest
from pathlib import Path

try:
    import numpy as np
    import pydicom
    from PIL import Image
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage, generate_uid
except ImportError as exc:  # pragma: no cover - dependency guard
    raise unittest.SkipTest(f"DICOM preview dependencies are unavailable: {exc}") from exc

from server.dicom_preview import _selected_indices, _window_values, preview_dicom


def write_dicom(path: Path, pixels: np.ndarray | None, *, modality: str = "CT") -> None:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dataset = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    dataset.SOPClassUID = meta.MediaStorageSOPClassUID
    dataset.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    dataset.Modality = modality
    dataset.BodyPartExamined = "CHEST"
    dataset.RescaleSlope = 2
    dataset.RescaleIntercept = -1000
    if pixels is not None:
        dataset.Rows = int(pixels.shape[-2])
        dataset.Columns = int(pixels.shape[-1])
        dataset.SamplesPerPixel = 1
        dataset.PhotometricInterpretation = "MONOCHROME2"
        dataset.BitsAllocated = 16
        dataset.BitsStored = 16
        dataset.HighBit = 15
        dataset.PixelRepresentation = 1
        if pixels.ndim == 3:
            dataset.NumberOfFrames = pixels.shape[0]
        dataset.PixelData = pixels.astype(np.int16).tobytes()
    dataset.save_as(str(path), enforce_file_format=True)


class DicomPreviewTests(unittest.TestCase):
    def test_single_frame_png_and_safe_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "single.dcm"
            write_dicom(path, np.arange(64, dtype=np.int16).reshape(8, 8))
            result = preview_dicom(path)

        self.assertTrue(result["ok"])
        self.assertEqual(result["modality"], "CT")
        self.assertEqual(result["bodyPart"], "CHEST")
        self.assertEqual(result["totalFrames"], 1)
        self.assertEqual(result["selectedFrames"], [0])
        self.assertNotIn("path", result)
        image = Image.open(io.BytesIO(base64.b64decode(result["frames"][0]["data"])))
        self.assertEqual(image.size, (8, 8))

    def test_multiframe_is_uniformly_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "multi.dcm"
            pixels = np.arange(240 * 4 * 4, dtype=np.int16).reshape(240, 4, 4)
            write_dicom(path, pixels)
            result = preview_dicom(path, max_frames=12, metadata_only=True)

        self.assertTrue(result["ok"])
        self.assertEqual(result["totalFrames"], 240)
        self.assertEqual(len(result["selectedFrames"]), 12)
        self.assertEqual(result["selectedFrames"][0], 0)
        self.assertEqual(result["selectedFrames"][-1], 239)
        self.assertEqual(result["frames"], [])

    def test_missing_pixels_returns_metadata_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "metadata-only.dcm"
            write_dicom(path, None, modality="MR")
            result = preview_dicom(path, metadata_only=True)

        self.assertFalse(result["ok"])
        self.assertFalse(result["pixelDataAvailable"])
        self.assertEqual(result["modality"], "MR")
        self.assertTrue(result["warnings"])

    def test_invalid_file_degrades_without_binary_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "invalid.dcm"
            path.write_bytes(b"not a dicom")
            result = preview_dicom(path)

        self.assertFalse(result["ok"])
        self.assertEqual(result["frames"], [])
        self.assertNotIn("path", result)

    def test_rescale_is_applied_before_windowing(self) -> None:
        dataset = type("Dataset", (), {
            "RescaleSlope": 2,
            "RescaleIntercept": -1000,
            "WindowCenter": 0,
            "WindowWidth": 2000,
        })()
        scaled = _window_values(np.asarray([0, 500, 1000], dtype=np.int16), dataset)
        self.assertEqual(scaled.tolist(), [0, 127, 255])

    def test_selected_indices_caps_untrusted_frame_count(self) -> None:
        indices = _selected_indices(10_000, 1_000)
        self.assertEqual(len(indices), 24)
        self.assertEqual(indices[0], 0)
        self.assertEqual(indices[-1], 9_999)

    def test_custom_response_limit_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "bounded.dcm"
            write_dicom(path, np.arange(64, dtype=np.int16).reshape(8, 8))
            result = preview_dicom(path, max_total_bytes=1)

        self.assertFalse(result["ok"])
        self.assertEqual(result["frames"], [])
        self.assertTrue(any("超过限制" in warning for warning in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
