"""Offline tests for RAG ingestion state and the MinerU subprocess boundary."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from server.rag.ingestion_ledger import IngestionLedger
from server.rag.mineru_ingestion import ingest_pdf
from server.rag.mineru_adapter import (
    MinerUExecutionError,
    MinerUInvocation,
    MinerUOutputError,
    run_mineru,
    validate_mineru_output,
)


class IngestionLedgerTests(unittest.TestCase):
    def test_successful_unchanged_source_is_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic pdf")
            ledger = IngestionLedger(root / "state" / "ledger.sqlite")
            job, should_run = ledger.begin(source=source, output_dir=root / "output", job_key="sample")
            self.assertTrue(should_run)
            ledger.succeed(job)
            skipped, should_run = ledger.begin(source=source, output_dir=root / "output", job_key="sample")
            self.assertFalse(should_run)
            self.assertEqual(skipped.status, "succeeded")

    def test_changed_source_and_failure_are_rerunnable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"version one")
            ledger = IngestionLedger(root / "ledger.sqlite")
            job, _ = ledger.begin(source=source, output_dir=root / "output", job_key="sample")
            ledger.fail(job, "synthetic failure")
            retry, should_run = ledger.begin(source=source, output_dir=root / "output", job_key="sample")
            self.assertTrue(should_run)
            self.assertEqual(retry.status, "running")
            source.write_bytes(b"version two")
            changed, should_run = ledger.begin(source=source, output_dir=root / "output", job_key="sample")
            self.assertTrue(should_run)
            self.assertNotEqual(changed.source_sha256, job.source_sha256)


class MinerUAdapterTests(unittest.TestCase):
    def _fake_executable(self, root: Path, body: str) -> Path:
        script = root / "fake-mineru"
        script.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        script.chmod(0o700)
        return script

    def _invocation(self, root: Path, source: Path, output_dir: Path, executable: Path) -> MinerUInvocation:
        model_root = root / "models"
        model_root.mkdir(exist_ok=True)
        return MinerUInvocation(
            launcher=(str(executable),),
            source=source,
            output_dir=output_dir,
            model_root=model_root,
        )

    def test_success_passes_required_local_ocr_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic pdf")
            capture = root / "arguments.txt"
            environment_capture = root / "environment.txt"
            executable = self._fake_executable(
                root,
                f"printf '%s\\n' \"$@\" > {str(capture)!r}\n"
                f"printf '%s %s %s\\n' \"$OMP_NUM_THREADS\" \"$MKL_NUM_THREADS\" \"$OPENBLAS_NUM_THREADS\" > {str(environment_capture)!r}\n"
                "exit 0\n",
            )
            invocation = self._invocation(root, source, root / "output", executable)
            result = run_mineru(invocation)
            self.assertEqual(result.returncode, 0)
            args = capture.read_text(encoding="utf-8").splitlines()
            self.assertEqual(args[0:2], ["-p", str(source.resolve())])
            self.assertEqual(args[args.index("-b") + 1], "pipeline")
            self.assertEqual(args[args.index("-m") + 1], "ocr")
            self.assertEqual(args[args.index("-l") + 1], "ch")
            self.assertEqual(args[args.index("--source") + 1], "local")
            self.assertEqual(args[args.index("-d") + 1], "cpu")
            self.assertTrue((root / "output" / ".mineru-home").is_dir())
            self.assertTrue((root / "output" / ".mineru-home" / "mineru.json").is_file())
            self.assertEqual(environment_capture.read_text(encoding="utf-8").strip(), "1 1 1")

    def test_nonzero_exit_is_not_treated_as_success(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic pdf")
            executable = self._fake_executable(root, "echo synthetic failure >&2\nexit 9\n")
            with self.assertRaisesRegex(MinerUExecutionError, "exited 9"):
                run_mineru(self._invocation(root, source, root / "output", executable))

    def test_timeout_is_not_treated_as_success(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic pdf")
            executable = self._fake_executable(root, "sleep 2\n")
            with self.assertRaisesRegex(MinerUExecutionError, "timed out"):
                invocation = self._invocation(root, source, root / "output", executable)
                run_mineru(MinerUInvocation(**{**invocation.__dict__, "timeout_seconds": 1}))

    def test_missing_source_is_rejected_before_process_start(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            model_root = root / "models"
            model_root.mkdir()
            with self.assertRaisesRegex(MinerUExecutionError, "missing"):
                run_mineru(
                    MinerUInvocation(
                        launcher=(str(root / "fake-mineru"),),
                        source=root / "none.pdf",
                        output_dir=root / "out",
                        model_root=model_root,
                    )
                )

    def test_output_validation_requires_nonempty_markdown_and_json_products(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic pdf")
            executable = self._fake_executable(root, "exit 0\n")
            invocation = self._invocation(root, source, root / "output", executable)
            parsed = invocation.parsed_output_dir
            parsed.mkdir(parents=True)
            (parsed / "book.md").write_text("# usable text\n", encoding="utf-8")
            (parsed / "book_content_list.json").write_text("[]", encoding="utf-8")
            (parsed / "book_model.json").write_text("{}", encoding="utf-8")
            output = validate_mineru_output(invocation)
            self.assertEqual(output.markdown_path.name, "book.md")
            (parsed / "book.md").write_text("", encoding="utf-8")
            with self.assertRaises(MinerUOutputError):
                validate_mineru_output(invocation)

    def test_ingestion_records_success_and_skips_matching_source(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic pdf")
            executable = self._fake_executable(
                root,
                'mkdir -p "$4/book/ocr"\n'
                'printf "# text\\n" > "$4/book/ocr/book.md"\n'
                'printf "[]" > "$4/book/ocr/book_content_list.json"\n'
                'printf "{}" > "$4/book/ocr/book_model.json"\n',
            )
            invocation = self._invocation(root, source, root / "output", executable)
            ledger = IngestionLedger(root / "state" / "ledger.sqlite")
            first = ingest_pdf(ledger=ledger, invocation=invocation)
            self.assertFalse(first.skipped)
            self.assertEqual(first.job.status, "succeeded")
            second = ingest_pdf(ledger=ledger, invocation=invocation)
            self.assertTrue(second.skipped)

    def test_different_page_ranges_have_different_job_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic pdf")
            executable = self._fake_executable(root, "exit 0\n")
            first = self._invocation(root, source, root / "page-one", executable)
            second = MinerUInvocation(**{**first.__dict__, "output_dir": root / "full", "end_page": 0})
            self.assertNotEqual(first.job_key, second.job_key)


if __name__ == "__main__":
    unittest.main()
