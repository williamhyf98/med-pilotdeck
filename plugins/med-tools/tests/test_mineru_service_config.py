from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from mineru_service.config import MinerUServiceConfig
from mineru_service.doctor import runtime_doctor


class MinerUServiceConfigTests(unittest.TestCase):
    def test_config_reads_node12_runtime_and_limits(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            environment = {
                "MINERU_SERVICE_ROOT": str(root),
                "MED_RAG_MINERU_LAUNCHER": '"/opt/mineru/python" -m mineru.cli.client',
                "MED_RAG_MINERU_MODEL_ROOT": str(root / "models"),
                "MED_RAG_MINERU_DEFAULT_DEVICE": "cuda",
                "MED_RAG_MINERU_MAX_WORKERS": "1",
                "MINERU_SERVICE_BIND": "127.0.0.1",
                "MINERU_SERVICE_PORT": "18890",
                "MINERU_SERVICE_MAX_UPLOAD_BYTES": "2147483648",
                "MINERU_SERVICE_JOB_TIMEOUT": "3600",
                "MINERU_SERVICE_MAX_JOBS": "2",
                "MINERU_SERVICE_RETENTION_SECONDS": "86400",
            }
            config = MinerUServiceConfig.from_environment(environment)

        self.assertEqual(config.bind, "127.0.0.1")
        self.assertEqual(config.port, 18890)
        self.assertEqual(config.max_upload_bytes, 2 * 1024**3)
        self.assertEqual(config.max_jobs, 2)
        self.assertEqual(config.job_timeout_seconds, 3600)
        self.assertEqual(config.default_device, "cuda")
        self.assertEqual(
            config.launcher,
            ("/opt/mineru/python", "-m", "mineru.cli.client"),
        )

    def test_config_rejects_multiple_workers_and_non_cuda_server_device(self) -> None:
        with self.assertRaises(ValueError):
            MinerUServiceConfig.from_environment(
                {
                    "MINERU_SERVICE_ROOT": "/tmp/mineru",
                    "MED_RAG_MINERU_LAUNCHER": "/opt/python -m mineru.cli.client",
                    "MED_RAG_MINERU_MODEL_ROOT": "/tmp/models",
                    "MED_RAG_MINERU_MAX_WORKERS": "2",
                }
            )
        with self.assertRaises(ValueError):
            MinerUServiceConfig.from_environment(
                {
                    "MINERU_SERVICE_ROOT": "/tmp/mineru",
                    "MED_RAG_MINERU_LAUNCHER": "/opt/python -m mineru.cli.client",
                    "MED_RAG_MINERU_MODEL_ROOT": "/tmp/models",
                    "MED_RAG_MINERU_DEFAULT_DEVICE": "cpu",
                }
            )

    def test_runtime_doctor_reports_missing_model_and_output_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = MinerUServiceConfig.from_environment(
                {
                    "MINERU_SERVICE_ROOT": str(root / "service"),
                    "MED_RAG_MINERU_LAUNCHER": "/missing/python -m mineru.cli.client",
                    "MED_RAG_MINERU_MODEL_ROOT": str(root / "missing-models"),
                    "MED_RAG_MINERU_DEFAULT_DEVICE": "cuda",
                }
            )
            report = runtime_doctor(config)

        self.assertFalse(report["ok"])
        self.assertFalse(report["runtime"]["launcher_exists"])
        self.assertFalse(report["runtime"]["model_root_exists"])
        self.assertIn("cuda_available", report["cuda"])
        self.assertIn("writable", report["storage"])

    def test_service_env_example_contains_fixed_runtime_contract(self) -> None:
        example = (
            Path(__file__).parents[1]
            / "mineru_service"
            / "service.env.example"
        ).read_text(encoding="utf-8")
        self.assertIn("MED_RAG_MINERU_DEFAULT_DEVICE=cuda", example)
        self.assertIn("MED_RAG_MINERU_MAX_WORKERS=1", example)
        self.assertIn("MINERU_SERVICE_PORT=18890", example)
        self.assertIn("MINERU_SERVICE_MAX_UPLOAD_BYTES=52428800", example)


if __name__ == "__main__":
    unittest.main()
