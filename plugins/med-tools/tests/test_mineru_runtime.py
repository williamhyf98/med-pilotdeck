"""Offline tests for configuring an externally managed MinerU runtime."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from server.rag.mineru_runtime import (
    MINERU_LAUNCHER_ENV,
    MINERU_MODEL_ROOT_ENV,
    MinerURuntime,
    MinerURuntimeConfigError,
)
from server.rag.mineru_adapter import MinerUInvocation


class MinerURuntimeTests(unittest.TestCase):
    def test_environment_requires_both_external_values(self) -> None:
        with self.assertRaisesRegex(MinerURuntimeConfigError, MINERU_LAUNCHER_ENV):
            MinerURuntime.from_environment({})
        with self.assertRaisesRegex(MinerURuntimeConfigError, MINERU_MODEL_ROOT_ENV):
            MinerURuntime.from_environment({MINERU_LAUNCHER_ENV: "mineru"})

    def test_launcher_is_split_without_hard_coded_runtime_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime = MinerURuntime.from_environment(
                {
                    MINERU_LAUNCHER_ENV: f'"{sys.executable}" -m mineru.cli.client',
                    MINERU_MODEL_ROOT_ENV: temp_dir,
                }
            )
            self.assertEqual(runtime.launcher, (sys.executable, "-m", "mineru.cli.client"))
            self.assertEqual(runtime.model_root, Path(temp_dir).resolve())
            runtime.validate()

    def test_validate_explains_missing_model_directory(self) -> None:
        runtime = MinerURuntime(
            launcher=(sys.executable, "-m", "mineru.cli.client"),
            model_root=Path("/definitely-not-a-mineru-model-directory"),
        )
        with self.assertRaisesRegex(MinerURuntimeConfigError, MINERU_MODEL_ROOT_ENV):
            runtime.validate()

    def test_invocation_is_built_from_the_external_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic pdf")
            runtime = MinerURuntime(launcher=(sys.executable,), model_root=root)
            invocation = MinerUInvocation.from_runtime(
                runtime=runtime, source=source, output_dir=root / "output"
            )
            self.assertEqual(invocation.launcher, (sys.executable,))
            self.assertEqual(invocation.model_root, root)


if __name__ == "__main__":
    unittest.main()
