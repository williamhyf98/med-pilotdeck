from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

import numpy as np

from server.rag.rag_bundle import build_incremental_rag_bundle, build_rag_bundle
from server.rag.store import RagManifest, RagStore


class RagBundleTests(unittest.TestCase):
    def test_builds_manifest_that_existing_store_can_load(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            corpus = root / "source.jsonl"
            corpus.write_text(
                json.dumps({"chunk_id": "one", "text": "第一段", "page_start": 4, "page_end": 5}, ensure_ascii=False) + "\n"
                + json.dumps({"chunk_id": "two", "contents": "第二段"}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            calls: list[list[str]] = []

            def fake_embed(texts: list[str]) -> list[list[float]]:
                calls.append(texts)
                return [[1.0, 0.0], [0.0, 1.0]][: len(texts)]

            bundle = build_rag_bundle(
                corpus_path=corpus,
                destination=root / "bundle",
                corpus_id="sample",
                name="样本",
                version="v1",
                license_id="test",
                embed=fake_embed,
            )
            self.assertEqual(calls, [["第一段", "第二段"]])
            store = RagStore(RagManifest.load(bundle / "manifest.json"))
            self.assertTrue(store.status(validate=True)["ready"])
            item = store.search_lexical(query="第一段", top_k=1)[0]
            self.assertEqual((item["page_start"], item["page_end"]), (4, 5))
            with self.assertRaises(FileExistsError):
                build_rag_bundle(
                    corpus_path=corpus,
                    destination=bundle,
                    corpus_id="sample",
                    name="样本",
                    version="v1",
                    license_id="test",
                    embed=fake_embed,
                )

    def test_copies_image_assets_and_removes_source_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "mineru" / "images" / "figure.jpg"
            image.parent.mkdir(parents=True)
            image.write_bytes(b"image-bytes")
            corpus = root / "source.jsonl"
            corpus.write_text(
                json.dumps({
                    "chunk_id": "one",
                    "text": "图示文字",
                    "image_refs": [{
                        "path": "images/figure.jpg",
                        "source_path": str(image),
                        "page": 1,
                    }],
                }, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            bundle = build_rag_bundle(
                corpus_path=corpus,
                destination=root / "bundle",
                corpus_id="sample",
                name="样本",
                version="v1",
                license_id="test",
                embed=lambda texts: [[1.0, 0.0] for _ in texts],
            )
            row = json.loads((bundle / "corpus" / "chunks.jsonl").read_text(encoding="utf-8"))
            ref = row["image_refs"][0]
            self.assertNotIn("source_path", ref)
            self.assertTrue(ref["path"].startswith("assets/"))
            self.assertTrue((bundle / ref["path"]).is_file())
            self.assertEqual(json.loads((bundle / "manifest.json").read_text())["asset_count"], 1)

    def test_incremental_bundle_appends_only_new_embeddings(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            base_image = root / "base-mineru" / "images" / "base.jpg"
            base_image.parent.mkdir(parents=True)
            base_image.write_bytes(b"base-image")
            base_corpus = root / "base-source.jsonl"
            base_corpus.write_text(
                json.dumps(
                    {
                        "chunk_id": "base-one",
                        "text": "旧内容一",
                        "image_refs": [
                            {
                                "path": "images/base.jpg",
                                "source_path": str(base_image),
                                "caption": "图0-1 基础图",
                                "page": 1,
                            }
                        ],
                    },
                    ensure_ascii=False,
                ) + "\n"
                + json.dumps({"chunk_id": "base-two", "text": "旧内容二"}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            base = build_rag_bundle(
                corpus_path=base_corpus,
                destination=root / "base-bundle",
                corpus_id="base",
                name="旧库",
                version="v1",
                license_id="test",
                embed=lambda texts: [[1.0, 0.0], [0.0, 1.0]][: len(texts)],
            )
            ingest = root / "ingest-bundle"
            image = ingest / "assets" / "raw" / "fig.jpg"
            image.parent.mkdir(parents=True)
            image.write_bytes(b"new-image")
            (ingest / "corpus").mkdir()
            (ingest / "corpus" / "chunks.jsonl").write_text(
                json.dumps(
                    {
                        "chunk_id": "new-one",
                        "doc_id": "new-book",
                        "title": "新增教材",
                        "text": "新增内容",
                        "contents": "新增内容",
                        "image_refs": [
                            {
                                "asset_id": "old-asset",
                                "path": "assets/raw/fig.jpg",
                                "caption": "图1-1 新图",
                                "page": 3,
                                "available": True,
                            }
                        ],
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
            (ingest / "corpus" / "pages.jsonl").write_text(
                json.dumps({"page_id": "new-book-p0003", "doc_id": "new-book", "page": 3}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            (ingest / "corpus" / "assets.jsonl").write_text("", encoding="utf-8")
            (ingest / "manifest.json").write_text(
                json.dumps(
                    {
                        "schema_version": "mineru-ingest-chunks-v1",
                        "corpus_id": "ingest",
                        "source_documents": [{"document_id": "new-book", "title": "新增教材"}],
                        "artifacts": {
                            "chunks_path": "corpus/chunks.jsonl",
                            "pages_path": "corpus/pages.jsonl",
                            "assets_path": "corpus/assets.jsonl",
                            "assets_dir": "assets",
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            calls: list[list[str]] = []

            def embed_new(texts: list[str]) -> list[list[float]]:
                calls.append(texts)
                return [[0.5, 0.5] for _ in texts]

            result = build_incremental_rag_bundle(
                base_manifest_path=base / "manifest.json",
                ingest_manifest_path=ingest / "manifest.json",
                destination=root / "merged-bundle",
                corpus_id="base-plus-new",
                name="旧库+新增",
                version="v2",
                embed=embed_new,
            )
            self.assertEqual(calls, [["新增内容"]])
            self.assertEqual(result["old_chunk_count"], 2)
            self.assertEqual(result["new_chunk_count"], 1)
            self.assertEqual(result["total_chunk_count"], 3)
            self.assertEqual(result["asset_count"], 2)
            self.assertEqual(
                result["asset_materialization"]["base"]["hardlinked"]
                + result["asset_materialization"]["base"]["copied"],
                1,
            )
            self.assertEqual(
                result["asset_materialization"]["imported"]["hardlinked"]
                + result["asset_materialization"]["imported"]["copied"],
                1,
            )
            self.assertEqual(
                result["asset_materialization"]["total"]["hardlinked"]
                + result["asset_materialization"]["total"]["copied"],
                2,
            )

            merged = Path(result["bundle_dir"])
            manifest = json.loads((merged / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["row_count"], 3)
            self.assertEqual(manifest["incremental_import"]["base_row_count"], 2)
            self.assertEqual(manifest["incremental_import"]["new_row_count"], 1)
            self.assertEqual(manifest["asset_count"], 2)
            self.assertEqual(
                manifest["incremental_import"]["asset_materialization"],
                result["asset_materialization"],
            )
            vectors = np.load(merged / "embedding" / "vectors.npy")
            np.testing.assert_allclose(vectors, np.asarray([[1.0, 0.0], [0.0, 1.0], [0.5, 0.5]], dtype=np.float32))
            rows = [
                json.loads(line)
                for line in (merged / "corpus" / "chunks.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual([row["chunk_id"] for row in rows], ["base-one", "base-two", "new-one"])
            ref = rows[-1]["image_refs"][0]
            self.assertTrue(ref["path"].startswith("assets/imported/new-book/"))
            self.assertTrue((merged / ref["path"]).is_file())
            base_ref = rows[0]["image_refs"][0]
            self.assertTrue(base_ref["path"].startswith("assets/"))
            self.assertTrue((merged / base_ref["path"]).is_file())
            if result["asset_materialization"]["base"]["hardlinked"]:
                self.assertEqual(os.stat(base / base_ref["path"]).st_ino, os.stat(merged / base_ref["path"]).st_ino)
            if result["asset_materialization"]["imported"]["hardlinked"]:
                self.assertEqual(os.stat(image).st_ino, os.stat(merged / ref["path"]).st_ino)
            store = RagStore(RagManifest.load(merged / "manifest.json"))
            self.assertTrue(store.status(validate=True)["ready"])
            self.assertIn("新增内容", store.search_lexical(query="新增内容", top_k=1)[0]["text"])

    def test_incremental_bundle_rejects_duplicate_chunk_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            base_corpus = root / "base-source.jsonl"
            base_corpus.write_text(
                json.dumps({"chunk_id": "same", "text": "旧内容"}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            base = build_rag_bundle(
                corpus_path=base_corpus,
                destination=root / "base-bundle",
                corpus_id="base",
                name="旧库",
                version="v1",
                license_id="test",
                embed=lambda texts: [[1.0, 0.0] for _ in texts],
            )
            ingest = root / "ingest-bundle"
            (ingest / "corpus").mkdir(parents=True)
            (ingest / "corpus" / "chunks.jsonl").write_text(
                json.dumps({"chunk_id": "same", "text": "新增内容"}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            (ingest / "manifest.json").write_text(
                json.dumps(
                    {
                        "schema_version": "mineru-ingest-chunks-v1",
                        "corpus_id": "ingest",
                        "artifacts": {"chunks_path": "corpus/chunks.jsonl"},
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "already exists"):
                build_incremental_rag_bundle(
                    base_manifest_path=base / "manifest.json",
                    ingest_manifest_path=ingest / "manifest.json",
                    destination=root / "merged-bundle",
                    corpus_id="base-plus-new",
                    name="旧库+新增",
                    version="v2",
                    embed=lambda texts: [[0.5, 0.5] for _ in texts],
                )


if __name__ == "__main__":
    unittest.main()
