"""Unit tests for med-tools war-trauma RAG (fixture corpus)."""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

FIXTURE_MANIFEST = (
    Path(__file__).resolve().parent / "fixtures" / "rag" / "manifest.json"
)


class TraumaRagFixtureTests(unittest.TestCase):
    def setUp(self) -> None:
        os.environ["MED_RAG_MANIFEST"] = str(FIXTURE_MANIFEST)
        from server.rag import store as store_mod

        store_mod.reset_default_store_for_tests()

    def tearDown(self) -> None:
        from server.rag import store as store_mod

        store_mod.reset_default_store_for_tests()
        os.environ.pop("MED_RAG_MANIFEST", None)

    def test_status_validate(self) -> None:
        from server.rag import rag_status

        status = rag_status(validate=True)
        self.assertTrue(status["ready"])
        self.assertEqual(status["document_count"], 3)
        self.assertEqual(status["dimension"], 8)
        self.assertEqual(status["corpus_id"], "war-trauma-test")

    def test_lexical_query(self) -> None:
        from server.rag import query_rag

        result = query_rag(query="大出血止血带", prefer_lexical=True, top_k=2)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["mode"], "lexical")
        self.assertGreaterEqual(result["chunk_count"], 1)
        top = result["chunks"][0]
        self.assertIn("止血", top["text"])
        self.assertEqual(result["generation_owner"], "pilotdeck")

    def test_vector_query_with_mock_embedding(self) -> None:
        from server.rag import query_rag
        from server.rag.store import get_default_store

        store = get_default_store()
        store.status(validate=True)
        # Use the first corpus row embedding as the query vector → should rank #0 first.
        row0 = np.asarray(store._matrix[0], dtype=np.float32).tolist()  # type: ignore[index]

        with mock.patch(
            "server.rag.query.embed_texts",
            return_value=[row0],
        ):
            result = query_rag(query="任意", top_k=2, min_score=0.0)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["mode"], "vector")
        self.assertEqual(result["chunks"][0]["chunk_id"], "fix_000")

    def test_embedding_failure_falls_back_lexical(self) -> None:
        from server.rag import query_rag
        from server.rag.embedding_client import EmbeddingError

        with mock.patch(
            "server.rag.query.embed_texts",
            side_effect=EmbeddingError("boom"),
        ):
            result = query_rag(query="气道梗阻通气", top_k=2)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["mode"], "lexical-fallback")
        self.assertTrue(any("lexical-fallback" in w for w in result["warnings"]))
        self.assertIn("气道", result["chunks"][0]["text"])

    def test_mcp_tools_json(self) -> None:
        from server.app import med_trauma_rag_query, med_trauma_rag_status

        status = json.loads(med_trauma_rag_status(validate=True))
        self.assertTrue(status["ready"])
        payload = json.loads(
            med_trauma_rag_query(query="止血带标注时间", top_k=2, prefer_lexical=True)
        )
        self.assertEqual(payload["tool"], "med_trauma_rag_query")
        self.assertEqual(payload["status"], "ready")
        self.assertGreaterEqual(payload["chunk_count"], 1)


class RealCorpusSmokeTests(unittest.TestCase):
    """Optional smoke against the full copied corpus (skip if missing)."""

    def test_real_manifest_loads(self) -> None:
        from server.rag.store import DEFAULT_MANIFEST, RagManifest, RagStore

        if not DEFAULT_MANIFEST.is_file():
            self.skipTest("full RAG manifest not present")
        store = RagStore(RagManifest.load(DEFAULT_MANIFEST))
        status = store.status(validate=True)
        self.assertTrue(status["ready"], status)
        self.assertEqual(status["document_count"], 16540)
        self.assertEqual(status["dimension"], 2048)
        items = store.search_lexical(query="战创伤现场大出血止血", top_k=3)
        self.assertGreaterEqual(len(items), 1)


if __name__ == "__main__":
    unittest.main()
