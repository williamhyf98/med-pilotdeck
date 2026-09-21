"""Patient binding, upload geometry, and leak-free evidence contracts."""

import csv
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import nibabel as nib
import numpy as np

from deepchest_service.inputs import prepare_input, extract_archive
from deepchest_service.evidence import build_evidence, build_messages


class DeepChestTests(unittest.TestCase):
    def test_dicom_series_checks_geometry_and_converts_hu(self):
        from pydicom.dataset import FileDataset, FileMetaDataset
        from pydicom.uid import ExplicitVRLittleEndian, generate_uid, CTImageStorage

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            series = root / "series"
            series.mkdir()
            uid = generate_uid()
            for z in range(16):
                meta = FileMetaDataset()
                meta.MediaStorageSOPClassUID = CTImageStorage
                meta.MediaStorageSOPInstanceUID = generate_uid()
                meta.TransferSyntaxUID = ExplicitVRLittleEndian
                d = FileDataset(
                    str(series / f"{z}.dcm"), {}, file_meta=meta, preamble=b"\0" * 128
                )
                d.SOPClassUID = CTImageStorage
                d.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
                d.SeriesInstanceUID = uid
                d.Modality = "CT"
                d.BodyPartExamined = "CHEST"
                d.Rows = d.Columns = 16
                d.ImagePositionPatient = [0, 0, z * 2]
                d.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
                d.PixelSpacing = [1, 1]
                d.SliceThickness = 2
                d.RescaleSlope = 1
                d.RescaleIntercept = -1024
                d.RescaleType = "HU"
                d.SamplesPerPixel = 1
                d.PhotometricInterpretation = "MONOCHROME2"
                d.BitsAllocated = d.BitsStored = 16
                d.HighBit = 15
                d.PixelRepresentation = 0
                d.PixelData = np.full((16, 16), 24, dtype=np.uint16).tobytes()
                d.save_as(series / f"{z}.dcm", enforce_file_format=True)
            archive = root / "series.zip"
            with zipfile.ZipFile(archive, "w") as z:
                for p in series.iterdir():
                    z.write(p, p.name)
            job = root / ("b" * 32)
            job.mkdir()
            binding = prepare_input(archive, job, "chest", "CT", "HU")
            image = nib.load(job / binding["volume"])
            self.assertEqual(image.shape, (16, 16, 16))
            self.assertEqual(nib.aff2axcodes(image.affine), ("L", "P", "S"))
            self.assertTrue(np.all(image.get_fdata() == -1000))
            # Omitting an interior slice must fail instead of silently stacking it.
            archive2 = root / "incomplete.zip"
            with zipfile.ZipFile(archive2, "w") as z:
                for p in series.iterdir():
                    if p.name != "8.dcm":
                        z.write(p, p.name)
            job2 = root / ("c" * 32)
            job2.mkdir()
            with self.assertRaises(ValueError):
                prepare_input(archive2, job2, "chest", "CT", "HU")

    def test_uploaded_volume_is_copied_under_job_id_without_evaluation_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "patient-name.nii.gz"
            nib.save(
                nib.Nifti1Image(
                    np.zeros((24, 24, 24), dtype=np.int16),
                    np.diag([-1.0, -1.0, 1.0, 1.0]),
                ),
                source,
            )
            job = root / ("a" * 32)
            job.mkdir()
            result = prepare_input(source, job, "chest", "CT", "HU")
            target = job / "volumes/upload/img" / ("a" * 32 + ".nii.gz")
            self.assertTrue(target.is_file())
            self.assertFalse(target.is_symlink())
            self.assertEqual(result["case_id"], "a" * 32)
            self.assertEqual(len(result["sha256"]), 64)
            with (job / "case.csv").open() as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows, [{"Image ID": "a" * 32, "dataset": "upload"}])
            self.assertNotIn("patient-name", json.dumps(result))

    def test_nifti_requires_explicit_ct_chest_hu_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for context in [
                ("unknown", "CT", "HU"),
                ("chest", "MR", "HU"),
                ("chest", "CT", "unknown"),
            ]:
                with self.subTest(context=context), self.assertRaises(ValueError):
                    prepare_input(root / "file.nii", root / ("a" * 32), *context)

    def test_volume_rejects_single_slice_and_non_axial_geometry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for shape, affine in [
                ((24, 24, 1), np.eye(4)),
                (
                    (24, 24, 24),
                    np.array(
                        [[1, 0.3, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
                    ),
                ),
            ]:
                source = root / "bad.nii"
                nib.save(
                    nib.Nifti1Image(np.zeros(shape, dtype=np.int16), affine), source
                )
                with self.assertRaises(ValueError):
                    prepare_input(source, root / ("a" * 32), "chest", "CT", "HU")

    def test_zip_rejects_traversal_and_expanded_size_before_extracting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "bad.zip"
            for name, data in [("../escape", b"bad"), ("scan.dcm", b"x" * 30)]:
                with zipfile.ZipFile(archive, "w") as handle:
                    handle.writestr(name, data)
                with self.assertRaises(ValueError):
                    extract_archive(archive, root / "output", max_bytes=20)
            self.assertFalse((root / "escape").exists())

    def test_evidence_rejects_other_case_and_missing_stages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for stage in ("global", "detail", "detail_slice"):
                (root / stage).mkdir()
                (root / stage / "case.json").write_text(
                    json.dumps({"image_id": "wrong", "organs": {}})
                )
            with self.assertRaisesRegex(ValueError, "case"):
                build_evidence(root, "case")

    def test_evidence_keeps_scores_and_slice_coordinates_but_not_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            organs = {
                "lung": {
                    "mask_available": True,
                    "lesion": {
                        "global_probability": 0.55,
                        "sections": [{"section_index": 2, "probability": 0.6}],
                        "top_slices": [{"slice_index": 239, "probability": 0.7}],
                    },
                }
            }
            for stage in ("global", "detail", "detail_slice"):
                (root / stage).mkdir()
                data = {
                    "image_id": "case",
                    "organs": (
                        {"lung": {"lesion": 0.4}} if stage == "global" else organs
                    ),
                    "gt_answer": "secret-label",
                }
                (root / stage / "case.json").write_text(json.dumps(data))
            evidence = build_evidence(root, "case")
            rendered = json.dumps(evidence)
            self.assertNotIn("secret-label", rendered)
            self.assertIn("239", rendered)
            self.assertEqual(evidence["global"]["lung"]["lesion"], 0.4)
            messages = build_messages("请分析胸部影像", evidence)
            self.assertEqual(messages[0]["role"], "system")
            self.assertIn("请分析胸部影像", messages[1]["content"])


if __name__ == "__main__":
    unittest.main()
