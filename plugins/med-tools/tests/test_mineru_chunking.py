from __future__ import annotations

import json
import tempfile
import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

from server.rag.mineru_chunking import ChunkingConfig, build_mineru_chunks, write_chunks_jsonl


class MinerUChunkingTests(unittest.TestCase):
    def _content_list(self, root: Path, blocks: list[dict]) -> tuple[Path, Path]:
        source = root / "军事医学.pdf"
        source.write_bytes(b"pdf")
        content = root / "content_list.json"
        content.write_text(json.dumps(blocks, ensure_ascii=False), encoding="utf-8")
        return source, content

    def test_headings_pages_and_discarded_blocks_are_preserved_or_filtered(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source, content = self._content_list(
                Path(temp_dir),
                [
                    {"type": "text", "text": "第一章 总论", "text_level": 1, "page_idx": 0},
                    {"type": "text", "text": "第一节 原则", "text_level": 2, "page_idx": 0},
                    {"type": "text", "text": "这是可检索的正文。", "page_idx": 0},
                    {"type": "discarded", "text": "页眉", "page_idx": 0},
                    {"type": "text", "text": "第二页继续正文。", "page_idx": 1},
                ],
            )
            chunks = build_mineru_chunks(source_pdf=source, content_list_path=content)
            self.assertEqual(len(chunks), 1)
            self.assertEqual(chunks[0]["chapter_path"], "第一章 总论 > 第一节 原则")
            self.assertEqual(chunks[0]["page_start"], 1)
            self.assertEqual(chunks[0]["page_end"], 2)
            self.assertIn("可检索的正文", chunks[0]["text"])
            self.assertNotIn("页眉", chunks[0]["text"])

    def test_page_offset_preserves_original_pdf_page_numbers_for_partial_parses(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source, content = self._content_list(
                Path(temp_dir), [{"type": "text", "text": "第十页正文。", "page_idx": 0}],
            )
            chunks = build_mineru_chunks(
                source_pdf=source, content_list_path=content, page_index_offset=9
            )
            self.assertEqual((chunks[0]["page_start"], chunks[0]["page_end"]), (10, 10))

    def test_long_text_is_chunked_with_overlap(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            sentences = "".join(f"第{i}句内容。" for i in range(120))
            source, content = self._content_list(
                Path(temp_dir), [{"type": "text", "text": sentences, "page_idx": 3}],
            )
            chunks = build_mineru_chunks(
                source_pdf=source,
                content_list_path=content,
                config=ChunkingConfig(max_chars=200, overlap_chars=40),
            )
            self.assertGreater(len(chunks), 1)
            self.assertTrue(all(len(chunk["text"]) <= 260 for chunk in chunks))
        self.assertEqual({chunk["page_start"] for chunk in chunks}, {4})

    def test_image_blocks_are_references_only(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"pdf")
            content = root / "book_content_list.json"
            content.write_text(
                json.dumps(
                    [
                        {"type": "text", "text": "图示说明文字", "page_idx": 0},
                        {
                            "type": "image",
                            "img_path": "images/figure-1.jpg",
                            "image_caption": ["图 1-1 示意图"],
                            "page_idx": 0,
                        },
                    ],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            chunks = build_mineru_chunks(source_pdf=source, content_list_path=content)
            self.assertEqual(chunks[0]["text"], "图示说明文字")
            self.assertEqual(chunks[0]["image_refs"], [{
                "path": "images/figure-1.jpg",
                "source_path": str((root / "images" / "figure-1.jpg").resolve()),
                "caption": "图 1-1 示意图",
                "page": 1,
                "relation": "same_page",
            }])
            self.assertNotIn("figure-1", chunks[0]["contents"])

    def test_caption_match_is_more_specific_than_same_page(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "book.pdf"
            source.write_bytes(b"pdf")
            content = root / "book_content_list.json"
            content.write_text(
                json.dumps([
                    {"type": "text", "text": "图 1-1 示意图显示流程", "page_idx": 0},
                    {"type": "image", "img_path": "images/figure-1.jpg",
                     "image_caption": ["图 1-1 示意图"], "page_idx": 0},
                ], ensure_ascii=False), encoding="utf-8"
            )
            chunks = build_mineru_chunks(source_pdf=source, content_list_path=content)
            self.assertEqual(chunks[0]["image_refs"][0]["relation"], "caption")

    def test_writer_is_atomic_and_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir) / "corpus" / "chunks.jsonl"
            written = write_chunks_jsonl(chunks=[{"chunk_id": "one", "text": "正文"}], destination=destination)
            self.assertEqual(written, destination.resolve())
            self.assertEqual(json.loads(destination.read_text(encoding="utf-8"))["chunk_id"], "one")
            with self.assertRaises(FileExistsError):
                write_chunks_jsonl(chunks=[{"chunk_id": "two", "text": "正文"}], destination=destination)


if __name__ == "__main__":
    unittest.main()
