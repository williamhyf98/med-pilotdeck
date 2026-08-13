from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient

from medical_sidecar.api.app import create_app
from medical_sidecar.config import ImagingLimits, RagLimits, SidecarSettings
from medical_sidecar.imaging.volume import VolumeLimits, prepare_volume
from medical_sidecar.rag.artifacts import RagArtifactLoader
from medical_sidecar.rag.contracts import RagQuery
from fixtures import npy_bytes


class RagArtifactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.corpus_path = root / "corpus.jsonl"
        records = [
            {
                "chunk_id": "c1",
                "title": "人工资料",
                "chapter_path": "第一章",
                "source_file": "synthetic-a",
                "contents": "与第一个向量相符的合成文本。",
                "metadata": {"topic": "a"},
            },
            {
                "chunk_id": "c2",
                "title": "人工资料",
                "chapter_path": "第二章",
                "source_file": "synthetic-b",
                "contents": "与第二个向量相符的合成文本。",
                "metadata": {"topic": "b"},
            },
            {
                "chunk_id": "c3",
                "title": "人工资料",
                "chapter_path": "第三章",
                "source_file": "synthetic-c",
                "contents": "低相关合成文本。",
                "metadata": {"topic": "c"},
            },
        ]
        self.corpus_path.write_text(
            "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in records),
            encoding="utf-8",
        )
        self.embedding_path = root / "embeddings.npy"
        self.embedding_path.write_bytes(
            npy_bytes((3, 2), [1.0, 0.0, 0.8, 0.2, 0.0, 1.0])
        )
        self.rag = RagLimits(
            corpus_id="synthetic",
            version="v1",
            corpus_path=str(self.corpus_path),
            embedding_path=str(self.embedding_path),
            corpus_sha256=_sha256(self.corpus_path.read_bytes()),
            embedding_sha256=_sha256(self.embedding_path.read_bytes()),
            embedding_model="synthetic-2d",
            license_id="synthetic-test-only",
            default_min_score=0.5,
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_lazy_loader_validates_hash_rows_and_dimension_then_searches(self) -> None:
        loader = RagArtifactLoader(self.rag)
        self.assertIsNone(loader._chunks)
        status = loader.status(validate=True)
        self.assertTrue(status["ready"])
        self.assertEqual(status["documentCount"], 3)
        self.assertEqual(status["dimension"], 2)
        result = loader.search(
            query_vector=[1.0, 0.0],
            query=RagQuery("synthetic query", "synthetic", top_k=2, min_score=0.5),
        )
        self.assertEqual([item.chunk_id for item in result.items], ["c1", "c2"])
        self.assertEqual(result.corpus_version, "v1")

    def test_hash_mismatch_is_unavailable_without_exposing_path(self) -> None:
        broken = RagLimits(
            **{
                **self.rag.__dict__,
                "corpus_sha256": "0" * 64,
            }
        )
        status = RagArtifactLoader(broken).status(validate=True)
        self.assertFalse(status["ready"])
        self.assertEqual(status["reason"], "artifact_validation_failed")
        self.assertNotIn(str(self.corpus_path), status["error"])

    def test_line_count_and_query_dimension_are_validated(self) -> None:
        mismatch_path = self.embedding_path.with_name("two-rows.npy")
        mismatch_path.write_bytes(npy_bytes((2, 2), [1.0, 0.0, 0.0, 1.0]))
        mismatch = RagLimits(
            **{
                **self.rag.__dict__,
                "embedding_path": str(mismatch_path),
                "embedding_sha256": _sha256(mismatch_path.read_bytes()),
            }
        )
        status = RagArtifactLoader(mismatch).status(validate=True)
        self.assertFalse(status["ready"])
        self.assertIn("line count", status["error"])

        loader = RagArtifactLoader(self.rag)
        with self.assertRaisesRegex(ValueError, "dimension must be 2"):
            loader.search(
                query_vector=[1.0],
                query=RagQuery("synthetic query", "synthetic", top_k=1, min_score=0),
            )

    def test_rest_rag_route_uses_real_artifacts(self) -> None:
        client = TestClient(
            create_app(SidecarSettings(rag=self.rag)),
            base_url="http://localhost",
        )
        corpora = client.get("/v1/rag/corpora").json()
        self.assertTrue(corpora["corpora"][0]["ready"])
        response = client.post(
            "/v1/rag/search",
            json={
                "query": "synthetic query",
                "corpusId": "synthetic",
                "queryVector": [1.0, 0.0],
                "topK": 2,
                "minScore": 0.5,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [item["chunk_id"] for item in response.json()["result"]["items"]],
            ["c1", "c2"],
        )


class VolumePreparationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.volume = npy_bytes(
            (2, 2, 2),
            [-1000.0, -500.0, 0.0, 500.0, 1000.0, 1500.0, 2000.0, 2500.0],
        )

    def test_npy_volume_metadata_and_previews_need_no_numpy_dependency(self) -> None:
        result = prepare_volume(
            self.volume,
            filename="synthetic.npy",
            limits=VolumeLimits(
                max_volume_bytes=1024 * 1024,
                max_voxels=100,
                max_preview_slices=8,
            ),
            requested_slices=2,
        )
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["volume"]["original_shape"], [2, 2, 2])
        self.assertEqual(len(result["previews"]), 2)
        preview = base64.b64decode(result["previews"][0]["data"])
        self.assertTrue(preview.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertFalse(result["previews"][0]["diagnostic_grade"])

    def test_volume_rest_route_prepares_real_npy(self) -> None:
        settings = SidecarSettings(
            imaging=ImagingLimits(
                max_volume_bytes=1024 * 1024,
                max_voxels=100,
                max_preview_slices=8,
            )
        )
        client = TestClient(create_app(settings), base_url="http://localhost")
        response = client.post(
            "/v1/imaging/volume/prepare",
            json={
                "name": "synthetic.npy",
                "data": base64.b64encode(self.volume).decode("ascii"),
                "maxSlices": 2,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["volume"]["orig_shape"], [2, 2, 2])

    def test_attachment_rest_route_returns_real_parse_result(self) -> None:
        client = TestClient(create_app(), base_url="http://localhost")
        response = client.post(
            "/v1/attachments/prepare",
            json={
                "attachments": [
                    {
                        "name": "synthetic.txt",
                        "mimeType": "text/plain",
                        "data": base64.b64encode("人工文本".encode()).decode("ascii"),
                    }
                ]
            },
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["parsing_performed"])
        self.assertEqual(body["artifacts"][0]["status"], "ready")
        self.assertIn("人工文本", body["artifacts"][0]["summary"])


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


if __name__ == "__main__":
    unittest.main()

