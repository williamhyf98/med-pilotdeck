import unittest
import tempfile
from pathlib import Path

from server.rag.presentation import build_image_asset, build_interleave_context


class PresentationTests(unittest.TestCase):
    def test_text_image_text_order_and_deduplication(self) -> None:
        segments = build_interleave_context([
            {
                "chunk_id": "c1",
                "rank": 1,
                "text": "前文",
                "image_refs": [{"path": "images/a.jpg", "caption": "图一", "page": 1}],
            },
            {
                "chunk_id": "c2",
                "rank": 1,
                "text": "后文",
                "image_refs": [{"path": "images/a.jpg", "caption": "图一", "page": 1}],
            },
        ])
        self.assertEqual([item["type"] for item in segments], ["text", "image", "text"])
        self.assertEqual(segments[1]["path"], "images/a.jpg")
        self.assertIsNone(segments[1]["url"])

    def test_bundle_asset_has_browser_url(self) -> None:
        segments = build_interleave_context([{
            "chunk_id": "c1",
            "rank": 1,
            "text": "前文",
            "image_refs": [{"path": "assets/ab/figure 1.jpg", "page": 1}],
        }])
        self.assertEqual(
            segments[1]["url"],
            "/api/plugins/med-tools/rag-assets/assets/ab/figure%201.jpg",
        )
        self.assertTrue(segments[1]["available"])
        self.assertEqual(segments[1]["asset_type"], "figure")

    def test_image_asset_checks_bundle_availability(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "assets" / "ab" / "figure.jpg"
            image.parent.mkdir(parents=True)
            image.write_bytes(b"fake image")
            available = build_image_asset(
                {"path": "assets/ab/figure.jpg", "caption": "图2-1 测试图", "page": 2},
                bundle_root=root,
            )
            missing = build_image_asset(
                {"path": "assets/ab/missing.jpg", "caption": "图2-2 缺失图", "page": 2},
                bundle_root=root,
            )
        self.assertIsNotNone(available)
        assert available is not None
        self.assertTrue(available["available"])
        self.assertEqual(available["url"], "/api/plugins/med-tools/rag-assets/assets/ab/figure.jpg")
        self.assertEqual(available["figure_no"], "图2-1")
        self.assertIsNotNone(missing)
        assert missing is not None
        self.assertFalse(missing["available"])
        self.assertIsNone(missing["url"])

    def test_text_without_images_stays_text_only(self) -> None:
        self.assertEqual(
            build_interleave_context([{"chunk_id": "c1", "text": "纯文字"}]),
            [{"type": "text", "content": "纯文字", "chunk_id": "c1"}],
        )

    def test_images_default_to_top_rank_only(self) -> None:
        segments = build_interleave_context([
            {
                "chunk_id": "c1",
                "rank": 1,
                "text": "首条证据",
                "image_refs": [],
            },
            {
                "chunk_id": "c2",
                "rank": 2,
                "text": "次条证据",
                "image_refs": [{"path": "assets/ab/lower-rank.jpg", "page": 2}],
            },
        ])
        self.assertEqual([item["type"] for item in segments], ["text", "text"])

    def test_can_expand_image_rank_when_explicitly_requested(self) -> None:
        segments = build_interleave_context(
            [
                {"chunk_id": "c1", "rank": 1, "text": "首条证据", "image_refs": []},
                {
                    "chunk_id": "c2",
                    "rank": 2,
                    "text": "次条证据",
                    "image_refs": [{"path": "assets/ab/second.jpg", "page": 2}],
                },
            ],
            max_image_rank=2,
        )
        self.assertEqual([item["type"] for item in segments], ["text", "text", "image"])
        self.assertEqual(segments[2]["after_chunk_id"], "c2")

    def test_image_query_filters_to_matching_caption(self) -> None:
        segments = build_interleave_context(
            [{
                "chunk_id": "c1",
                "rank": 1,
                "text": "正文同时提到图2-1和图2-2",
                "image_refs": [
                    {
                        "path": "assets/ab/fig-2-1.jpg",
                        "caption": "图2-1 评估事故现场至关重要",
                        "page": 29,
                    },
                    {
                        "path": "assets/ab/fig-2-2.jpg",
                        "caption": "图2-2 滑雪者惯性运动",
                        "page": 29,
                    },
                ],
            }],
            image_query="图2-1 评估事故现场至关重要说明什么",
        )
        self.assertEqual([item["type"] for item in segments], ["text", "image"])
        self.assertEqual(segments[1]["caption"], "图2-1 评估事故现场至关重要")


if __name__ == "__main__":
    unittest.main()
