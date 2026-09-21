import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from server.deepchest import DeepChestClient


class ClientTests(unittest.TestCase):
    def test_rejects_insecure_remote_and_missing_credentials(self):
        with patch.dict(
            os.environ,
            {
                "MED_DEEPCHEST_API_BASE": "http://10.0.0.1:18130",
                "MED_DEEPCHEST_API_KEY": "test",
            },
            clear=True,
        ):
            with self.assertRaises(ValueError):
                DeepChestClient()
        with patch.dict(
            os.environ,
            {"MED_DEEPCHEST_API_BASE": "https://localhost:18130"},
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
