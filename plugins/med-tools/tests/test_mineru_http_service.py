from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from mineru_service.app import create_app


class MinerUHTTPServiceTests(unittest.TestCase):
    def _headers(self, token: str = "test-token") -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    def _success_runner(self, job: Path) -> None:
        manifest = {
            "schema_version": "mineru-ingest-chunks-v1",
            "corpus_id": job.name,
            "source_documents": [],
            "parser": {"name": "fake-mineru"},
            "artifacts": {
                "chunks_path": "corpus/chunks.jsonl",
                "pages_path": "corpus/pages.jsonl",
                "assets_path": "corpus/assets.jsonl",
                "assets_dir": "assets",
            },
            "quality": {"report_path": "quality_report.json"},
        }
        files = {
            "manifest.json": json.dumps(manifest, ensure_ascii=False).encode(),
            "quality_report.json": b'{"ok": true}',
            "corpus/chunks.jsonl": b'{"chunk_id":"c1","text":"hello"}\n',
            "corpus/pages.jsonl": b'{"page_id":"p1","page":1}\n',
            "corpus/assets.jsonl": b'{"asset_id":"a1","path":"assets/aa/asset.txt","sha256":"'
            + hashlib.sha256(b"asset").hexdigest().encode()
            + b'","bytes":5}\n',
            "assets/aa/asset.txt": b"asset",
            "mineru_raw/doc/ocr/doc.md": b"# Parsed\n",
            "mineru_raw/doc/ocr/doc_content_list.json": b"[]",
            "mineru_raw/doc/ocr/doc_model.json": b"{}",
        }
        for relative, content in files.items():
            path = job / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        (job / "result.json").write_text(
            json.dumps(
                {
                    "manifest": manifest,
                    "artifacts": [
                        {
                            "path": relative,
                            "sha256": hashlib.sha256(content).hexdigest(),
                            "bytes": len(content),
                        }
                        for relative, content in files.items()
                    ],
                }
            ),
            encoding="utf-8",
        )

    def _wait_for_status(
        self, client: TestClient, job_id: str, headers: dict[str, str]
    ) -> dict:
        value = {}
        for _ in range(100):
            response = client.get(f"/v1/mineru/jobs/{job_id}", headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            value = response.json()
            if value["status"] not in {"uploading", "queued", "running"}:
                return value
            time.sleep(0.01)
        self.fail(f"job did not finish: {value}")

    def test_health_exposes_runtime_queue_and_storage_checks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app = create_app(
                Path(temp_dir),
                api_tokens={"test-token": "tenant-a"},
                runtime_environment={
                    "MED_RAG_MINERU_LAUNCHER": "/missing/python -m mineru.cli.client",
                    "MED_RAG_MINERU_MODEL_ROOT": str(Path(temp_dir) / "models"),
                },
            )
            with TestClient(app) as client:
                response = client.get("/health", headers=self._headers())

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["ok"])
        self.assertIn("runtime", payload)
        self.assertIn("queue", payload)
        self.assertIn("storage", payload)
        self.assertIn("cuda", payload)
        self.assertNotIn(temp_dir, response.text)

    def test_missing_or_wrong_credentials_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app = create_app(Path(temp_dir), api_tokens={"test-token": "tenant-a"})
            with TestClient(app) as client:
                self.assertEqual(client.get("/health").status_code, 401)
                self.assertEqual(
                    client.get("/health", headers=self._headers("wrong")).status_code,
                    401,
                )

    def test_upload_validation_rejects_empty_unsupported_and_oversized_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app = create_app(
                Path(temp_dir),
                api_tokens={"test-token": "tenant-a"},
                max_upload_bytes=4,
            )
            with TestClient(app) as client:
                headers = self._headers()
                self.assertEqual(
                    client.post(
                        "/v1/mineru/jobs",
                        headers=headers,
                        files={"file": ("empty.pdf", b"")},
                    ).status_code,
                    422,
                )
                self.assertEqual(
                    client.post(
                        "/v1/mineru/jobs",
                        headers=headers,
                        files={"file": ("input.exe", b"x")},
                    ).status_code,
                    422,
                )
                self.assertEqual(
                    client.post(
                        "/v1/mineru/jobs",
                        headers=headers,
                        files={"file": ("input.pdf", b"12345")},
                    ).status_code,
                    413,
                )

    def test_successful_job_exposes_only_registered_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app = create_app(
                Path(temp_dir),
                api_tokens={"test-token": "tenant-a"},
                runner=self._success_runner,
            )
            with TestClient(app) as client:
                response = client.post(
                    "/v1/mineru/jobs",
                    headers=self._headers(),
                    files={"file": ("source.pdf", b"%PDF-1.4 sample")},
                    data={"title": "sample", "max_chars": "1200"},
                )
                self.assertEqual(response.status_code, 202, response.text)
                submitted = response.json()
                self.assertEqual(submitted["status"], "queued")
                job_id = submitted["job_id"]
                status = self._wait_for_status(client, job_id, self._headers())
                self.assertEqual(status["status"], "succeeded", status)

                result = client.get(
                    f"/v1/mineru/jobs/{job_id}/result", headers=self._headers()
                )
                self.assertEqual(result.status_code, 200, result.text)
                payload = result.json()
                names = {item["path"] for item in payload["artifacts"]}
                self.assertIn("manifest.json", names)
                self.assertIn("corpus/chunks.jsonl", names)
                self.assertIn("mineru_raw/doc/ocr/doc_model.json", names)
                self.assertNotIn(str(Path(temp_dir)), result.text)

                asset = client.get(
                    f"/v1/mineru/jobs/{job_id}/artifacts/assets/aa/asset.txt",
                    headers=self._headers(),
                )
                self.assertEqual(asset.status_code, 200)
                self.assertEqual(asset.content, b"asset")
                self.assertEqual(
                    client.get(
                        f"/v1/mineru/jobs/{job_id}/artifacts/../status.json",
                        headers=self._headers(),
                    ).status_code,
                    404,
                )
                self.assertEqual(
                    client.get(
                        f"/v1/mineru/jobs/{job_id}/artifacts/request.json",
                        headers=self._headers(),
                    ).status_code,
                    404,
                )

                validation = client.get(
                    f"/v1/mineru/jobs/{job_id}/validate", headers=self._headers()
                )
                self.assertEqual(validation.status_code, 200, validation.text)
                self.assertTrue(validation.json()["ok"])

    def test_default_worker_runs_ingest_service_and_hides_node_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fake = root / "fake-mineru"
            fake.write_text(
                """#!/bin/sh
set -eu
source=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) source="$2"; shift 2 ;;
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
stem="$(basename "$source" .pdf)"
parsed="$output/$stem/ocr"
mkdir -p "$parsed/images"
printf '# fake\\n' > "$parsed/$stem.md"
printf '{}' > "$parsed/${stem}_model.json"
printf '[{"type":"text","text":"测试内容","page_idx":0}]' > "$parsed/${stem}_content_list.json"
""",
                encoding="utf-8",
            )
            fake.chmod(0o700)
            models = root / "models"
            models.mkdir()
            (models / "config.json").write_text("{}", encoding="utf-8")
            app = create_app(
                root,
                api_tokens={"test-token": "tenant-a"},
                runtime_environment={
                    "MED_RAG_MINERU_LAUNCHER": str(fake),
                    "MED_RAG_MINERU_MODEL_ROOT": str(models),
                    "MED_RAG_MINERU_DEFAULT_DEVICE": "cuda",
                },
            )
            with TestClient(app) as client:
                response = client.post(
                    "/v1/mineru/jobs",
                    headers=self._headers(),
                    files={"file": ("source.pdf", b"%PDF-1.4 sample")},
                )
                self.assertEqual(response.status_code, 202, response.text)
                job_id = response.json()["job_id"]
                status = self._wait_for_status(client, job_id, self._headers())
                self.assertEqual(status["status"], "succeeded", status)
                result = client.get(
                    f"/v1/mineru/jobs/{job_id}/result", headers=self._headers()
                ).json()

        self.assertEqual(
            result["manifest"]["source_documents"][0]["source_path"],
            "source.pdf",
        )
        self.assertNotIn(str(root), json.dumps(result, ensure_ascii=False))

    def test_tenant_cannot_read_another_tenants_job(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app = create_app(
                Path(temp_dir),
                api_tokens={"a-token": "tenant-a", "b-token": "tenant-b"},
                runner=self._success_runner,
            )
            with TestClient(app) as client:
                submitted = client.post(
                    "/v1/mineru/jobs",
                    headers=self._headers("a-token"),
                    files={"file": ("source.pdf", b"%PDF-1.4 sample")},
                ).json()
                job_id = submitted["job_id"]
                self.assertEqual(
                    client.get(
                        f"/v1/mineru/jobs/{job_id}",
                        headers=self._headers("b-token"),
                    ).status_code,
                    404,
                )
                self.assertEqual(
                    client.get(
                        f"/v1/mineru/jobs/{job_id}/result",
                        headers=self._headers("b-token"),
                    ).status_code,
                    404,
                )

    def test_restart_marks_nonterminal_jobs_failed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            app = create_app(root, api_tokens={"test-token": "tenant-a"})
            with TestClient(app) as client:
                job_id = "a" * 32
                job_dir = root / "tenants" / "tenant-a" / "jobs" / job_id
                job_dir.mkdir(parents=True)
                (job_dir / "status.json").write_text(
                    json.dumps(
                        {
                            "job_id": job_id,
                            "status": "running",
                            "phase": "mineru_parse",
                        }
                    ),
                    encoding="utf-8",
                )
            with TestClient(create_app(root, api_tokens={"test-token": "tenant-a"})) as client:
                status = client.get(
                    f"/v1/mineru/jobs/{job_id}", headers=self._headers()
                ).json()
                self.assertEqual(status["status"], "failed")
                self.assertEqual(status["error_code"], "service_restarted")

    def test_queue_full_and_timeout_are_explicit_failures(self) -> None:
        async def pending(_job: Path) -> None:
            await asyncio.sleep(60)

        with tempfile.TemporaryDirectory() as temp_dir:
            app = create_app(
                Path(temp_dir),
                api_tokens={"test-token": "tenant-a"},
                runner=pending,
                max_jobs=1,
                job_timeout_seconds=0.01,
            )
            with TestClient(app) as client:
                first = client.post(
                    "/v1/mineru/jobs",
                    headers=self._headers(),
                    files={"file": ("first.pdf", b"%PDF-1")},
                )
                self.assertEqual(first.status_code, 202)
                busy = client.post(
                    "/v1/mineru/jobs",
                    headers=self._headers(),
                    files={"file": ("second.pdf", b"%PDF-2")},
                )
                self.assertEqual(busy.status_code, 429)
                status = self._wait_for_status(
                    client, first.json()["job_id"], self._headers()
                )
                self.assertEqual(status["status"], "failed")
                self.assertEqual(status["error_code"], "job_timeout")


if __name__ == "__main__":
    unittest.main()
