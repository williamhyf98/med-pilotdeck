from __future__ import annotations

import json
import tempfile
import textwrap
import time
import unittest
import zipfile
from pathlib import Path

from server.mineru_ingest import (
    DEFAULT_CPU_THREADS_ENV,
    INGEST_ROOT_ENV,
    MAX_WORKERS_ENV,
    MCP_TRANSPORT_ENV,
    MinerUIngestService,
)
from server.rag.mineru_runtime import MINERU_LAUNCHER_ENV, MINERU_MODEL_ROOT_ENV


class MinerUIngestServiceTests(unittest.TestCase):
    def _fake_mineru(self, root: Path) -> Path:
        script = root / "fake-mineru"
        script.write_text(
            textwrap.dedent(
                """\
                #!/bin/sh
                set -eu
                source=""
                output=""
                while [ "$#" -gt 0 ]; do
                  case "$1" in
                    -p)
                      source="$2"
                      shift 2
                      ;;
                    -o)
                      output="$2"
                      shift 2
                      ;;
                    *)
                      shift
                      ;;
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

    def test_health_reports_missing_runtime_without_creating_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_root = Path(temp_dir) / "missing-yet"
            service = MinerUIngestService(
                output_root=output_root,
                environment={INGEST_ROOT_ENV: str(output_root)},
            )
            payload = service.health()
            self.assertFalse(payload["ok"])
            self.assertFalse(output_root.exists())
            self.assertFalse(payload["runtime"]["configured"])
            self.assertIn(".pdf", payload["supported_inputs"])
            self.assertIn(".docx", payload["supported_inputs"])
            self.assertIn(".txt", payload["supported_inputs"])

    def test_health_reports_configured_bounded_queue(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_root = Path(temp_dir) / "ingest"
            service = MinerUIngestService(
                output_root=output_root,
                environment={
                    INGEST_ROOT_ENV: str(output_root),
                    MAX_WORKERS_ENV: "2",
                    MCP_TRANSPORT_ENV: "streamable-http",
                },
            )
            payload = service.health()
            self.assertEqual(payload["transport"], "streamable-http")
            self.assertEqual(payload["batching"]["execution"], "bounded_worker_queue")
            self.assertEqual(payload["batching"]["max_workers"], 2)
            self.assertEqual(payload["batching"]["running_jobs"], 0)
            self.assertEqual(payload["batching"]["queued_jobs"], 0)

    def test_sync_ingest_text_writes_normalized_artifacts_without_mineru_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "notes.txt"
            source.write_text("第一章 现场救护\n\n控制大出血优先，然后处理气道。", encoding="utf-8")
            service = MinerUIngestService(output_root=root / "ingest", environment={})

            result = service.run_sync(
                pdf_path=str(source),
                book_id="text-book",
                title="文本资料",
                include_samples=True,
            )

            self.assertEqual(result["status"], "succeeded")
            manifest_path = Path(result["manifest_path"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["source_documents"][0]["document_id"], "text-book")
            self.assertEqual(manifest["source_documents"][0]["input_type"], "txt")
            self.assertFalse(manifest["mineru"]["used"])
            self.assertEqual(manifest["parser"]["input_type"], "txt")
            chunks = [
                json.loads(line)
                for line in Path(result["artifact_paths"]["chunks_jsonl"]).read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(len(chunks), 1)
            self.assertEqual(chunks[0]["content_type"], "text")
            self.assertEqual(chunks[0]["page_start"], 1)
            self.assertIn("控制大出血优先", chunks[0]["contents"])
            validation = service.validate(result["job_id"])
            self.assertTrue(validation["ok"], validation)

    def test_sync_ingest_docx_uses_ooxml_text_extraction(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "manual.docx"
            self._minimal_docx(source, ["第一段内容", "第二段内容"])
            service = MinerUIngestService(output_root=root / "ingest", environment={})

            result = service.run_sync(
                pdf_path=str(source),
                book_id="docx-book",
                title="DOCX资料",
                include_samples=True,
            )

            self.assertEqual(result["status"], "succeeded")
            manifest = json.loads(Path(result["manifest_path"]).read_text(encoding="utf-8"))
            self.assertEqual(manifest["source_documents"][0]["input_type"], "docx")
            self.assertEqual(manifest["parser"]["name"], "docx_ooxml_text")
            chunks = [
                json.loads(line)
                for line in Path(result["artifact_paths"]["chunks_jsonl"]).read_text(encoding="utf-8").splitlines()
            ]
            self.assertIn("第一段内容", chunks[0]["text"])
            self.assertIn("第二段内容", chunks[0]["text"])

    def test_sync_ingest_writes_normalized_artifacts_and_validates(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"%PDF-1.4\nfake\n")
            model_root = root / "models"
            model_root.mkdir()
            fake = self._fake_mineru(root)
            service = MinerUIngestService(
                output_root=root / "ingest",
                environment={
                    MINERU_LAUNCHER_ENV: str(fake),
                    MINERU_MODEL_ROOT_ENV: str(model_root),
                    DEFAULT_CPU_THREADS_ENV: "2",
                },
            )
            result = service.run_sync(
                pdf_path=str(source),
                book_id="sample-book",
                title="示例教材",
                include_samples=True,
            )
            self.assertEqual(result["status"], "succeeded")
            manifest_path = Path(result["manifest_path"])
            self.assertTrue(manifest_path.is_file())
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["embedding"]["ready"], False)
            self.assertEqual(manifest["source_documents"][0]["document_id"], "sample-book")

            chunks_path = Path(result["artifact_paths"]["chunks_jsonl"])
            chunks = [json.loads(line) for line in chunks_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(chunks), 1)
            self.assertEqual(chunks[0]["doc_id"], "sample-book")
            self.assertTrue(chunks[0]["image_refs"][0]["path"].startswith("assets/"))
            self.assertTrue(chunks[0]["image_refs"][0]["available"])
            self.assertNotIn("source_path", chunks[0]["image_refs"][0])
            self.assertIn("相关图示：图 1-1 示意图", chunks[0]["contents"])

            assets_path = Path(result["artifact_paths"]["assets_jsonl"])
            assets = [json.loads(line) for line in assets_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(assets), 1)
            self.assertTrue((manifest_path.parent / assets[0]["path"]).is_file())
            self.assertEqual(assets[0]["figure_no"], "图1-1")
            validation = service.validate(result["job_id"])
            self.assertTrue(validation["ok"], validation)
            self.assertEqual(validation["counts"]["chunks"], 1)
            self.assertEqual(validation["counts"]["assets"], 1)

    def test_partial_ingest_defaults_page_offset_to_start_page(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"%PDF-1.4\nfake\n")
            model_root = root / "models"
            model_root.mkdir()
            fake = self._fake_mineru(root)
            service = MinerUIngestService(
                output_root=root / "ingest",
                environment={
                    MINERU_LAUNCHER_ENV: str(fake),
                    MINERU_MODEL_ROOT_ENV: str(model_root),
                },
            )
            result = service.run_sync(
                pdf_path=str(source),
                book_id="partial-book",
                start_page=549,
                end_page=549,
            )
            manifest_path = Path(result["manifest_path"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            chunks_path = Path(result["artifact_paths"]["chunks_jsonl"])
            chunks = [json.loads(line) for line in chunks_path.read_text(encoding="utf-8").splitlines()]
            pages_path = Path(result["artifact_paths"]["pages_jsonl"])
            pages = [json.loads(line) for line in pages_path.read_text(encoding="utf-8").splitlines()]

            self.assertEqual(manifest["chunking"]["page_index_offset"], 549)
            self.assertEqual(manifest["source_documents"][0]["page_start"], 550)
            self.assertEqual(manifest["source_documents"][0]["page_end"], 550)
            self.assertEqual(chunks[0]["page_start"], 550)
            self.assertEqual(chunks[0]["page_end"], 550)
            self.assertEqual(chunks[0]["image_refs"][0]["page"], 550)
            self.assertEqual(pages[0]["page"], 550)

    def test_batch_submit_merges_succeeded_jobs_into_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_a = root / "book-a.pdf"
            source_b = root / "book-b.pdf"
            source_a.write_bytes(b"%PDF-1.4\nfake-a\n")
            source_b.write_bytes(b"%PDF-1.4\nfake-b\n")
            model_root = root / "models"
            model_root.mkdir()
            fake = self._fake_mineru(root)
            service = MinerUIngestService(
                output_root=root / "ingest",
                environment={
                    MINERU_LAUNCHER_ENV: str(fake),
                    MINERU_MODEL_ROOT_ENV: str(model_root),
                    DEFAULT_CPU_THREADS_ENV: "2",
                },
            )

            submitted = service.submit_batch(
                pdfs=[
                    {"pdf_path": str(source_a), "book_id": "book-a", "title": "教材 A"},
                    {"pdf_path": str(source_b), "book_id": "book-b", "title": "教材 B"},
                ],
                force_jobs=True,
            )
            status = self._wait_batch(service, submitted["batch_id"])
            self.assertEqual(status["status"], "succeeded")
            self.assertEqual(status["counts"]["succeeded"], 2)

            result = service.batch_result(status["batch_id"], include_samples=True, sample_limit=2)
            self.assertTrue(result["bundle"]["built"])
            self.assertTrue(result["bundle"]["validation"]["ok"], result["bundle"]["validation"])
            self.assertEqual(result["bundle"]["counts"]["chunks"], 2)
            self.assertEqual(result["bundle"]["counts"]["source_documents"], 2)
            self.assertEqual(len(result["samples"]), 2)

            manifest_path = Path(result["bundle"]["manifest_path"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(len(manifest["source_documents"]), 2)
            chunks = [
                json.loads(line)
                for line in Path(result["bundle"]["artifact_paths"]["chunks_jsonl"]).read_text(encoding="utf-8").splitlines()
            ]
            assets = [
                json.loads(line)
                for line in Path(result["bundle"]["artifact_paths"]["assets_jsonl"]).read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual({chunk["doc_id"] for chunk in chunks}, {"book-a", "book-b"})
            self.assertEqual(len(assets), 2)
            for asset in assets:
                self.assertTrue(asset["path"].startswith("assets/"))
                self.assertTrue((manifest_path.parent / asset["path"]).is_file())
            quality = json.loads(Path(result["bundle"]["quality_report_path"]).read_text(encoding="utf-8"))
            self.assertEqual(quality["counts"]["pages_with_assets"], 2)
            self.assertEqual(quality["counts"]["available_assets"], 2)
            self.assertEqual(quality["chunks_by_content_type"]["body"], 2)
            validation = service.batch_validate(status["batch_id"])
            self.assertTrue(validation["ok"], validation)

    def test_batch_submit_accepts_source_path_for_text_documents_without_mineru_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_a = root / "a.md"
            source_b = root / "b.txt"
            source_a.write_text("# A\n\n止血内容", encoding="utf-8")
            source_b.write_text("气道内容", encoding="utf-8")
            service = MinerUIngestService(output_root=root / "ingest", environment={})

            submitted = service.submit_batch(
                pdfs=[
                    {"source_path": str(source_a), "book_id": "doc-a", "title": "文档 A"},
                    {"path": str(source_b), "book_id": "doc-b", "title": "文档 B"},
                ],
                force_jobs=True,
            )
            status = self._wait_batch(service, submitted["batch_id"])
            self.assertEqual(status["status"], "succeeded")
            self.assertEqual({item["input_type"] for item in status["items"]}, {"md", "txt"})

            result = service.batch_result(status["batch_id"], include_samples=True, sample_limit=2)
            self.assertTrue(result["bundle"]["built"])
            self.assertTrue(result["bundle"]["validation"]["ok"], result["bundle"]["validation"])
            self.assertEqual(result["bundle"]["counts"]["chunks"], 2)
            self.assertEqual(result["bundle"]["counts"]["source_documents"], 2)

    def test_batch_submit_isolates_bad_pdf_items(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"%PDF-1.4\nfake\n")
            model_root = root / "models"
            model_root.mkdir()
            fake = self._fake_mineru(root)
            service = MinerUIngestService(
                output_root=root / "ingest",
                environment={
                    MINERU_LAUNCHER_ENV: str(fake),
                    MINERU_MODEL_ROOT_ENV: str(model_root),
                },
            )

            submitted = service.submit_batch(
                pdfs=[
                    {"pdf_path": str(source), "book_id": "good-book"},
                    {"pdf_path": str(root / "missing.pdf"), "book_id": "bad-book"},
                ],
                force_jobs=True,
            )
            status = self._wait_batch(service, submitted["batch_id"])
            self.assertEqual(status["status"], "partial_failed")
            self.assertEqual(status["counts"]["succeeded"], 1)
            self.assertEqual(status["counts"]["failed"], 1)

            result = service.batch_result(status["batch_id"])
            self.assertFalse(result["bundle"]["built"])
            partial = service.batch_result(status["batch_id"], allow_partial=True)
            self.assertTrue(partial["bundle"]["built"])
            self.assertTrue(partial["bundle"]["partial"])
            self.assertTrue(partial["bundle"]["validation"]["ok"], partial["bundle"]["validation"])

    def _wait_batch(self, service: MinerUIngestService, batch_id: str) -> dict:
        for _ in range(100):
            status = service.batch_status(batch_id)
            if status["status"] != "running":
                return status
            time.sleep(0.05)
        self.fail(f"batch did not finish: {batch_id}")

    def _minimal_docx(self, path: Path, paragraphs: list[str]) -> None:
        body = "".join(
            f"<w:p><w:r><w:t>{paragraph}</w:t></w:r></w:p>"
            for paragraph in paragraphs
        )
        document_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body>{body}</w:body>"
            "</w:document>"
        )
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("word/document.xml", document_xml)


if __name__ == "__main__":
    unittest.main()
