from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from medical_sidecar.api.app import create_app


class MedicalSidecarApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(create_app(), base_url="http://localhost")

    def test_versioned_health_advertises_only_available_contracts(self) -> None:
        response = self.client.get("/v1/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["localhost_only"])
        self.assertFalse(body["capabilities"]["rag"])
        self.assertTrue(body["capabilities"]["tables"])

    def test_table_prepare_neutralizes_formulas(self) -> None:
        response = self.client.post(
            "/v1/tables/prepare",
            json={
                "table": {
                    "columns": ["name", "value"],
                    "rows": [["heart-rate", "=1+1"]],
                }
            },
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["formula_injection_protection"])
        self.assertIn("'=1+1", body["csv"])

    def test_unconfigured_rag_is_honestly_unavailable(self) -> None:
        corpora = self.client.get("/v1/rag/corpora")
        self.assertEqual(corpora.status_code, 200)
        self.assertFalse(corpora.json()["corpora"][0]["ready"])
        self.assertEqual(
            corpora.json()["corpora"][0]["reason"],
            "corpus_not_configured",
        )
        search = self.client.post(
            "/v1/rag/search",
            json={"query": "synthetic", "queryVector": [1.0]},
        )
        self.assertEqual(search.status_code, 503)
        self.assertEqual(search.json()["detail"]["code"], "rag_unavailable")

    def test_table_prepare_rejects_scalar_rows(self) -> None:
        response = self.client.post(
            "/v1/tables/prepare",
            json={"table": {"columns": ["name"], "rows": ["not-a-row"]}},
        )
        self.assertEqual(response.status_code, 422)

    def test_declared_request_body_over_budget_is_rejected_before_parsing(self) -> None:
        response = self.client.post(
            "/v1/attachments/prepare",
            content=b"{}",
            headers={
                "content-type": "application/json",
                "content-length": str(500 * 1024 * 1024),
            },
        )
        self.assertEqual(response.status_code, 413)

    def test_volume_contract_is_exposed_through_rest(self) -> None:
        response = self.client.post(
            "/v1/imaging/volume/validate",
            json={
                "metadata": {
                    "volume_id": "synthetic-volume",
                    "filename": "synthetic.nii.gz",
                    "extension": ".nii.gz",
                    "original_shape": [32, 32, 16],
                    "spacing": [1, 1, 2],
                    "modality": "CT",
                    "preview_slices": 8,
                    "thumbnail_index": 4,
                    "value_range": [-1000, 2000],
                    "byte_size": 1024,
                    "sha256": "0" * 64,
                }
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["volume"]["volume_id"], "synthetic-volume")


if __name__ == "__main__":
    unittest.main()
