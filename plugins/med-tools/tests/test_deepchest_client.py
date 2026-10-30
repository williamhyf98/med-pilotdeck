import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from server.deepchest import DeepChestClient


class ClientTests(unittest.TestCase):
    def test_legacy_nifti_filename_uploads_with_valid_extension(self):
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"job_id": "a" * 32, "status": "queued"})

        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "chest.nii(2).gz"
            source.write_bytes(b"test")
            with patch.dict(os.environ, {
                "MED_DEEPCHEST_API_BASE": "http://127.0.0.1:18130",
                "MED_DEEPCHEST_API_KEY": "test",
            }, clear=True):
                with DeepChestClient(transport=httpx.MockTransport(respond)) as client:
                    result = client.submit(str(source), "分析", "chest", "CT", "HU")
            self.assertEqual(result["job_id"], "a" * 32)
            self.assertIn(b'filename="chest(2).nii.gz"', requests[0].content)

    def test_remote_http_without_key_or_certificate(self):
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"ready": True})

        with patch.dict(
            os.environ,
            {
                "MED_DEEPCHEST_API_BASE": "http://10.0.0.1:18130",
                "MED_DEEPCHEST_CA_BUNDLE": "/nonexistent/certificate.crt",
            },
            clear=True,
        ):
            with DeepChestClient(transport=httpx.MockTransport(respond)) as client:
                self.assertTrue(client.health()["ready"])
        self.assertEqual(str(requests[0].url), "http://10.0.0.1:18130/health")
        self.assertNotIn("Authorization", requests[0].headers)

    def test_optional_key_is_sent_when_configured(self):
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"ready": True})

        with patch.dict(os.environ, {
            "MED_DEEPCHEST_API_BASE": "http://10.0.0.1:18130",
            "MED_DEEPCHEST_API_KEY": "test",
        }, clear=True):
            with DeepChestClient(transport=httpx.MockTransport(respond)) as client:
                self.assertTrue(client.health()["ready"])
        self.assertEqual(requests[0].headers["Authorization"], "Bearer test")

    def test_invalid_url_and_configured_empty_key_are_rejected(self):
        with patch.dict(
            os.environ,
            {"MED_DEEPCHEST_API_BASE": "https://localhost:18130", "MED_DEEPCHEST_API_KEY_FILE": "/nonexistent/key"},
            clear=True,
        ):
            with self.assertRaises(OSError):
                DeepChestClient()
        with patch.dict(
            os.environ,
            {"MED_DEEPCHEST_API_BASE": "ftp://10.0.0.1:18130", "MED_DEEPCHEST_API_KEY": "test"},
            clear=True,
        ):
            with self.assertRaises(ValueError):
                DeepChestClient()

    def test_result_saves_only_to_trusted_output_root_and_checks_case_id(self):
        job_id = "a" * 32

        def response(request):
            if request.url.path.endswith("/result"):
                return httpx.Response(
                    200, json={"case_id": job_id, "report": "中文报告", "evidence": {}}
                )
            return httpx.Response(200, json={"job_id": job_id, "status": "succeeded"})

        with tempfile.TemporaryDirectory() as temp:
            with patch.dict(
                os.environ,
                {
                    "MED_DEEPCHEST_API_BASE": "http://127.0.0.1:18130",
                    "MED_DEEPCHEST_API_KEY": "test",
                    "MED_DEEPCHEST_OUTPUT_DIR": temp,
                },
                clear=True,
            ):
                with DeepChestClient(transport=httpx.MockTransport(response)) as client:
                    result = client.inspect(job_id)
                    self.assertEqual(result["report"], "中文报告")
                    self.assertTrue((Path(temp) / job_id / "report.md").is_file())
                    self.assertEqual(
                        json.loads((Path(temp) / job_id / "result.json").read_text())[
                            "case_id"
                        ],
                        job_id,
                    )
                    with self.assertRaises(ValueError):
                        client.inspect("../escape")

    def test_directory_upload_refuses_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            private = root / "private"
            private.write_text("do not upload")
            series = root / "series"
            series.mkdir()
            (series / "image.dcm").symlink_to(private)
            with patch.dict(
                os.environ,
                {
                    "MED_DEEPCHEST_API_BASE": "http://127.0.0.1:18130",
                    "MED_DEEPCHEST_API_KEY": "test",
                },
                clear=True,
            ):
                with DeepChestClient() as client:
                    with self.assertRaises(ValueError):
                        client.submit(str(series), "分析", "chest", "CT", "HU")
