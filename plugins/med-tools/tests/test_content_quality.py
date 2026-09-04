"""Offline regression tests for MinerU content-type reliability metadata."""

from __future__ import annotations

import unittest

from server.rag.content_quality import annotate_mineru_blocks, classify_mineru_block


class ContentQualityTests(unittest.TestCase):
    def test_supported_raw_types_have_conservative_labels(self) -> None:
        cases = {
            "text": ("text", "high", True),
            "table": ("table", "medium", False),
            "equation": ("equation", "low", False),
            "image": ("figure", "medium", False),
            "discarded": ("unknown", "low", False),
        }
        for raw_type, expected in cases.items():
            actual = classify_mineru_block({"type": raw_type, "text": "普通内容"})
            self.assertEqual((actual.content_type, actual.parse_quality, actual.structure_reliable), expected)

    def test_caption_is_distinguished_from_regular_text(self) -> None:
        actual = classify_mineru_block({"type": "text", "text": "图6-5 小型非爆炸气雾剂"})
        self.assertEqual(actual.content_type, "image_caption")
        self.assertTrue(actual.structure_reliable)

    def test_annotation_skips_non_objects(self) -> None:
        rows = annotate_mineru_blocks([{"type": "table"}, "bad", None])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["content_type"], "table")


if __name__ == "__main__":
    unittest.main()
