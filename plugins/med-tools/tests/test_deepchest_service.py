import asyncio
import json
import tempfile
import unittest
import os
import sys
from unittest.mock import patch
from pathlib import Path
from fastapi.testclient import TestClient

from deepchest_service.app import create_app, subprocess_runner


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_terminates_real_worker_process(self):
        original = asyncio.create_subprocess_exec
        processes = []

        async def sleeping_worker(*args, **kwargs):
            process = await original(
                sys.executable, "-c", "import time; time.sleep(60)", **kwargs
            )
            processes.append(process)
            return process

        with tempfile.TemporaryDirectory() as temp:
            with patch.dict(os.environ, {"DEEPCHEST_JOB_TIMEOUT": "1"}), patch(
                "deepchest_service.app.asyncio.create_subprocess_exec", sleeping_worker
            ):
                with self.assertRaises(TimeoutError):
                    await subprocess_runner(Path(temp))
                self.assertIsNotNone(processes[0].returncode)


class ServiceTests(unittest.TestCase):
    def test_requires_auth_before_accepting_upload(self):
        with tempfile.TemporaryDirectory() as temp:
            with TestClient(
                create_app(Path(temp), "test-key", runner=self.succeed)
            ) as client:
                self.assertEqual(client.get("/health").status_code, 401)
                self.assertEqual(
                    client.post("/v1/jobs", content=b"bad").status_code, 401
                )

    @staticmethod
    async def succeed(job):
        (job / "result.json").write_text(
            json.dumps({"report": "本轮中文报告", "case_id": job.name})
        )

    def test_job_result_is_bound_to_id_and_persists(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app = create_app(root, "test-key", runner=self.succeed)
            headers = {"Authorization": "Bearer test-key"}
            with TestClient(app) as client:
                response = client.post(
                    "/v1/jobs",
                    headers=headers,
                    files={"file": ("ct.nii", b"fixture")},
                    data={
                        "question": "分析",
                        "body_region": "chest",
                        "modality": "CT",
                        "intensity_units": "HU",
                    },
                )
                self.assertEqual(response.status_code, 202, response.text)
                job_id = response.json()["job_id"]
                for _ in range(100):
                    status = client.get(f"/v1/jobs/{job_id}", headers=headers).json()
                    if status["status"] == "succeeded":
                        break
                self.assertEqual(status["status"], "succeeded", status)
                result = client.get(f"/v1/jobs/{job_id}/result", headers=headers).json()
                self.assertEqual(result["case_id"], job_id)
                self.assertEqual(result["report"], "本轮中文报告")
                self.assertEqual(
                    client.get("/v1/jobs/not-an-id", headers=headers).status_code, 404
                )
            with TestClient(
                create_app(root, "test-key", runner=self.succeed)
            ) as client:
                self.assertEqual(
                    client.get(f"/v1/jobs/{job_id}", headers=headers).json()["status"],
                    "succeeded",
                )

    def test_restart_marks_interrupted_job_failed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            job = root / ("a" * 32)
            job.mkdir()
            (job / "status.json").write_text(
                json.dumps({"job_id": job.name, "status": "running", "updated_at": 0})
            )
            with TestClient(
                create_app(root, "test-key", runner=self.succeed)
            ) as client:
                value = client.get(
                    f"/v1/jobs/{job.name}", headers={"Authorization": "Bearer test-key"}
                ).json()
                self.assertEqual(value["status"], "failed")
                self.assertEqual(value["error"], "service_restarted")

    def test_overload_and_oversize_do_not_create_unbounded_jobs(self):
        async def pending(job):
            await asyncio.sleep(600)

        with tempfile.TemporaryDirectory() as temp:
            with TestClient(
                create_app(
                    Path(temp), "test-key", runner=pending, max_upload=10, max_jobs=1
                )
            ) as client:
                headers = {"Authorization": "Bearer test-key"}
                data = {
                    "question": "分析",
                    "body_region": "chest",
                    "modality": "CT",
                    "intensity_units": "HU",
                }
                too_large = client.post(
                    "/v1/jobs",
                    headers=headers,
                    data=data,
                    files={"file": ("x.nii", b"x" * 11)},
                )
                self.assertEqual(too_large.status_code, 413)
                good = client.post(
                    "/v1/jobs",
                    headers=headers,
                    data=data,
                    files={"file": ("x.nii", b"x")},
                )
                self.assertEqual(good.status_code, 202)
                busy = client.post(
                    "/v1/jobs",
                    headers=headers,
                    data=data,
                    files={"file": ("x.nii", b"x")},
                )
                self.assertEqual(busy.status_code, 429)

    def test_pipeline_error_is_failure_not_empty_success(self):
        async def failure(job):
            raise ValueError("private input path")

        with tempfile.TemporaryDirectory() as temp:
            with TestClient(
                create_app(Path(temp), "test-key", runner=failure)
            ) as client:
                h = {"Authorization": "Bearer test-key"}
                r = client.post(
                    "/v1/jobs",
                    headers=h,
                    files={"file": ("ct.nii", b"x")},
                    data={
                        "question": "分析",
                        "body_region": "chest",
                        "modality": "CT",
                        "intensity_units": "HU",
                    },
                )
                job_id = r.json()["job_id"]
                for _ in range(100):
                    status = client.get(f"/v1/jobs/{job_id}", headers=h).json()
                    if status["status"] == "failed":
                        break
                self.assertEqual(status["status"], "failed")
                self.assertNotIn("private input", json.dumps(status))
                self.assertEqual(
                    client.get(f"/v1/jobs/{job_id}/result", headers=h).status_code, 409
                )
