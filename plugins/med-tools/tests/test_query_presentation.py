import unittest
from types import SimpleNamespace
from unittest.mock import patch

from server.rag.query import _query_intent, query_rag


class QueryPresentationTests(unittest.TestCase):
    def _store(self):
        manifest = SimpleNamespace(
            corpus_id="demo", version="v1", default_top_k=3,
            max_top_k=8, default_min_score=0.1, embedding_model="demo",
        )

        class Store:
            def __init__(self):
                self.manifest = manifest

            def status(self, *, validate=False):
                return {"ready": True, "document_count": 1}

            def search_vector(self, **kwargs):
                return [{
                    "chunk_id": "c1",
                    "text": "图示说明",
                    "image_refs": [{
                        "path": "images/a.jpg", "caption": "图一",
                        "page": 3, "relation": "caption",
                    }],
                }]

            def search_lexical(self, **kwargs):
                return self.search_vector(**kwargs)

            def neighbor_chunks(self, **kwargs):
                return []

        return Store()

    def _caption_boost_store(self):
        manifest = SimpleNamespace(
            corpus_id="demo", version="v1", default_top_k=3,
            max_top_k=8, default_min_score=0.1, embedding_model="demo",
        )

        class Store:
            def __init__(self):
                self.manifest = manifest

            def status(self, *, validate=False):
                return {"ready": True, "document_count": 2}

            def search_vector(self, **kwargs):
                return [{
                    "chunk_id": "wrong-semantic",
                    "text": "防毒面具正文",
                    "image_refs": [{
                        "path": "assets/wrong.jpg", "caption": "图16-7 M40军用筒式防毒面具",
                        "page": 265, "relation": "same_page",
                    }],
                }]

            def search_lexical(self, **kwargs):
                return [{
                    "chunk_id": "caption-match",
                    "text": "生化武器恐慌相关正文",
                    "image_refs": [{
                        "path": "assets/right.jpg", "caption": "图1-1 1917年美国军队戴防毒面罩训练",
                        "page": 14, "relation": "same_page",
                        "url": "/api/plugins/med-tools/rag-assets/assets/right.jpg",
                        "available": True,
                    }],
                }]

            def neighbor_chunks(self, **kwargs):
                return []

        return Store()

    def _image_context_store(self):
        manifest = SimpleNamespace(
            corpus_id="demo", version="v1", default_top_k=3,
            max_top_k=8, default_min_score=0.1, embedding_model="demo",
        )

        class Store:
            def __init__(self):
                self.manifest = manifest
                self.neighbor_calls = 0

            def status(self, *, validate=False):
                return {"ready": True, "document_count": 1}

            def search_vector(self, **kwargs):
                return [{
                    "chunk_id": "figure-hit",
                    "source_corpus_id": "book-a",
                    "doc_id": "doc-a",
                    "index": 10,
                    "score": 0.9,
                    "text": "图示说明",
                    "image_refs": [{
                        "path": "assets/a.jpg",
                        "caption": "图2-1 洗消流程图",
                        "page": 3,
                        "relation": "caption",
                    }],
                }]

            def search_lexical(self, **kwargs):
                return self.search_vector(**kwargs)

            def search_image_captions(self, **kwargs):
                return self.search_vector(**kwargs)

            def neighbor_chunks(self, **kwargs):
                self.neighbor_calls += 1
                return [{
                    "chunk_id": "neighbor",
                    "source_corpus_id": "book-a",
                    "doc_id": "doc-a",
                    "index": 11,
                    "score": 0.0,
                    "text": "相邻上下文",
                    "image_refs": [],
                }]

        return Store()

    def _process_store(self):
        manifest = SimpleNamespace(
            corpus_id="demo", version="v1", default_top_k=3,
            max_top_k=8, default_min_score=0.1, embedding_model="demo",
        )

        class Store:
            def __init__(self):
                self.manifest = manifest

            def status(self, *, validate=False):
                return {"ready": True, "document_count": 3}

            def search_vector(self, **kwargs):
                return [
                    {
                        "chunk_id": "a1",
                        "source_corpus_id": "book-a",
                        "doc_id": "doc-a",
                        "index": 10,
                        "score": 0.9,
                        "text": "第一步：先脱衣物。",
                        "image_refs": [],
                    },
                    {
                        "chunk_id": "b1",
                        "source_corpus_id": "book-b",
                        "doc_id": "doc-b",
                        "index": 20,
                        "score": 0.8,
                        "text": "别书的相近内容。",
                        "image_refs": [],
                    },
                ]

            def search_lexical(self, **kwargs):
                return self.search_vector(**kwargs)

            def neighbor_chunks(self, *, index, **kwargs):
                if index != 10:
                    return []
                return [
                    {
                        "chunk_id": "a0",
                        "source_corpus_id": "book-a",
                        "doc_id": "doc-a",
                        "index": 9,
                        "score": 0.0,
                        "text": "前一段：准备洗消场地。",
                        "image_refs": [],
                        "evidence_role": "context",
                    }
                ]

        return Store()

    def _wmd_source_routing_store(self):
        manifest = SimpleNamespace(
            corpus_id="demo", version="v1", default_top_k=3,
            max_top_k=8, default_min_score=0.1, embedding_model="demo",
        )

        class Store:
            def __init__(self):
                self.manifest = manifest
                self.lexical_top_k = None

            def status(self, *, validate=False):
                return {"ready": True, "document_count": 3}

            def search_vector(self, **kwargs):
                return self.search_lexical(**kwargs)

            def search_lexical(self, **kwargs):
                self.lexical_top_k = kwargs.get("top_k")
                return [
                    {
                        "chunk_id": "phtls-scene",
                        "source_corpus_id": "prehospital-trauma-life-support-7th-v1-cpu32",
                        "doc_id": "phtls",
                        "index": 100,
                        "score": 0.95,
                        "title": "军事医学丛书 院前创伤生命支持 第7版",
                        "section": "现场评估",
                        "text": "首要考虑是现场安全。",
                        "image_refs": [],
                    },
                    {
                        "chunk_id": "wmd-decon",
                        "source_corpus_id": "wmd-terror-response-v2-caption-cpu8",
                        "doc_id": "wmd",
                        "index": 200,
                        "score": 0.5,
                        "title": "大规模杀伤性武器与恐怖袭击应对手册",
                        "section": "洗消",
                        "text": "自我防护是首要任务，转运前要洗消。",
                        "image_refs": [],
                    },
                ]

            def neighbor_chunks(self, **kwargs):
                return []

        return Store()

    def _image_topic_filter_store(self):
        manifest = SimpleNamespace(
            corpus_id="demo", version="v1", default_top_k=5,
            max_top_k=8, default_min_score=0.1, embedding_model="demo",
        )

        class Store:
            def __init__(self):
                self.manifest = manifest

            def status(self, *, validate=False):
                return {"ready": True, "document_count": 2}

            def search_vector(self, **kwargs):
                return []

            def search_lexical(self, **kwargs):
                return [
                    {
                        "chunk_id": "unrelated-flowchart",
                        "source_corpus_id": "book-a",
                        "doc_id": "doc-a",
                        "index": 1,
                        "score": 0.2,
                        "text": "休克管理流程图。",
                        "image_refs": [{
                            "path": "assets/shock.jpg",
                            "caption": "图5-14 休克管理流程图",
                            "url": "/api/plugins/med-tools/rag-assets/assets/shock.jpg",
                            "available": True,
                        }],
                    },
                    {
                        "chunk_id": "decon-hit",
                        "source_corpus_id": "book-b",
                        "doc_id": "doc-b",
                        "index": 2,
                        "score": 0.1,
                        "text": "洗消站进行伤员洗消和去除污染。",
                        "image_refs": [{
                            "path": "assets/decon.jpg",
                            "caption": "图34-13 对伤员进行污染检测",
                            "url": "/api/plugins/med-tools/rag-assets/assets/decon.jpg",
                            "available": True,
                        }],
                    },
                ]

            def neighbor_chunks(self, **kwargs):
                return []

        return Store()

    @patch("server.rag.query.get_embedding_config", return_value={"model": "demo"})
    @patch("server.rag.query.embed_texts", return_value=[[1.0, 0.0]])
    def test_query_returns_interleave_context(self, _embed, _config):
        result = query_rag(query="图示", store=self._store())
        self.assertEqual(result["chunks"][0]["chunk_id"], "c1")
        self.assertEqual(
            [segment["type"] for segment in result["interleave_context"]],
            ["text", "image"],
        )
        self.assertEqual(result["interleave_context"][1]["path"], "images/a.jpg")

    @patch("server.rag.query.get_embedding_config", return_value={"model": "demo"})
    @patch("server.rag.query.embed_texts", return_value=[[1.0, 0.0]])
    def test_image_caption_query_promotes_caption_match(self, _embed, _config):
        result = query_rag(
            query="1917年美国军队戴防毒面罩训练这张图说明什么",
            store=self._caption_boost_store(),
        )
        self.assertEqual(result["chunks"][0]["chunk_id"], "caption-match")
        self.assertTrue(result["image_match"]["exact_figure_match"])
        self.assertEqual(
            result["chunks"][0]["display_assets"][0]["caption"],
            "图1-1 1917年美国军队戴防毒面罩训练",
        )
        self.assertEqual(
            result["interleave_context"][1]["caption"],
            "图1-1 1917年美国军队戴防毒面罩训练",
        )

    @patch("server.rag.query.get_embedding_config", return_value={"model": "demo"})
    @patch("server.rag.query.embed_texts", return_value=[[1.0, 0.0]])
    def test_pure_image_query_does_not_collect_neighbor_context(self, _embed, _config):
        store = self._image_context_store()
        result = query_rag(query="图2-1", store=store)
        self.assertEqual(result["retrieval_intent"], "image")
        self.assertEqual(result["context_chunks"], [])
        self.assertEqual(store.neighbor_calls, 0)
        self.assertTrue(result["image_match"]["exact_figure_match"])

    def test_flowchart_process_query_gets_composite_intent(self) -> None:
        self.assertEqual(_query_intent("洗消流程图说明了哪些关键环节"), "image_process")

    @patch("server.rag.query.get_embedding_config", return_value={"model": "demo"})
    @patch("server.rag.query.embed_texts", side_effect=ValueError("offline"))
    def test_image_process_lexical_fallback_filters_generic_flowcharts(self, _embed, _config):
        result = query_rag(
            query="防化服或洗消流程图说明了哪些关键环节",
            store=self._image_topic_filter_store(),
        )
        self.assertEqual([item["chunk_id"] for item in result["chunks"]], ["decon-hit"])
        self.assertTrue(any("lexical-fallback" in warning for warning in result["warnings"]))
        self.assertFalse(any("topic filter removed" in warning for warning in result["warnings"]))

    @patch("server.rag.query.get_embedding_config", return_value={"model": "demo"})
    @patch("server.rag.query.embed_texts", return_value=[[1.0, 0.0]])
    def test_process_query_collects_context_from_single_source(self, _embed, _config):
        result = query_rag(query="化学污染人员洗消的基本步骤是什么", store=self._process_store())
        self.assertEqual([item["source_corpus_id"] for item in result["chunks"]], ["book-a"])
        self.assertEqual(result["dominant_source_corpus_id"], "book-a")
        self.assertEqual(result["context_chunks"][0]["chunk_id"], "a0")
        self.assertEqual(result["context_chunks"][0]["evidence_role"], "context")

    def test_wmd_multihazard_query_routes_to_wmd_source_in_lexical_mode(self) -> None:
        store = self._wmd_source_routing_store()
        result = query_rag(
            query="生物、化学、放射、爆炸袭击的初始处置优先顺序是什么？",
            prefer_lexical=True,
            store=store,
        )
        self.assertEqual(store.lexical_top_k, 32)
        self.assertEqual([item["chunk_id"] for item in result["chunks"]], ["wmd-decon"])
        self.assertEqual(
            result["source_routing"]["preferred_source_corpus_id"],
            "wmd-terror-response-v2-caption-cpu8",
        )
        self.assertTrue(result["source_routing"]["applied"])

    def test_explicit_phtls_source_overrides_wmd_multihazard_routing(self) -> None:
        result = query_rag(
            query="按院前创伤生命支持回答：生物、化学、放射、爆炸袭击的初始处置优先顺序是什么？",
            prefer_lexical=True,
            store=self._wmd_source_routing_store(),
        )
        self.assertEqual([item["chunk_id"] for item in result["chunks"]], ["phtls-scene"])
        self.assertEqual(
            result["source_routing"]["preferred_source_corpus_id"],
            "prehospital-trauma-life-support-7th-v1-cpu32",
        )
        self.assertTrue(result["source_routing"]["applied"])


if __name__ == "__main__":
    unittest.main()
