from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from server.mineru_paths import (
    assert_mineru_output_path,
    assert_mineru_source_path,
    resolve_mineru_root,
)
from server.path_safety import ACCESS_DENIED


class MinerUPathSafetyTests(unittest.TestCase):
    def test_resolves_default_root_and_allows_user_sources_and_new_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir) / "users" / "7"
            home.mkdir(parents=True)
            source = home / "projects" / "manual.pdf"
            source.parent.mkdir()
            source.write_bytes(b"%PDF-1.4")
            env = {"PILOT_HOME": str(home)}

            self.assertEqual(
                resolve_mineru_root(env),
                (home / "med-tools" / "mineru-ingest").resolve(),
            )
            self.assertEqual(assert_mineru_source_path(str(source), env), source.resolve())
            self.assertEqual(
                assert_mineru_output_path(str(home / "med-tools" / "mineru-ingest" / "jobs"), env),
                (home / "med-tools" / "mineru-ingest" / "jobs").resolve(),
            )

    def test_rejects_paths_outside_user_home_and_configured_root_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            home = root / "users" / "7"
            other = root / "users" / "8"
            home.mkdir(parents=True)
            other.mkdir()
            source = other / "private.pdf"
            source.write_bytes(b"private")

            with self.assertRaisesRegex(PermissionError, "访问被禁止"):
                assert_mineru_source_path(str(source), {"PILOT_HOME": str(home)})
            with self.assertRaisesRegex(PermissionError, "访问被禁止"):
                resolve_mineru_root(
                    {
                        "PILOT_HOME": str(home),
                        "MED_RAG_MINERU_INGEST_ROOT": str(other / "ingest"),
                    }
                )
            with self.assertRaisesRegex(PermissionError, "访问被禁止"):
                assert_mineru_output_path(str(home / ".." / "8" / "out"), {"PILOT_HOME": str(home)})

    def test_rejects_external_and_dangling_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            home = root / "users" / "7"
            other = root / "outside"
            home.mkdir(parents=True)
            other.mkdir()
            outside_file = other / "private.pdf"
            outside_file.write_bytes(b"private")
            external_link = home / "external.pdf"
            external_link.symlink_to(outside_file)
            dangling_link = home / "dangling.pdf"
            dangling_link.symlink_to(other / "missing.pdf")
            env = {"PILOT_HOME": str(home)}

            for path in (external_link, dangling_link):
                with self.subTest(path=path), self.assertRaises(PermissionError) as ctx:
                    assert_mineru_source_path(str(path), env)
                self.assertEqual(str(ctx.exception), ACCESS_DENIED)

    def test_missing_or_invalid_pilot_home_fails_closed(self) -> None:
        for env in ({}, {"PILOT_HOME": "relative/home"}, {"PILOT_HOME": "/path/that/does/not/exist"}):
            with self.subTest(env=env), self.assertRaises(PermissionError) as ctx:
                resolve_mineru_root(env)
            self.assertEqual(str(ctx.exception), ACCESS_DENIED)


if __name__ == "__main__":
    unittest.main()
