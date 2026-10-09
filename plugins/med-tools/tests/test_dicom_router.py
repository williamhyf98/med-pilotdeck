"""Metadata-only DICOM routing tests."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    import pydicom
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid
except ImportError as exc:  # pragma: no cover - handled by the plugin venv
    raise unittest.SkipTest("pydicom is not installed") from exc

from server.dicom_router import route_dicom


def write_dicom(
    path: Path,
    *,
    modality: str,
    body: str,
    series_uid: str,
    instance: int,
    number_of_frames: int | None = None,
) -> None:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dataset = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    dataset.Modality = modality
    dataset.BodyPartExamined = body
    dataset.StudyDescription = f"{body} study"
    dataset.SeriesDescription = f"{body} axial"
    dataset.StudyInstanceUID = generate_uid()
    dataset.SeriesInstanceUID = series_uid
    dataset.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    dataset.InstanceNumber = instance
    if number_of_frames is not None:
        dataset.NumberOfFrames = number_of_frames
    dataset.Rows = 2
    dataset.Columns = 2
    dataset.save_as(path)


class DicomRouterTests(unittest.TestCase):
    def test_chest_ct_falls_back_when_specialized_ct_is_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            series = generate_uid()
            for index in range(1, 4):
                write_dicom(root / f"slice{index}.dcm", modality="CT", body="CHEST", series_uid=series, instance=index)
            result = route_dicom(root)
        self.assertEqual(result["modality"], "CT")
        self.assertEqual(result["body_region"], "chest")
        self.assertTrue(result["is_complete_3d_series"])
        self.assertEqual(result["recommended_skill"], "med-medical")
        self.assertEqual(result["route_mode"], "general-medical")
        self.assertEqual(result["specialized_support"], "not-applicable")
        self.assertFalse(result["requires_main_agent_synthesis"])
        self.assertFalse(result["authorization_required"])
        self.assertTrue(any("RADAR 和 DeepChest" in warning for warning in result["warnings"]))

    def test_head_ct_falls_back_when_specialized_ct_is_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            series = generate_uid()
            for index in range(1, 4):
                write_dicom(
                    root / f"slice{index}.dcm",
                    modality="CT",
                    body="HEAD",
                    series_uid=series,
                    instance=index,
                )
            result = route_dicom(root)

        self.assertEqual(result["body_region"], "head")
        self.assertEqual(result["recommended_skill"], "med-medical")
        self.assertEqual(result["route_mode"], "general-medical")
        self.assertEqual(result["specialized_support"], "not-applicable")
        self.assertFalse(result["domain_flags"])
        self.assertTrue(any("RADAR 和 DeepChest" in warning for warning in result["warnings"]))

    def test_unknown_complete_ct_degrades_to_general_medical(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            series = generate_uid()
            for index in range(1, 4):
                write_dicom(
                    root / f"slice{index}.dcm",
                    modality="CT",
                    body="",
                    series_uid=series,
                    instance=index,
                )
            result = route_dicom(root)

        self.assertTrue(result["is_complete_3d_series"])
        self.assertEqual(result["body_region"], "unknown")
        self.assertEqual(result["recommended_skill"], "med-medical")
        self.assertEqual(result["route_mode"], "general-medical")
        self.assertEqual(result["specialized_support"], "not-applicable")
        self.assertEqual(result["status"], "degraded")
        self.assertTrue(any("检查部位不确定" in warning for warning in result["warnings"]))

    def test_mixed_region_complete_ct_degrades_to_general_medical(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for body in ("CHEST", "HEAD"):
                series = generate_uid()
                for index in range(1, 4):
                    write_dicom(
                        root / f"{body.lower()}-{index}.dcm",
                        modality="CT",
                        body=body,
                        series_uid=series,
                        instance=index,
                    )
            result = route_dicom(root)

        self.assertTrue(result["is_complete_3d_series"])
        self.assertEqual(result["body_region"], "mixed")
        self.assertEqual(result["recommended_skill"], "med-medical")
        self.assertEqual(result["route_mode"], "general-medical")
        self.assertEqual(result["status"], "degraded")
        self.assertTrue(any("检查部位不确定" in warning for warning in result["warnings"]))

    def test_incomplete_non_abdominal_ct_routes_to_general_medical(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "chest-scout.dcm"
            write_dicom(
                path,
                modality="CT",
                body="CHEST",
                series_uid=generate_uid(),
                instance=1,
            )
            result = route_dicom(path)

        self.assertFalse(result["is_complete_3d_series"])
        self.assertEqual(result["recommended_skill"], "med-medical")
        self.assertEqual(result["route_mode"], "general-medical")
        self.assertTrue(any("完整三维序列" in warning for warning in result["warnings"]))

    def test_abdominal_ct_falls_back_when_specialized_ct_is_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            series = generate_uid()
            for index in range(1, 4):
                write_dicom(root / f"slice{index}.dcm", modality="CT", body="ABDOMEN", series_uid=series, instance=index)
            result = route_dicom(root)
        self.assertEqual(result["recommended_skill"], "med-medical")
        self.assertFalse(result["authorization_required"])
        self.assertEqual(result["candidate_skills"], ["med-medical"])
        self.assertEqual(result["recommended_tool"], "mcp__med-tools__med_parse_medical")
        self.assertFalse(result["requires_main_agent_synthesis"])
        self.assertIn("不调用 RADAR 或 DeepChest", result["next_action"])
        self.assertEqual(result["status"], "degraded")
        self.assertTrue(any("RADAR 和 DeepChest" in warning for warning in result["warnings"]))

    def test_single_multiframe_abdominal_ct_falls_back_when_specialized_ct_is_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "abdomen-volume.dcm"
            write_dicom(
                path,
                modality="CT",
                body="ABDOMEN",
                series_uid=generate_uid(),
                instance=1,
                number_of_frames=120,
            )
            result = route_dicom(path)

        self.assertTrue(result["is_complete_3d_series"])
        self.assertEqual(result["frame_count"], 120)
        self.assertEqual(result["recommended_skill"], "med-medical")
        self.assertFalse(result["authorization_required"])
        self.assertEqual(result["recommended_tool"], "mcp__med-tools__med_parse_medical")
        self.assertTrue(any("RADAR 和 DeepChest" in warning for warning in result["warnings"]))

    def test_abdominal_ct_uses_radar_when_explicitly_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            series = generate_uid()
            for index in range(1, 4):
                write_dicom(
                    root / f"slice{index}.dcm",
                    modality="CT",
                    body="ABDOMEN",
                    series_uid=series,
                    instance=index,
                )
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                result = route_dicom(root)

        self.assertEqual(result["recommended_skill"], "med-radar-ct")
        self.assertEqual(result["recommended_tool"], "mcp__med-tools__med_radar_analyze_ct")

    def test_non_ct_routes_to_general_medical(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "mr.dcm"
            write_dicom(path, modality="MR", body="BRAIN", series_uid=generate_uid(), instance=1)
            result = route_dicom(path)
        self.assertEqual(result["modality"], "MR")
        self.assertEqual(result["recommended_skill"], "med-medical")
        self.assertFalse(result["is_complete_3d_series"])

    def test_non_dicom_input_degrades_without_specialized_route(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "not-dicom.txt"
            path.write_text("not a DICOM file", encoding="utf-8")
            result = route_dicom(path)
        self.assertEqual(result["recommended_skill"], "med-medical")
        self.assertEqual(result["dicom_file_count"], 0)
        self.assertTrue(result["warnings"])

    def test_mixed_directory_does_not_route_to_a_specialized_model(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_dicom(root / "ct.dcm", modality="CT", body="CHEST", series_uid=generate_uid(), instance=1)
            write_dicom(root / "mr.dcm", modality="MR", body="BRAIN", series_uid=generate_uid(), instance=1)
            result = route_dicom(root)
        self.assertEqual(result["modality"], "MIXED")
        self.assertEqual(result["recommended_skill"], "med-medical")
        self.assertTrue(any("多个模态" in warning for warning in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
