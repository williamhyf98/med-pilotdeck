from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import httpx

from server.mineru_remote_client import (
    RemoteMinerUClient,
    RemoteMinerUIngestService,
    RemoteMinerUError,
)


class MinerURemoteClientTests(unittest.TestCase):
    def test_upload_uses_multipart_content_without_local_absolute_path(self) -> None:
        requests: list[httpx.Request] = []
        job_id = "a" * 32

        def respond(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                202,
                json={
                    "job_id": job_id,
                    "status": "queued",
                    "source_sha256": hashlib.sha256(b"%PDF").hexdigest(),
                    "input_type": "pdf",
                },
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-a"
            home.mkdir()
            source = home / "document.pdf"
            source.write_bytes(b"%PDF")
            token_file = home / "token"
            token_file.write_text("test-token\n", encoding="utf-8")
            environment = {
                "PILOT_HOME": str(home),
                "MED_RAG_MINERU_API_BASE": "http://127.0.0.1:18890",
                "MED_RAG_MINERU_API_TOKEN_FILE": str(token_file),
            }
            with RemoteMinerUClient(environment=environment, transport=httpx.MockTransport(respond)) as client:
                response = client.submit_file(source, {"title": "测试"})

        self.assertEqual(response["job_id"], job_id)
        self.assertIn(b'filename="document.pdf"', requests[0].content)
        self.assertNotIn(str(source).encode(), requests[0].content)
        self.assertEqual(requests[0].headers["authorization"], "Bearer test-token")

    def test_missing_remote_configuration_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            with self.assertRaises(ValueError):
                RemoteMinerUClient(
                    environment={
                        "PILOT_HOME": str(home),
                        "MED_RAG_MINERU_API_BASE": "http://10.31.112.13:18890",
                    }
                )
            with self.assertRaises(ValueError):
                RemoteMinerUClient(
                    environment={
                        "PILOT_HOME": str(home),
                        "MED_RAG_MINERU_API_BASE": "http://10.31.112.13:18890",
                        "MED_RAG_MINERU_API_TOKEN": "secret",
                    }
                )

    def test_plain_http_is_limited_to_loopback_for_ssh_tunnel(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaises(ValueError):
                RemoteMinerUClient(
                    environment={
                        "PILOT_HOME": temp_dir,
                        "MED_RAG_MINERU_API_BASE": "http://10.31.112.13:18890",
                        "MED_RAG_MINERU_API_TOKEN": "secret",
                    }
                )

    def test_service_maps_remote_result_and_does_not_redownload_bundle(self) -> None:
        requests: list[httpx.Request] = []
        job_id = "b" * 32
        manifest = {
            "schema_version": "mineru-ingest-chunks-v1",
            "source_documents": [{"source_path": "document.pdf"}],
            "artifacts": {
                "chunks_path": "corpus/chunks.jsonl",
                "pages_path": "corpus/pages.jsonl",
                "assets_path": "corpus/assets.jsonl",
                "assets_dir": "assets",
            },
        }
        files = {
            "manifest.json": json.dumps(manifest).encode(),
            "quality_report.json": b"{}",
            "corpus/chunks.jsonl": b'{"chunk_id":"c1","text":"text"}\n',
            "corpus/pages.jsonl": b'{"page_id":"p1","page":1}\n',
            "corpus/assets.jsonl": b"",
        }
        descriptors = [
            {"path": name, "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
            for name, content in files.items()
        ]

        def respond(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.method == "POST":
                return httpx.Response(
                    202,
                    json={
                        "job_id": job_id,
                        "status": "queued",
                        "source_sha256": hashlib.sha256(b"%PDF").hexdigest(),
                        "input_type": "pdf",
                    },
                )
            if request.url.path.endswith("/validate"):
                return httpx.Response(200, json={"ok": True, "job_id": job_id})
            if request.url.path.endswith("/result"):
                return httpx.Response(
                    200,
                    json={
                        "job_id": job_id,
                        "status": "succeeded",
                        "source_sha256": hashlib.sha256(b"%PDF").hexdigest(),
                        "input_type": "pdf",
                        "manifest": manifest,
                        "artifacts": descriptors,
                    },
                )
            if "/artifacts/" in request.url.path:
                name = request.url.path.split("/artifacts/", 1)[1]
                return httpx.Response(200, content=files[name])
            return httpx.Response(
                200,
                json={
                    "job_id": job_id,
                    "status": "succeeded",
                    "source_sha256": hashlib.sha256(b"%PDF").hexdigest(),
                    "input_type": "pdf",
                },
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-a"
            home.mkdir()
            source = home / "document.pdf"
            source.write_bytes(b"%PDF")
            environment = {
                "PILOT_HOME": str(home),
                "MED_RAG_MINERU_INGEST_ROOT": str(home / "ingest"),
                "MED_RAG_MINERU_API_BASE": "http://127.0.0.1:18890",
                "MED_RAG_MINERU_API_TOKEN": "test-token",
            }
            with RemoteMinerUClient(
                environment=environment, transport=httpx.MockTransport(respond)
            ) as client:
                service = RemoteMinerUIngestService(client=client, environment=environment)
                submitted = service.submit(pdf_path=str(source), title="测试")
                self.assertEqual(submitted["status"], "succeeded")
                first = service.result(submitted["job_id"])
                second = service.result(submitted["job_id"])
                self.assertEqual(first["manifest"]["schema_version"], "mineru-ingest-chunks-v1")
                self.assertEqual(second["status"], "succeeded")
                self.assertTrue(service.validate(submitted["job_id"])["ok"])

            artifact_requests = [
                request for request in requests if "/artifacts/" in request.url.path
            ]
            self.assertEqual(len(artifact_requests), len(files))

    def test_http_errors_are_converted_without_server_paths(self) -> None:
        def respond(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(413, json={"detail": "Upload too large"})

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "document.pdf"
            source.write_bytes(b"%PDF")
            with RemoteMinerUClient(
                environment={
                    "PILOT_HOME": str(root),
                    "MED_RAG_MINERU_API_BASE": "http://127.0.0.1:18890",
                    "MED_RAG_MINERU_API_TOKEN": "test-token",
                },
                transport=httpx.MockTransport(respond),
            ) as client:
                with self.assertRaises(RemoteMinerUError) as context:
                    client.submit_file(source, {})
        self.assertEqual(context.exception.status_code, 413)
        self.assertNotIn(str(root), str(context.exception))


if __name__ == "__main__":
    unittest.main()
