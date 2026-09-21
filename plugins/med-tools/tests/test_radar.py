"""Unit tests for the node36 RADAR HTTP client."""

from __future__ import annotations

import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

from server import radar


class FakeResponse:
    def __init__(self, payload=None, *, status_code: int = 200, content: bytes = b""):
        self._payload = payload
        self.status_code = status_code
        self.content = content
        self.text = ""

    def json(self):
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "request failed",
                request=httpx.Request("GET", "http://radar.test"),
                response=httpx.Response(self.status_code),
            )


class FakeClient:
    def __init__(self, post_response: FakeResponse, get_response: FakeResponse | None = None):
        self.post_response = post_response
        self.get_response = get_response or FakeResponse(content=b"finding,score\n")
        self.post_calls = []
        self.get_calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        return self.post_response

    def get(self, url, **kwargs):
        self.get_calls.append((url, kwargs))
        return self.get_response


def config(**overrides):
    value = {
        "api_base": "http://radar.test:18120",
        "api_key": "test-secret",
        "timeout_seconds": 840,
        "max_upload_bytes": 1024 * 1024,
    }
    value.update(overrides)
    return value


def write_multiframe_dicom(
    path: Path,
    *,
    frames: int = 4,
    modality: str = "CT",
) -> None:
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
    dataset.PixelData = np.arange(frames * 16, dtype=np.int16).tobytes()
    dataset.save_as(path, enforce_file_format=True)


class RadarClientTests(unittest.TestCase):
    def test_missing_input_fails_without_http_request(self) -> None:
        with patch("httpx.Client") as client:
            payload = radar.run_radar_analysis(path="/tmp/radar-missing-input.nii.gz")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "error")
        client.assert_not_called()

    def test_status_requires_credentials(self) -> None:
        with patch.object(radar, "get_radar_config", return_value=config(api_key="")), patch(
            "httpx.get"
        ) as get:
            payload = radar.radar_status()
        self.assertFalse(payload["ready"])
        self.assertIn("credentials", payload["error"])
        get.assert_not_called()

    def test_status_reports_resident_remote_model(self) -> None:
        response = FakeResponse({"ready": True, "device": "cuda:0", "busy": False})
        with patch.object(radar, "get_radar_config", return_value=config()), patch(
            "httpx.get", return_value=response
        ) as get:
            payload = radar.radar_status(validate_runtime=True)
        self.assertTrue(payload["ready"])
        self.assertEqual(payload["remote"]["device"], "cuda:0")
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer test-secret")
        self.assertEqual(get.call_args.kwargs["timeout"], 30)

    def test_success_uploads_nifti_caps_arguments_and_writes_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            input_path = Path(temp) / "study.nii.gz"
            input_path.write_bytes(b"nifti")
            response = FakeResponse(
                {
                    "ok": True,
                    "status": "completed",
                    "request_id": "a" * 32,
                    "cases": [],
                    "artifacts": {
                        "scores_csv_url": f"/v1/artifacts/{'a' * 32}/scores.csv"
                    },
                }
            )
            client = FakeClient(response, FakeResponse(content=b"file,score\nstudy,0.5\n"))
            with patch.object(radar, "get_radar_config", return_value=config()), patch(
                "httpx.Client", return_value=client
            ):
                payload = radar.run_radar_analysis(
                    path=str(input_path), top_k=500, threshold=2, max_cases=50
                )

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["tool"], "med_radar_analyze_ct")
            self.assertTrue(payload["agent_continue"])
            self.assertEqual(payload["generation_owner"], "pilotdeck")
            sent = client.post_calls[0][1]["data"]
            self.assertEqual(sent["top_k"], "50")
            self.assertEqual(sent["threshold"], "1.0")
            self.assertEqual(sent["max_cases"], "8")
            self.assertEqual(
                client.get_calls[0][0],
                f"http://radar.test:18120/v1/artifacts/{'a' * 32}/scores.csv",
            )
            csv_path = Path(payload["artifacts"]["scores_csv"])
            summary_path = Path(payload["artifacts"]["summary_json"])
            self.assertEqual(csv_path.read_bytes(), b"file,score\nstudy,0.5\n")
            self.assertTrue(summary_path.is_file())
            self.assertEqual(payload["transfer"]["uploaded_bytes"], 5)

    def test_success_uploads_single_multiframe_ct_dicom(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            input_path = Path(temp) / "abdomen.dcm"
            write_multiframe_dicom(input_path, frames=6)
            response = FakeResponse(
                {
                    "ok": True,
                    "status": "completed",
                    "request_id": "b" * 32,
                    "cases": [],
                    "artifacts": {
                        "scores_csv_url": f"/v1/artifacts/{'b' * 32}/scores.csv"
                    },
                }
            )
            client = FakeClient(response, FakeResponse(content=b"file,score\nstudy,0.5\n"))
            with patch.object(radar, "get_radar_config", return_value=config()), patch(
                "httpx.Client", return_value=client
            ):
                payload = radar.run_radar_analysis(path=str(input_path))

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["transfer"]["kind"], "dicom-multiframe")
            self.assertEqual(payload["transfer"]["frame_count"], 6)
            self.assertEqual(payload["transfer"]["matrix"], [4, 4])
            uploaded = client.post_calls[0][1]["files"]["file"]
            self.assertEqual(uploaded[0], "abdomen.dcm")
            self.assertEqual(uploaded[2], "application/dicom")

    def test_project_inbox_input_writes_openable_artifacts_under_exports(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project_root = Path(temp) / "project"
            inbox = project_root / "inbox"
            inbox.mkdir(parents=True)
            input_path = inbox / "study.nii.gz"
            input_path.write_bytes(b"nifti")
            response = FakeResponse(
                {
                    "ok": True,
                    "status": "completed",
                    "request_id": "c" * 32,
                    "cases": [],
                    "artifacts": {
                        "scores_csv_url": f"/v1/artifacts/{'c' * 32}/scores.csv"
                    },
                }
            )
            client = FakeClient(response, FakeResponse(content=b"file,score\nstudy,0.5\n"))
            with patch.object(radar, "get_radar_config", return_value=config()), patch(
                "httpx.Client", return_value=client
            ), patch.dict(os.environ, {"MED_RADAR_OUTPUT_DIR": str(Path(temp) / "global")}, clear=False):
                payload = radar.run_radar_analysis(path=str(input_path))

            csv_path = Path(payload["artifacts"]["scores_csv"])
            summary_path = Path(payload["artifacts"]["summary_json"])
            self.assertTrue(csv_path.is_relative_to(project_root / "exports" / "radar"))
            self.assertTrue(summary_path.is_relative_to(project_root / "exports" / "radar"))
            self.assertTrue(csv_path.is_file())
            self.assertTrue(summary_path.is_file())

    def test_single_frame_dicom_is_rejected_before_upload(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            input_path = Path(temp) / "slice.dcm"
            write_multiframe_dicom(input_path, frames=1)
            with patch.object(radar, "get_radar_config", return_value=config()), patch(
                "httpx.Client"
            ) as client:
                payload = radar.run_radar_analysis(path=str(input_path))

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "unsupported")
        self.assertIn("at least 3 frames", payload["error"])
        client.assert_not_called()

    def test_multiframe_mr_is_rejected_before_upload(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            input_path = Path(temp) / "brain.dcm"
            write_multiframe_dicom(input_path, frames=6, modality="MR")
            with patch.object(radar, "get_radar_config", return_value=config()), patch(
                "httpx.Client"
            ) as client:
                payload = radar.run_radar_analysis(path=str(input_path))

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "unsupported")
        self.assertIn("Modality=CT", payload["error"])
        client.assert_not_called()

    def test_cross_origin_artifact_url_is_rejected_without_sending_key(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            input_path = Path(temp) / "study.nii.gz"
            input_path.touch()
            client = FakeClient(
                FakeResponse(
                    {
                        "ok": True,
                        "artifacts": {"scores_csv_url": "https://evil.test/scores.csv"},
                    }
                )
            )
            with patch.object(radar, "get_radar_config", return_value=config()), patch(
                "httpx.Client", return_value=client
            ):
                payload = radar.run_radar_analysis(path=str(input_path))
            request_dirs = [
                item
                for item in Path(temp).rglob("*")
                if item.is_dir() and len(item.name) == 32
            ]
        self.assertFalse(payload["ok"])
        self.assertIn("non-local artifact URL", payload["error"])
        self.assertEqual(client.get_calls, [])
        self.assertEqual(request_dirs, [])

    def test_directory_discovery_excludes_symlinks_and_non_ct_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ct = root / "ct.ima"
            mr = root / "mr.dcm"
            secret = root / "secret"
            linked = root / "linked.dcm"
            for item in (ct, mr, secret):
                item.write_bytes(b"fixture")
            linked.symlink_to(ct)

            def dcmread(path, **_kwargs):
                name = Path(path).name
                if name == "ct.ima":
                    return types.SimpleNamespace(
                        Modality="CT", SeriesInstanceUID="series-1", SOPClassUID="sop"
                    )
                if name == "mr.dcm":
                    return types.SimpleNamespace(
                        Modality="MR", SeriesInstanceUID="series-2", SOPClassUID="sop"
                    )
                raise ValueError("not DICOM")

            fake_pydicom = types.SimpleNamespace(dcmread=dcmread)
            with patch.dict("sys.modules", {"pydicom": fake_pydicom}):
                files, selection = radar._directory_files(root, max_cases=4)
        self.assertEqual(files, [ct])
        self.assertEqual(selection, {"kind": "dicom", "selected_cases": 1})

    def test_api_key_file_is_supported(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            key_path = Path(temp) / "key"
            key_path.write_text("from-file\n", encoding="utf-8")
            with patch.dict(
                os.environ,
                {"MED_RADAR_API_KEY": "", "MED_RADAR_API_KEY_FILE": str(key_path)},
                clear=False,
            ):
                self.assertEqual(radar.get_radar_config()["api_key"], "from-file")


if __name__ == "__main__":
    unittest.main()
