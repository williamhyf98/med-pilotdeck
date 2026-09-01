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

RAG_SERVICE_ENV_KEYS = (
    "MED_RAG_SERVICE_ENABLED",
    "MED_RAG_SERVICE_API_BASE",
    "MED_RAG_SERVICE_ENDPOINT",
    "MED_RAG_SERVICE_HEALTH_ENDPOINT",
    "MED_RAG_SERVICE_TIMEOUT_SECONDS",
    "MED_RAG_SERVICE_MAX_CHARS_PER_CHUNK",
    "MED_RAG_SERVICE_API_KEY",
    "MED_RAG_TOPIC",
)


def _clear_rag_service_env() -> None:
    for key in RAG_SERVICE_ENV_KEYS:
        os.environ.pop(key, None)


def _remote_result(index: int, **overrides: object) -> dict:
    """One /retrieve result row; scores mimic the service's RRF scale."""

    row = {
        "rank": index + 1,
        "score": 0.016_393,  # RRF fusion value — far below the local 0.35 floor
        "chunk_id": f"war_trauma_chunk_{index:07d}",
        "doc_id": f"doc_{index}",
        "title": "中华战创伤学 第三卷",
        "section_title": f"第{index + 1}章 战场急救",
        "data_layer": "教材",
        "evidence_grade": "B",
        "evidence_quality": "中",
        "evidence_ids": ["ev-1"],
        "retrieval_blocked_by_assets": False,
        "topic": "战创伤",
        "text": f"远端检索到的战创伤条文 {index}",
        "rerank_score": 3.5 - index,
        "rerank_rank": index + 1,
    }
    row.update(overrides)
    return row


class TraumaRagFixtureTests(unittest.TestCase):
    def setUp(self) -> None:
        os.environ["MED_RAG_MANIFEST"] = str(FIXTURE_MANIFEST)
        # Keep the legacy local-path tests hermetic: no outbound rag service.
        _clear_rag_service_env()
        os.environ["MED_RAG_SERVICE_ENABLED"] = "0"
        from server.rag import store as store_mod

        store_mod.reset_default_store_for_tests()

    def tearDown(self) -> None:
        from server.rag import store as store_mod

        store_mod.reset_default_store_for_tests()
        os.environ.pop("MED_RAG_MANIFEST", None)
        _clear_rag_service_env()

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


class RemoteRagServiceTests(unittest.TestCase):
    """Remote-first retrieval with local degradation (no network touched)."""

    def setUp(self) -> None:
        os.environ["MED_RAG_MANIFEST"] = str(FIXTURE_MANIFEST)
        _clear_rag_service_env()
        os.environ["MED_RAG_SERVICE_ENABLED"] = "1"
        from server.rag import store as store_mod

        store_mod.reset_default_store_for_tests()

    def tearDown(self) -> None:
        from server.rag import store as store_mod

        store_mod.reset_default_store_for_tests()
        os.environ.pop("MED_RAG_MANIFEST", None)
        _clear_rag_service_env()

    def test_remote_hit_and_field_mapping(self) -> None:
        from server.rag import query_rag

        body = {"question": "q", "top_k": 3, "results": [_remote_result(0), _remote_result(1)]}
        with mock.patch("server.rag.query.retrieve_remote", return_value=body):
            result = query_rag(query="战创伤四级救治", top_k=3)

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["mode"], "remote")
        self.assertEqual(result["retrieval_backend"], "remote")
        self.assertEqual(result["topic"], "战创伤")
        self.assertEqual(result["chunk_count"], 2)
        self.assertEqual(result["generation_owner"], "pilotdeck")

        top = result["chunks"][0]
        self.assertEqual(top["rank"], 1)
        # section_title is remapped onto the local `section` key the skill cites.
        self.assertEqual(top["section"], "第1章 战场急救")
        self.assertEqual(top["chunk_id"], "war_trauma_chunk_0000000")
        self.assertEqual(top["title"], "中华战创伤学 第三卷")
        self.assertEqual(top["evidence_grade"], "B")
        self.assertEqual(top["topic"], "战创伤")
        self.assertEqual(top["rerank_score"], 3.5)
        # Local-only keys stay present so downstream sees one schema.
        for key in ("volume", "source", "preview", "index", "doc_id", "text"):
            self.assertIn(key, top)

    def test_remote_results_survive_local_min_score(self) -> None:
        """RRF scores (~0.016) must not be filtered by the cosine floor (0.35)."""
        from server.rag import query_rag

        body = {"results": [_remote_result(0), _remote_result(1)]}
        with mock.patch("server.rag.query.retrieve_remote", return_value=body):
            result = query_rag(query="止血带", top_k=3, min_score=0.35)

        self.assertEqual(result["mode"], "remote")
        self.assertEqual(result["chunk_count"], 2)
        self.assertIsNone(result["min_score"])
        self.assertLess(result["chunks"][0]["score"], 0.35)

    def test_remote_reranked_count_is_clamped_to_top_k(self) -> None:
        from server.rag import query_rag

        body = {"results": [_remote_result(i) for i in range(5)]}
        with mock.patch("server.rag.query.retrieve_remote", return_value=body):
            result = query_rag(query="气道", top_k=3)

        self.assertEqual(result["chunk_count"], 3)
        self.assertEqual(result["top_k"], 3)
        self.assertEqual([c["rank"] for c in result["chunks"]], [1, 2, 3])

    def test_remote_missing_rerank_fields(self) -> None:
        from server.rag import query_rag

        raw = _remote_result(0)
        raw.pop("rerank_score")
        raw.pop("rerank_rank")
        with mock.patch("server.rag.query.retrieve_remote", return_value={"results": [raw]}):
            result = query_rag(query="止血", top_k=2)

        self.assertEqual(result["mode"], "remote")
        self.assertNotIn("rerank_score", result["chunks"][0])
        self.assertNotIn("rerank_rank", result["chunks"][0])

    def test_remote_recovers_section_from_text_preamble(self) -> None:
        """Live service returns section_title="" and puts 卷/章节 in the body."""
        from server.rag import query_rag

        raw = _remote_result(
            0,
            section_title="",
            data_layer="",
            evidence_grade="",
            text=(
                "卷：第2卷\n"
                "章节：第八章 颅脑战创伤战现场急救及转运 > 第一节战现场急救及转运 "
                "> 四、颅脑战伤的阶梯救治模式\n"
                "\n"
                "实行四级救治阶梯,即连、营急救机构(Ⅰ级)、师救护所(Ⅱ级)。\n"
                "【章节：不应被当成前言的正文标记】"
            ),
        )
        with mock.patch("server.rag.query.retrieve_remote", return_value={"results": [raw]}):
            result = query_rag(query="战创伤四级救治", top_k=1)

        chunk = result["chunks"][0]
        self.assertEqual(chunk["volume"], "第2卷")
        self.assertTrue(chunk["section"].startswith("第八章 颅脑战创伤战现场急救及转运"))
        self.assertIn("四、颅脑战伤的阶梯救治模式", chunk["section"])
        self.assertNotIn("不应被当成前言", chunk["section"])
        # Evidence text itself is never mutated.
        self.assertTrue(chunk["text"].startswith("卷：第2卷"))

    def test_preamble_parser_edge_cases(self) -> None:
        from server.rag.rag_service_client import _split_preamble

        self.assertEqual(_split_preamble("卷：第7卷\n章节：第一篇 概论 > 第六章\n\n正文"),
                         ("第7卷", "第一篇 概论 > 第六章"))
        # No preamble at all -> both empty, body untouched.
        self.assertEqual(_split_preamble("直接是正文内容\n第二行"), ("", ""))
        # Body-embedded 【章节：...】 markers must not be picked up.
        self.assertEqual(_split_preamble("【章节：正文标记】\n更多正文"), ("", ""))
        self.assertEqual(_split_preamble(""), ("", ""))

    def test_remote_failure_falls_back_to_local_vector(self) -> None:
        from server.rag import query_rag
        from server.rag.rag_service_client import RagServiceError
        from server.rag.store import get_default_store

        store = get_default_store()
        store.status(validate=True)
        row0 = np.asarray(store._matrix[0], dtype=np.float32).tolist()  # type: ignore[index]

        with mock.patch(
            "server.rag.query.retrieve_remote",
            side_effect=RagServiceError("ReadTimeout: timed out"),
        ), mock.patch("server.rag.query.embed_texts", return_value=[row0]):
            result = query_rag(query="任意", top_k=2, min_score=0.0)

        self.assertEqual(result["mode"], "vector")
        self.assertEqual(result["retrieval_backend"], "local")
        self.assertTrue(
            any("remote rag service unavailable" in w for w in result["warnings"])
        )
        self.assertEqual(result["chunks"][0]["chunk_id"], "fix_000")

    def test_remote_502_then_embedding_failure_falls_back_to_lexical(self) -> None:
        from server.rag import query_rag
        from server.rag.embedding_client import EmbeddingError
        from server.rag.rag_service_client import RagServiceError

        with mock.patch(
            "server.rag.query.retrieve_remote",
            side_effect=RagServiceError("HTTP 502: milvus down"),
        ), mock.patch(
            "server.rag.query.embed_texts", side_effect=EmbeddingError("boom")
        ):
            result = query_rag(query="气道梗阻通气", top_k=2)

        self.assertEqual(result["mode"], "lexical-fallback")
        self.assertEqual(result["retrieval_backend"], "local")
        warnings = " ".join(result["warnings"])
        self.assertIn("remote rag service unavailable", warnings)
        self.assertIn("lexical-fallback", warnings)
        self.assertIn("气道", result["chunks"][0]["text"])

    def test_remote_topic_not_applied_warning_on_fallback(self) -> None:
        from server.rag import query_rag
        from server.rag.rag_service_client import RagServiceError

        with mock.patch(
            "server.rag.query.retrieve_remote",
            side_effect=RagServiceError("ConnectError: refused"),
        ), mock.patch("server.rag.query.embed_texts", side_effect=OSError("no net")):
            result = query_rag(query="止血带", top_k=2, topic="军事医学")

        self.assertEqual(result["retrieval_backend"], "local")
        self.assertTrue(
            any("was not applied" in w for w in result["warnings"]), result["warnings"]
        )

    def test_remote_zero_results_does_not_fall_back(self) -> None:
        from server.rag import query_rag

        with mock.patch(
            "server.rag.query.retrieve_remote", return_value={"results": []}
        ) as remote, mock.patch("server.rag.query.embed_texts") as embed:
            result = query_rag(query="不存在的主题", top_k=3)

        self.assertEqual(result["mode"], "remote")
        self.assertEqual(result["chunk_count"], 0)
        self.assertEqual(remote.call_count, 1)
        embed.assert_not_called()
        self.assertTrue(any("returned 0 chunks" in w for w in result["warnings"]))

    def test_disabled_switch_skips_remote(self) -> None:
        from server.rag import query_rag
        from server.rag.store import get_default_store

        os.environ["MED_RAG_SERVICE_ENABLED"] = "0"
        store = get_default_store()
        store.status(validate=True)
        row0 = np.asarray(store._matrix[0], dtype=np.float32).tolist()  # type: ignore[index]

        with mock.patch("server.rag.query.retrieve_remote") as remote, mock.patch(
            "server.rag.query.embed_texts", return_value=[row0]
        ):
            result = query_rag(query="任意", top_k=2, min_score=0.0)

        remote.assert_not_called()
        self.assertEqual(result["mode"], "vector")

    def test_prefer_lexical_skips_remote(self) -> None:
        from server.rag import query_rag

        with mock.patch("server.rag.query.retrieve_remote") as remote:
            result = query_rag(query="大出血止血带", prefer_lexical=True, top_k=2)

        remote.assert_not_called()
        self.assertEqual(result["mode"], "lexical")

    def test_topic_passed_through_to_request(self) -> None:
        from server.app import med_trauma_rag_query

        with mock.patch(
            "server.rag.query.retrieve_remote", return_value={"results": [_remote_result(0)]}
        ) as remote:
            payload = json.loads(med_trauma_rag_query(query="止血", top_k=2, topic=""))

        self.assertEqual(remote.call_args.kwargs["topic"], "")
        self.assertEqual(payload["tool"], "med_trauma_rag_query")
        self.assertEqual(payload["mode"], "remote")

    def test_status_reports_remote_service(self) -> None:
        from server.rag import rag_status

        with mock.patch(
            "server.rag.query.remote_health",
            return_value={"ok": True, "error": "", "info": {"status": "ok"}},
        ):
            status = rag_status(validate=False, probe_remote=True)

        self.assertTrue(status["rag_service"]["enabled"])
        self.assertTrue(status["rag_service"]["reachable"])
        self.assertEqual(status["active_backend"], "remote")

    def test_status_marks_local_when_remote_down(self) -> None:
        from server.rag import rag_status

        with mock.patch(
            "server.rag.query.remote_health",
            return_value={"ok": False, "error": "ConnectError", "info": None},
        ):
            status = rag_status(validate=False, probe_remote=True)

        self.assertFalse(status["rag_service"]["reachable"])
        self.assertEqual(status["active_backend"], "local")


class RagServiceClientTests(unittest.TestCase):
    def setUp(self) -> None:
        _clear_rag_service_env()

    def tearDown(self) -> None:
        _clear_rag_service_env()

    def test_config_defaults(self) -> None:
        from server.rag.rag_service_client import get_rag_service_config

        cfg = get_rag_service_config()
        self.assertTrue(cfg["enabled"])
        self.assertEqual(cfg["api_base"], "http://127.0.0.1:18080")
        self.assertEqual(cfg["endpoint"], "http://127.0.0.1:18080/retrieve")
        self.assertEqual(cfg["health_endpoint"], "http://127.0.0.1:18080/health")
        self.assertEqual(cfg["timeout_seconds"], 90.0)

    def test_config_derives_urls_from_base(self) -> None:
        from server.rag.rag_service_client import get_rag_service_config

        os.environ["MED_RAG_SERVICE_API_BASE"] = "http://10.0.0.5:9000/"
        cfg = get_rag_service_config()
        self.assertEqual(cfg["endpoint"], "http://10.0.0.5:9000/retrieve")
        self.assertEqual(cfg["health_endpoint"], "http://10.0.0.5:9000/health")

    def test_resolve_topic_states(self) -> None:
        from server.rag.rag_service_client import resolve_topic

        self.assertEqual(resolve_topic(None), "战创伤")
        self.assertEqual(resolve_topic("军事医学"), "军事医学")
        self.assertEqual(resolve_topic(""), "")
        self.assertEqual(resolve_topic("全库"), "")
        self.assertEqual(resolve_topic("all"), "")
        os.environ["MED_RAG_TOPIC"] = "未分类"
        self.assertEqual(resolve_topic(None), "未分类")
        os.environ["MED_RAG_TOPIC"] = ""
        self.assertEqual(resolve_topic(None), "")

    def test_retrieve_remote_sends_topic_and_top_k(self) -> None:
        import httpx

        from server.rag import rag_service_client as client_mod

        response = httpx.Response(
            200,
            json={"results": [_remote_result(0)]},
            request=httpx.Request("POST", "http://127.0.0.1:18080/retrieve"),
        )
        fake = mock.MagicMock()
        fake.__enter__.return_value.post.return_value = response
        with mock.patch.object(client_mod.httpx, "Client", return_value=fake):
            body = client_mod.retrieve_remote(query="止血带", top_k=3, topic="")

        sent = fake.__enter__.return_value.post.call_args.kwargs["json"]
        self.assertEqual(sent["query"], "止血带")
        self.assertEqual(sent["top_k"], 3)
        self.assertEqual(sent["topic"], "")  # explicit empty = whole library
        self.assertEqual(sent["max_chars_per_chunk"], 1800)
        self.assertEqual(len(body["results"]), 1)

    def test_retrieve_remote_raises_on_502(self) -> None:
        import httpx

        from server.rag import rag_service_client as client_mod

        response = httpx.Response(
            502,
            json={"detail": "milvus connection refused"},
            request=httpx.Request("POST", "http://127.0.0.1:18080/retrieve"),
        )
        fake = mock.MagicMock()
        fake.__enter__.return_value.post.return_value = response
        with mock.patch.object(client_mod.httpx, "Client", return_value=fake):
            with self.assertRaises(client_mod.RagServiceError) as ctx:
                client_mod.retrieve_remote(query="止血带", top_k=3, topic="战创伤")

        message = str(ctx.exception)
        self.assertIn("502", message)
        self.assertIn("milvus connection refused", message)

    def test_retrieve_remote_raises_on_malformed_body(self) -> None:
        import httpx

        from server.rag import rag_service_client as client_mod

        response = httpx.Response(
            200,
            json={"unexpected": True},
            request=httpx.Request("POST", "http://127.0.0.1:18080/retrieve"),
        )
        fake = mock.MagicMock()
        fake.__enter__.return_value.post.return_value = response
        with mock.patch.object(client_mod.httpx, "Client", return_value=fake):
            with self.assertRaises(client_mod.RagServiceError):
                client_mod.retrieve_remote(query="止血带", top_k=3, topic="战创伤")

    def test_remote_health_never_raises(self) -> None:
        from server.rag import rag_service_client as client_mod

        fake = mock.MagicMock()
        fake.__enter__.return_value.get.side_effect = OSError("refused")
        with mock.patch.object(client_mod.httpx, "Client", return_value=fake):
            probe = client_mod.remote_health(timeout=1.0)

        self.assertFalse(probe["ok"])
        self.assertIn("refused", probe["error"])


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
