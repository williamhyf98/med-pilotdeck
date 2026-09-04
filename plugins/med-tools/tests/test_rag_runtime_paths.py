"""Tests for the external, data-disk-only RAG runtime layout."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from server.rag.runtime_paths import (
    RUNTIME_ROOT_ENV,
    RagRuntimePathError,
    RagRuntimePaths,
)


class RagRuntimePathsTests(unittest.TestCase):
    def test_environment_root_is_required(self) -> None:
        with mock.patch.dict(os.environ, {RUNTIME_ROOT_ENV: ""}, clear=False):
            with self.assertRaisesRegex(RagRuntimePathError, RUNTIME_ROOT_ENV):
                RagRuntimePaths.from_environment()

    def test_runtime_root_cannot_be_under_home(self) -> None:
        with self.assertRaisesRegex(RagRuntimePathError, r"\$HOME"):
            RagRuntimePaths.from_root(Path.home() / "med-pilotdeck-rag")

    def test_from_environment_has_no_creation_side_effect(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "new-runtime-root"
            with mock.patch.dict(os.environ, {RUNTIME_ROOT_ENV: str(root)}, clear=False):
                paths = RagRuntimePaths.from_environment()
            self.assertEqual(paths.root, root.resolve())
            self.assertFalse(root.exists())

    def test_ensure_layout_creates_only_declared_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = RagRuntimePaths.from_root(Path(temp_dir) / "runtime")
            paths.ensure_layout()
            self.assertTrue(paths.root.is_dir())
            for directory in (
                paths.conda_envs,
                paths.model_cache,
                paths.artifacts,
                paths.corpora,
                paths.indexes,
                paths.state,
                paths.temporary,
            ):
                self.assertTrue(directory.is_dir(), directory)
            self.assertFalse(paths.ledger_path.exists())


if __name__ == "__main__":
    unittest.main()
