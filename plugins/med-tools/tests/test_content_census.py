"""Offline tests for per-page MinerU content-type census rows."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from server.rag.content_census import census_mineru_content_list, write_census_jsonl


class ContentCensusTests(unittest.TestCase):
    def test_page_metrics_and_offset_are_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"pdf")
            content = root / "content.json"
            content.write_text(json.dumps([
                {"type": "text", "text": "图1-1 图注", "page_idx": 0},
                {"type": "image", "page_idx": 0},
                {"type": "table", "text": "单元格", "page_idx": 1},
            ], ensure_ascii=False), encoding="utf-8")
            rows = census_mineru_content_list(
                source_pdf=source, content_list_path=content, page_index_offset=9
            )
            self.assertEqual([row["page"] for row in rows], [10, 11])
            self.assertEqual(rows[0]["content_types"], {"figure": 1, "image_caption": 1})
            self.assertTrue(rows[1]["has_table"])
            self.assertFalse(rows[1]["structure_reliable"])

    def test_writer_is_atomic_and_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir) / "census" / "pages.jsonl"
            row = {"page": 1, "content_types": {"text": 1}}
            self.assertEqual(write_census_jsonl(rows=[row], destination=destination), destination.resolve())
            with self.assertRaises(FileExistsError):
                write_census_jsonl(rows=[row], destination=destination)

    def test_unknown_discarded_blocks_do_not_downgrade_text_page(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"pdf")
            content = root / "content.json"
            content.write_text(json.dumps([
                {"type": "text", "text": "可用正文", "page_idx": 0},
                {"type": "discarded", "text": "页眉", "page_idx": 0},
            ], ensure_ascii=False), encoding="utf-8")
            row = census_mineru_content_list(source_pdf=source, content_list_path=content)[0]
            self.assertTrue(row["structure_reliable"])


if __name__ == "__main__":
    unittest.main()
