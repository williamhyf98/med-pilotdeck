"""Metadata-only DICOM routing tests."""

from __future__ import annotations

import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import patch

try:
    import pydicom
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid
except ImportError as exc:  # pragma: no cover - handled by the plugin venv
    raise unittest.SkipTest("pydicom is not installed") from exc

from server.dicom_router import route_dicom, route_image


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


def write_renderable_head_dicom(path: Path) -> None:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dataset = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    dataset.Modality = "CT"
    dataset.BodyPartExamined = "HEAD"
    dataset.StudyDescription = "HEAD CT"
    dataset.SeriesInstanceUID = generate_uid()
    dataset.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    dataset.InstanceNumber = 1
    dataset.Rows = dataset.Columns = 2
    dataset.SamplesPerPixel = 1
    dataset.PhotometricInterpretation = "MONOCHROME2"
    dataset.BitsAllocated = dataset.BitsStored = 16
    dataset.HighBit = 15
    dataset.PixelRepresentation = 0
    dataset.PixelData = bytes([0, 0, 128, 0, 255, 0, 64, 0])
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

    def test_other_complete_ct_dicom_uses_general_parser_when_enabled(self) -> None:
        for body in ("HEAD", "NECK", "SPINE", "EXTREMITY"):
            with self.subTest(body=body), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                series = generate_uid()
                for index in range(1, 4):
                    write_dicom(root / f"{index}.dcm", modality="CT", body=body,
                                series_uid=series, instance=index)
                with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                    result = route_image(root)
                self.assertTrue(result["is_complete_3d_series"])
                self.assertEqual(result["recommended_skill"], "med-medical")
                self.assertEqual(result["recommended_tool"], "mcp__med-tools__med_parse_medical")
                self.assertEqual(result["route_mode"], "general-medical")
                self.assertEqual(result["candidate_skills"], ["med-medical"])
                self.assertEqual(result["specialized_support"], "not-applicable")

    def test_head_dicom_route_can_be_followed_by_actual_parse(self) -> None:
        from server.app import _prepare_medical_parse

        for suffix in (".dcm", ".dicom", ".ima", "", ".bin"):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / f"scan{suffix}"
                write_renderable_head_dicom(path)
                with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                    route = route_image(path)
                self.assertEqual(route["recommended_tool"], "mcp__med-tools__med_parse_medical")
                parsed = _prepare_medical_parse(path=str(path), skip_vlm=True)
                self.assertEqual(parsed["status"], "ready")
                self.assertEqual(len(parsed["items"]), 1)
                self.assertEqual(parsed["items"][0]["kind"], "dicom")
                self.assertTrue(parsed["items"][0]["included"])
                self.assertTrue(parsed["png_paths"])

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


class ImageRouterTests(unittest.TestCase):
    @staticmethod
    def volume(path: Path, shape=(24, 24, 24), affine=None) -> None:
        import nibabel as nib
        import numpy as np

        nib.save(nib.Nifti1Image(np.zeros(shape, dtype=np.int16), np.eye(4) if affine is None else affine), path)

    def test_abdominal_nifti_routes_to_radar_with_contrast_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "volume.nii.gz"
            self.volume(path)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                result = route_image(path, modality="CT", body_region="abdomen")
        self.assertEqual(result["recommended_skill"], "med-radar-ct")
        self.assertEqual(result["recommended_tool"], "mcp__med-tools__med_radar_analyze_ct")
        self.assertEqual(result["volumes"][0]["shape"], [24, 24, 24])
        json.dumps(result)
        self.assertTrue(result["is_3d_volume"])
        self.assertIsNone(result["is_complete_3d_series"])
        self.assertEqual(result["route_mode"], "radar")
        self.assertTrue(result["domain_flags"])

    def test_explicit_radar_allows_unknown_region_but_not_unknown_modality(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "study.nii"
            self.volume(path)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                unknown = route_image(path, requested_model="radar")
                confirmed = route_image(path, modality="CT", requested_model="radar")
        self.assertIsNone(unknown["recommended_tool"])
        self.assertIn("modality", unknown["required_context"])
        self.assertEqual(confirmed["route_mode"], "radar")
        self.assertEqual(confirmed["specialized_support"], "domain-unverified")
        self.assertEqual(confirmed["body_region"], "unknown")

    def test_explicit_radar_keeps_unknown_dicom_on_general_parser(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            series = generate_uid()
            for index in range(1, 4):
                write_dicom(root / f"{index}.dcm", modality="CT", body="",
                            series_uid=series, instance=index)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                result = route_image(root, requested_model="radar")
        self.assertEqual(result["recommended_skill"], "med-medical")
        self.assertEqual(result["recommended_tool"], "mcp__med-tools__med_parse_medical")
        self.assertEqual(result["route_mode"], "general-medical")

    def test_explicit_radar_does_not_override_chest_dicom(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            series = generate_uid()
            for index in range(1, 4):
                write_dicom(
                    root / f"{index}.dcm", modality="CT", body="CHEST",
                    series_uid=series, instance=index,
                )
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                default = route_image(root)
                explicit = route_image(root, requested_model="radar")
        self.assertEqual(default["recommended_skill"], "med-deepchest-3dmedagent")
        self.assertEqual(explicit["recommended_skill"], "med-deepchest-3dmedagent")
        self.assertEqual(explicit["recommended_tool"], "mcp__med-tools__med_deepchest_submit")
        self.assertEqual(explicit["status"], "degraded")
        self.assertTrue(any("不能提交给 RADAR" in warning for warning in explicit["warnings"]))

    def test_explicit_deepchest_does_not_recommend_radar_for_abdominal_dicom(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            series = generate_uid()
            for index in range(1, 4):
                write_dicom(
                    root / f"{index}.dcm", modality="CT", body="ABDOMEN",
                    series_uid=series, instance=index,
                )
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                result = route_image(root, requested_model="deepchest")
        self.assertEqual(result["route_mode"], "radar")
        self.assertEqual(result["recommended_skill"], "med-radar-ct")
        self.assertEqual(result["recommended_tool"], "mcp__med-tools__med_radar_analyze_ct")
        self.assertTrue(any("不能提交给 DeepChest" in warning for warning in result["warnings"]))

    def test_explicit_specialized_model_keeps_other_dicom_parseable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            series = generate_uid()
            for index in range(1, 4):
                write_dicom(root / f"{index}.dcm", modality="CT", body="HEAD",
                            series_uid=series, instance=index)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                for model in ("radar", "deepchest"):
                    with self.subTest(model=model):
                        result = route_image(root, requested_model=model)
                        self.assertEqual(result["recommended_skill"], "med-medical")
                        self.assertEqual(result["recommended_tool"], "mcp__med-tools__med_parse_medical")
                        self.assertTrue(result["warnings"])

    def test_known_non_ct_does_not_route_to_specialized_model(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "study.nii"
            self.volume(path)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                result = route_image(path, modality="MR", requested_model="radar")
        self.assertEqual(result["route_mode"], "incompatible")
        self.assertIsNone(result["recommended_tool"])

    def test_chest_nifti_requires_hu_for_deepchest(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "study.nii.gz"
            self.volume(path)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                missing = route_image(path, modality="CT", body_region="chest")
                confirmed = route_image(
                    path, modality="CT", body_region="chest", intensity_units="HU"
                )
        self.assertIsNone(missing["recommended_tool"])
        self.assertIn("intensity_units", missing["required_context"])
        self.assertEqual(confirmed["recommended_skill"], "med-deepchest-3dmedagent")
        self.assertEqual(confirmed["recommended_tool"], "mcp__med-tools__med_deepchest_submit")

    def test_too_thin_nifti_cannot_route_to_deepchest(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "thin.nii.gz"
            self.volume(path, (24, 24, 8))
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                result = route_image(path, modality="CT", body_region="chest", intensity_units="HU")
        self.assertEqual(result["route_mode"], "incompatible")
        self.assertIsNone(result["recommended_tool"])
        self.assertTrue(any("16" in warning for warning in result["warnings"]))

    def test_chest_nifti_with_confirmed_non_hu_units_is_incompatible(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "study.nii.gz"
            self.volume(path)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                result = route_image(path, modality="CT", body_region="chest", intensity_units="OTHER")
        self.assertEqual(result["route_mode"], "incompatible")
        self.assertIsNone(result["recommended_tool"])
        self.assertEqual(result["required_context"], [])

    def test_radar_rejects_axis_permutation_but_deepchest_accepts_it(self) -> None:
        import numpy as np

        affine = np.eye(4)
        affine[:3, :3] = [[0, 1, 0], [1, 0, 0], [0, 0, 1]]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "permuted.nii.gz"
            self.volume(path, affine=affine)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                radar = route_image(path, modality="CT", body_region="abdomen")
                deepchest = route_image(path, modality="CT", body_region="chest", intensity_units="HU")
        self.assertEqual(radar["route_mode"], "incompatible")
        self.assertIsNone(radar["recommended_tool"])
        self.assertEqual(deepchest["route_mode"], "deepchest")

    def test_radar_rejects_nifti_that_resamples_to_empty_dimension(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "thin.nii.gz"
            self.volume(path, (24, 24, 3))
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                result = route_image(path, modality="CT", body_region="abdomen")
        self.assertEqual(result["route_mode"], "incompatible")
        self.assertIsNone(result["recommended_tool"])

    def test_oblique_nifti_cannot_route_to_deepchest(self) -> None:
        import numpy as np

        affine = np.eye(4)
        affine[:2, :2] = [[0.8, -0.6], [0.6, 0.8]]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "oblique.nii.gz"
            self.volume(path, affine=affine)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                result = route_image(path, modality="CT", body_region="chest", intensity_units="HU")
        self.assertEqual(result["route_mode"], "incompatible")
        self.assertIsNone(result["recommended_tool"])

    def test_unknown_region_and_disabled_switch_never_fallback_to_general_parser(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "ct.nii.gz"
            self.volume(path)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                unknown = route_image(path, modality="CT")
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "0"}):
                disabled = route_image(path, modality="CT", body_region="abdomen")
        for result in (unknown, disabled):
            self.assertIsNone(result["recommended_tool"])
            self.assertIsNone(result["recommended_skill"])
        self.assertIn("body_region", unknown["required_context"])
        self.assertEqual(disabled["route_mode"], "disabled")

    def test_invalid_and_mixed_nifti_input_does_not_route(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "bad.nii.gz"
            path.write_bytes(b"not nifti")
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                invalid = route_image(path, modality="CT", body_region="abdomen")
                self.volume(root / "other.nii", (24, 24, 1))
                mixed = route_image(root, modality="CT", body_region="abdomen")
        self.assertEqual(invalid["route_mode"], "invalid-input")
        self.assertIsNone(invalid["recommended_tool"])
        self.assertEqual(mixed["route_mode"], "ambiguous-input")
        self.assertIsNone(mixed["recommended_tool"])

    def test_large_other_file_still_marks_nifti_directory_as_mixed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.volume(root / "scan.nii.gz")
            with (root / "another.dcm").open("wb") as handle:
                handle.truncate(257 * 1024**2)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                result = route_image(root, modality="CT", body_region="abdomen")
        self.assertEqual(result["route_mode"], "ambiguous-input")
        self.assertIsNone(result["recommended_tool"])

    def test_missing_nifti_never_recommends_general_parser(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            result = route_image(Path(temp) / "missing.nii.gz")
        self.assertEqual(result["status"], "error")
        self.assertIsNone(result["recommended_skill"])

    def test_legacy_renamed_nifti_routes_from_header(self) -> None:
        import shutil
        import nibabel as nib
        import numpy as np

        for image_type in (nib.Nifti1Image, nib.Nifti2Image):
            with self.subTest(image_type=image_type.__name__), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / "study.nii(1).gz"
                original = Path(temp) / "study.nii.gz"
                nib.save(image_type(np.zeros((24, 24, 24), dtype=np.int16), np.eye(4)), original)
                shutil.copyfile(original, path)
                with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                    result = route_image(path, modality="CT", body_region="abdomen")
            self.assertEqual(result["route_mode"], "radar")
            self.assertEqual(result["recommended_tool"], "mcp__med-tools__med_radar_analyze_ct")

    def test_dicom_branch_keeps_existing_route(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            series = generate_uid()
            for index in range(1, 4):
                write_dicom(root / f"{index}.dcm", modality="CT", body="ABDOMEN",
                            series_uid=series, instance=index)
            with patch.dict("os.environ", {"MED_SPECIALIZED_CT_ENABLED": "1"}):
                result = route_image(root)
        self.assertEqual(result["tool"], "med_image_route")
        self.assertEqual(result["recommended_skill"], "med-radar-ct")


if __name__ == "__main__":
    unittest.main()
