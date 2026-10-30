from __future__ import annotations

import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from server.rag.mineru_adapter import (
    MinerUExecutionError,
    MinerUInvocation,
    MinerUOutputError,
    run_mineru,
    validate_mineru_output,
)
from server.rag.mineru_runtime import MinerURuntime


FAKE_LAUNCHER = r"""
import json
import os
import sys
import time
from pathlib import Path

args = sys.argv[1:]
if "--sleep" in args:
    time.sleep(float(args[args.index("--sleep") + 1]))
if "--fail" in args:
    print("fake mineru failure", file=sys.stderr)
    raise SystemExit(9)

def value(flag):
    return args[args.index(flag) + 1]

source = Path(value("-p"))
output = Path(value("-o"))
(output / "record.json").write_text(
    json.dumps(
        {
            "args": args,
            "env": {
                key: os.environ.get(key)
                for key in (
                    "HOME",
                    "XDG_CACHE_HOME",
                    "XDG_CONFIG_HOME",
                    "HF_HOME",
                    "TMPDIR",
                    "PYTHONNOUSERSITE",
                    "HTTP_PROXY",
                    "HTTPS_PROXY",
                    "ALL_PROXY",
                    "OMP_NUM_THREADS",
                    "MINERU_TOOLS_CONFIG_JSON",
                )
            },
        }
    ),
    encoding="utf-8",
)

parsed = output / source.stem / "ocr"
parsed.mkdir(parents=True, exist_ok=True)
(parsed / f"{source.stem}.md").write_text("# Fake output\n", encoding="utf-8")
(parsed / f"{source.stem}_content_list.json").write_text("[]", encoding="utf-8")
(parsed / f"{source.stem}_model.json").write_text("{}", encoding="utf-8")
"""


class MinerUAdapterTests(unittest.TestCase):
    def _invocation(
        self,
        root: Path,
        *,
        launcher: tuple[str, ...],
        timeout_seconds: int = 5,
    ) -> MinerUInvocation:
        source = root / "book.pdf"
        source.write_bytes(b"%PDF-1.4")
        model_root = root / "models"
        model_root.mkdir()
        return MinerUInvocation(
            launcher=launcher,
            source=source,
            output_dir=root / "output",
            model_root=model_root,
            language="zh",
            device="cpu",
            start_page=2,
            end_page=7,
            formula_enabled=True,
            table_enabled=True,
            timeout_seconds=timeout_seconds,
            cpu_threads=3,
        )

    def test_fake_launcher_receives_parse_options_and_isolated_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            script = root / "fake_mineru.py"
            script.write_text(FAKE_LAUNCHER, encoding="utf-8")
            invocation = self._invocation(
                root,
                launcher=(sys.executable, str(script)),
            )
            with mock.patch.dict(
                "os.environ",
                {
                    "HTTP_PROXY": "http://proxy.invalid",
                    "HTTPS_PROXY": "http://proxy.invalid",
                    "ALL_PROXY": "http://proxy.invalid",
                },
                clear=False,
            ):
                run_mineru(invocation)

            payload = json.loads((invocation.output_dir / "record.json").read_text(encoding="utf-8"))
            args = payload["args"]
            self.assertEqual(args[args.index("-p") + 1], str(invocation.source.resolve()))
            self.assertEqual(args[args.index("-o") + 1], str(invocation.output_dir.resolve()))
            self.assertEqual(args[args.index("-s") + 1], "2")
            self.assertEqual(args[args.index("-e") + 1], "7")
            self.assertEqual(args[args.index("-l") + 1], "zh")
            self.assertEqual(args[args.index("-f") + 1], "true")
            self.assertEqual(args[args.index("-t") + 1], "true")
            self.assertEqual(payload["env"]["HOME"], str(invocation.output_dir / ".mineru-home"))
            self.assertEqual(
                payload["env"]["XDG_CACHE_HOME"],
                str(invocation.output_dir / ".mineru-home" / "cache"),
            )
            self.assertEqual(payload["env"]["TMPDIR"], str(invocation.output_dir / ".mineru-home" / "tmp"))
            self.assertEqual(payload["env"]["PYTHONNOUSERSITE"], "1")
            self.assertEqual(payload["env"]["OMP_NUM_THREADS"], "3")
            self.assertIsNone(payload["env"]["HTTP_PROXY"])
            self.assertIsNone(payload["env"]["HTTPS_PROXY"])
            self.assertIsNone(payload["env"]["ALL_PROXY"])
            config = json.loads(Path(payload["env"]["MINERU_TOOLS_CONFIG_JSON"]).read_text())
            self.assertEqual(config["models-dir"]["pipeline"], str(invocation.model_root.resolve()))

            output = validate_mineru_output(invocation)
            self.assertTrue(output.markdown_path.is_file())
            self.assertTrue(output.content_list_path.is_file())
            self.assertTrue(output.model_path.is_file())

    def test_nonzero_exit_and_timeout_are_explicit_errors(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            script = root / "fake_mineru.py"
            script.write_text(FAKE_LAUNCHER, encoding="utf-8")
            invocation = self._invocation(root, launcher=(sys.executable, str(script)))

            failing = invocation.__class__(
                **{**invocation.__dict__, "launcher": invocation.launcher + ("--fail",)}
            )
            with self.assertRaisesRegex(MinerUExecutionError, "exited 9"):
                run_mineru(failing)

            sleeping = invocation.__class__(
                **{**invocation.__dict__, "launcher": invocation.launcher + ("--sleep", "2"), "timeout_seconds": 1}
            )
            with self.assertRaisesRegex(MinerUExecutionError, "timed out"):
                run_mineru(sleeping)

    def test_missing_output_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"%PDF")
            model_root = root / "models"
            model_root.mkdir()
            invocation = MinerUInvocation(
                launcher=(sys.executable, "-c", "pass"),
                source=source,
                output_dir=root / "output",
                model_root=model_root,
            )
            run_mineru(invocation)
            with self.assertRaisesRegex(MinerUOutputError, "incomplete"):
                validate_mineru_output(invocation)

    def test_output_symlink_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"%PDF")
            model_root = root / "models"
            model_root.mkdir()
            invocation = MinerUInvocation(
                launcher=(sys.executable, "-c", "pass"),
                source=source,
                output_dir=root / "output",
                model_root=model_root,
            )
            parsed = invocation.parsed_output_dir
            parsed.mkdir(parents=True)
            outside = root / "outside.md"
            outside.write_text("external", encoding="utf-8")
            (parsed / "book.md").symlink_to(outside)
            (parsed / "book_content_list.json").write_text("[]", encoding="utf-8")
            (parsed / "book_model.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(MinerUOutputError, "escapes"):
                validate_mineru_output(invocation)


if __name__ == "__main__":
    unittest.main()
