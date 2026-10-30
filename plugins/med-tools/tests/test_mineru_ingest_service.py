from __future__ import annotations

import concurrent.futures
import json
import tempfile
import textwrap
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from server import mineru_ingest as mineru_ingest_module
from server.mineru_ingest import (
    DEFAULT_CPU_THREADS_ENV,
    DEFAULT_DEVICE_ENV,
    INGEST_ROOT_ENV,
    MAX_WORKERS_ENV,
    MCP_TRANSPORT_ENV,
    MinerUIngestService,
)
from server.rag.mineru_runtime import MINERU_LAUNCHER_ENV, MINERU_MODEL_ROOT_ENV


class MinerUIngestServiceTests(unittest.TestCase):
    def _environment(self, home: Path, **values: str) -> dict[str, str]:
        environment = {"PILOT_HOME": str(home)}
        environment.update(values)
        return environment

    def _fake_mineru(self, home: Path) -> Path:
        script = home / "fake-mineru"
        script.write_text(
            textwrap.dedent(
                """\
                #!/bin/sh
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
                printf '# fake mineru output\\n' > "$parsed/$stem.md"
                printf '{"model": "fake"}\\n' > "$parsed/${stem}_model.json"
                printf 'image-a' > "$parsed/images/figure-a.jpg"
                cat > "$parsed/${stem}_content_list.json" <<'JSON'
                [
                  {"type": "text", "text": "第一章 总论", "text_level": 1, "page_idx": 0},
                  {"type": "text", "text": "图 1-1 示意图显示处理流程。正文继续。", "page_idx": 0},
                  {
                    "type": "image",
                    "img_path": "images/figure-a.jpg",
                    "image_caption": ["图 1-1 示意图"],
                    "page_idx": 0
                  }
                ]
                JSON
                """
            ),
            encoding="utf-8",
        )
        script.chmod(0o700)
        return script

    def _service(self, home: Path, *, fake: Path | None = None) -> MinerUIngestService:
        environment = self._environment(
            home,
            **(
                {
                    MINERU_LAUNCHER_ENV: str(fake),
                    MINERU_MODEL_ROOT_ENV: str(home / "models"),
                }
                if fake
                else {}
            ),
        )
        if fake:
            (home / "models").mkdir()
        return MinerUIngestService(environment=environment)

    def test_health_uses_user_scoped_default_root_and_reports_missing_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            service = self._service(home)
            payload = service.health()
            self.assertFalse(payload["ok"])
            self.assertEqual(
                service.output_root,
                (home / "med-tools" / "mineru-ingest").resolve(),
            )
            self.assertFalse(service.output_root.exists())
            self.assertEqual(payload["batching"]["max_workers"], 1)
            self.assertIn(".pdf", payload["supported_inputs"])
            self.assertIn(".docx", payload["supported_inputs"])
            self.assertIn(".txt", payload["supported_inputs"])

    def test_health_reports_configured_bounded_queue(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            service = MinerUIngestService(
                environment=self._environment(
                    home,
                    **{
                        MAX_WORKERS_ENV: "2",
                        MCP_TRANSPORT_ENV: "streamable-http",
                    },
                )
            )
            payload = service.health()
            self.assertEqual(payload["transport"], "streamable-http")
            self.assertEqual(payload["batching"]["execution"], "bounded_worker_queue")
            self.assertEqual(payload["batching"]["max_workers"], 2)

    def test_default_device_comes_from_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            service = MinerUIngestService(
                environment=self._environment(home, **{DEFAULT_DEVICE_ENV: "cuda"})
            )
            request = service._make_request(pdf_path=str(home / "notes.txt"))
            self.assertEqual(request.device, "cuda")

    def test_sync_ingest_text_writes_normalized_artifacts_without_mineru(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            source = home / "notes.txt"
            source.write_text("第一章 现场救护\n\n控制大出血优先，然后处理气道。", encoding="utf-8")
            service = self._service(home)
            result = service.run_sync(
                pdf_path=str(source),
                book_id="text-book",
                title="文本资料",
                include_samples=True,
            )
            self.assertEqual(result["status"], "succeeded")
            manifest = json.loads(Path(result["manifest_path"]).read_text(encoding="utf-8"))
            self.assertEqual(manifest["source_documents"][0]["document_id"], "text-book")
            self.assertEqual(manifest["source_documents"][0]["input_type"], "txt")
            self.assertFalse(manifest["mineru"]["used"])
            chunks = [
                json.loads(line)
                for line in Path(result["artifact_paths"]["chunks_jsonl"])
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(chunks[0]["content_type"], "text")
            self.assertIn("控制大出血优先", chunks[0]["contents"])
            pages = [
                json.loads(line)
                for line in Path(result["artifact_paths"]["pages_jsonl"])
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(pages[0]["text_chunk_ids"], pages[0]["chunk_ids"])
            self.assertTrue(service.validate(result["job_id"])["ok"])

    def test_artifacts_use_user_relative_source_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            source = home / "notes.txt"
            source.write_text("不应泄露绝对路径。", encoding="utf-8")
            service = self._service(
                home,
            )
            result = service.run_sync(
                pdf_path=str(source),
                book_id="relative-paths",
                include_samples=True,
            )
            self.assertEqual(
                result["manifest"]["source_documents"][0]["source_path"],
                "notes.txt",
            )
            self.assertEqual(
                result["samples"][0]["source_file"],
                "notes.txt",
            )

    def test_sync_ingest_docx_uses_ooxml_text_extraction(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            source = home / "manual.docx"
            self._minimal_docx(source, ["第一段内容", "第二段内容"])
            result = self._service(home).run_sync(
                pdf_path=str(source), book_id="docx-book", title="DOCX资料"
            )
            manifest = json.loads(Path(result["manifest_path"]).read_text(encoding="utf-8"))
            self.assertEqual(manifest["parser"]["name"], "docx_ooxml_text")
            chunks = [
                json.loads(line)
                for line in Path(result["artifact_paths"]["chunks_jsonl"])
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertIn("第一段内容", chunks[0]["text"])
            self.assertIn("第二段内容", chunks[0]["text"])

    def test_text_chunks_do_not_exceed_configured_max_chars(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            source = home / "long.txt"
            source.write_text("a" * 190 + "\n\n" + "b" * 190, encoding="utf-8")
            result = self._service(home).run_sync(
                pdf_path=str(source),
                book_id="long",
                max_chars=200,
                overlap_chars=40,
            )
            chunks = [
                json.loads(line)
                for line in Path(result["artifact_paths"]["chunks_jsonl"])
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertTrue(chunks)
            self.assertTrue(all(len(chunk["text"]) <= 200 for chunk in chunks))

    def test_sync_ingest_pdf_writes_assets_pages_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            source = home / "book.pdf"
            source.write_bytes(b"%PDF-1.4\nfake\n")
            fake = self._fake_mineru(home)
            service = self._service(home, fake=fake)
            result = service.run_sync(
                pdf_path=str(source),
                book_id="sample-book",
                title="示例教材",
                cpu_threads=2,
                include_samples=True,
            )
            self.assertEqual(result["status"], "succeeded")
            manifest = json.loads(Path(result["manifest_path"]).read_text(encoding="utf-8"))
            self.assertFalse(manifest["embedding"]["ready"])
            self.assertEqual(manifest["quality"]["report_path"], "quality_report.json")
            chunks = [
                json.loads(line)
                for line in Path(result["artifact_paths"]["chunks_jsonl"])
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(chunks[0]["doc_id"], "sample-book")
            self.assertTrue(chunks[0]["image_refs"][0]["path"].startswith("assets/"))
            self.assertTrue(chunks[0]["image_refs"][0]["available"])
            self.assertNotIn("source_path", chunks[0]["image_refs"][0])
            assets = [
                json.loads(line)
                for line in Path(result["artifact_paths"]["assets_jsonl"])
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(len(assets), 1)
            self.assertTrue((Path(result["manifest_path"]).parent / assets[0]["path"]).is_file())
            self.assertEqual(assets[0]["figure_no"], "图1-1")
            self.assertTrue(service.validate(result["job_id"])["ok"])

    def test_same_input_reuses_success_and_force_creates_new_job(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            source = home / "notes.txt"
            source.write_text("可复用内容。", encoding="utf-8")
            service = self._service(home)
            first = service.run_sync(pdf_path=str(source), book_id="same")
            second = service.submit(pdf_path=str(source), book_id="same")
            self.assertEqual(second["job_id"], first["job_id"])
            forced = service.submit(pdf_path=str(source), book_id="same", force=True)
            self.assertNotEqual(forced["job_id"], first["job_id"])
            for _ in range(100):
                if service.status(forced["job_id"])["status"] not in {"queued", "running"}:
                    break
                time.sleep(0.01)
            self.assertEqual(service.status(forced["job_id"])["status"], "succeeded")

    def test_instantly_completed_future_is_not_left_registered(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            source = home / "instant.txt"
            source.write_text("瞬时完成任务。", encoding="utf-8")
            service = self._service(home)

            class InstantExecutor:
                def submit(self, function, *args):
                    future = concurrent.futures.Future()
                    try:
                        function(*args)
                    except BaseException as exc:
                        future.set_exception(exc)
                    else:
                        future.set_result(None)
                    return future

            with mock.patch.object(service, "_executor", return_value=InstantExecutor()):
                result = service.submit(pdf_path=str(source), book_id="instant")
            try:
                with mineru_ingest_module._LOCK:
                    self.assertNotIn(result["job_id"], mineru_ingest_module._FUTURES)
            finally:
                with mineru_ingest_module._LOCK:
                    mineru_ingest_module._FUTURES.pop(result["job_id"], None)
                    mineru_ingest_module._FUTURE_ROOTS.pop(result["job_id"], None)

    def test_batch_supports_text_and_partial_success(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            source_a = home / "a.md"
            source_b = home / "b.txt"
            source_a.write_text("# A\n\n止血内容", encoding="utf-8")
            source_b.write_text("气道内容", encoding="utf-8")
            service = self._service(home)
            submitted = service.submit_batch(
                documents=[
                    {"source_path": str(source_a), "book_id": "doc-a"},
                    {"path": str(source_b), "book_id": "doc-b"},
                    {"path": str(home / "missing.txt"), "book_id": "bad"},
                ],
                force_jobs=True,
            )
            status = self._wait_batch(service, submitted["batch_id"])
            self.assertEqual(status["status"], "partial_failed")
            self.assertEqual(status["counts"]["succeeded"], 2)
            result = service.batch_result(status["batch_id"])
            self.assertFalse(result["bundle"]["built"])
            partial = service.batch_result(status["batch_id"], allow_partial=True)
            self.assertTrue(partial["bundle"]["built"])
            self.assertTrue(partial["bundle"]["partial"])

    def test_pdf_batch_builds_merged_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            source_a = home / "book-a.pdf"
            source_b = home / "book-b.pdf"
            source_a.write_bytes(b"%PDF A")
            source_b.write_bytes(b"%PDF B")
            fake = self._fake_mineru(home)
            service = self._service(home, fake=fake)
            submitted = service.submit_batch(
                documents=[
                    {"path": str(source_a), "book_id": "book-a"},
                    {"path": str(source_b), "book_id": "book-b"},
                ],
                force_jobs=True,
            )
            status = self._wait_batch(service, submitted["batch_id"])
            self.assertEqual(status["status"], "succeeded")
            result = service.batch_result(status["batch_id"], include_samples=True)
            self.assertTrue(result["bundle"]["validation"]["ok"])
            self.assertEqual(result["bundle"]["counts"]["source_documents"], 2)
            self.assertEqual(len(result["samples"]), 2)

    def test_path_and_identifier_traversal_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            other = Path(temp_dir) / "user-8"
            home.mkdir()
            other.mkdir()
            source = other / "private.txt"
            source.write_text("private", encoding="utf-8")
            service = self._service(home)
            with self.assertRaises(PermissionError):
                service.submit(pdf_path=str(source))
            with self.assertRaises(ValueError):
                service.status("../job")
            with self.assertRaises(ValueError):
                service.batch_status("../batch")

    def test_batch_rejection_does_not_echo_an_external_source_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            other = Path(temp_dir) / "user-8"
            home.mkdir()
            other.mkdir()
            source = other / "private.txt"
            source.write_text("private", encoding="utf-8")
            result = self._service(home).submit_batch(
                documents=[{"source_path": str(source), "book_id": "private"}],
                force_jobs=True,
            )
            item = result["items"][0]
            self.assertEqual(item["source_path"], "")
            self.assertNotIn(str(other), json.dumps(result, ensure_ascii=False))

    def test_restarted_service_does_not_claim_old_job_is_live(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "user-7"
            home.mkdir()
            service = self._service(home)
            job_id = "job-" + "a" * 24
            job_dir = service.output_root / "jobs" / job_id
            job_dir.mkdir(parents=True)
            (job_dir / "job.json").write_text(
                json.dumps(
                    {
                        "job_id": job_id,
                        "status": "running",
                        "phase": "mineru_parse",
                        "job_dir": str(job_dir),
                    }
                ),
                encoding="utf-8",
            )
            restarted = self._service(home)
            status = restarted.status(job_id)
            self.assertFalse(status["live"])
            self.assertIn("restarted", status["warning"])

    def _wait_batch(self, service: MinerUIngestService, batch_id: str) -> dict:
        for _ in range(200):
            status = service.batch_status(batch_id)
            if status["status"] != "running":
                return status
            time.sleep(0.02)
        self.fail(f"batch did not finish: {batch_id}")

    def _minimal_docx(self, path: Path, paragraphs: list[str]) -> None:
        body = "".join(
            f"<w:p><w:r><w:t>{paragraph}</w:t></w:r></w:p>" for paragraph in paragraphs
        )
        document_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body>{body}</w:body></w:document>"
        )
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("word/document.xml", document_xml)


if __name__ == "__main__":
    unittest.main()
