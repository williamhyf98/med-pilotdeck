from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from urllib.error import URLError

from fastapi.testclient import TestClient

from fixtures import npy_bytes
from medical_sidecar.api.app import create_app
from medical_sidecar.clinical.workflows import (
    ClinicalWorkflow,
    build_clinical_prompt,
    contract_document,
    parse_clinical_output,
)
from medical_sidecar.config import (
    GalleryDatasetSettings,
    GallerySettings,
    ImagingLimits,
    M3DSettings,
    RagLimits,
    SidecarSettings,
    VolumeStorageSettings,
    WorkflowLimits,
)
from medical_sidecar.imaging.gallery import GalleryScanner
from medical_sidecar.imaging.m3d import M3DClient, M3DUnavailableError
from medical_sidecar.imaging.volume_store import VolumeNotFoundError, VolumeStore
from medical_sidecar.mcp import tools
from medical_sidecar.rag.artifacts import RagArtifactLoader
from medical_sidecar.table.contracts import TableBudget
from medical_sidecar.table.ocr import build_table_ocr_prompt, parse_table_ocr_output


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class GalleryAndPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        case = self.root / "gallery" / "synthetic" / "case-1"
        case.mkdir(parents=True)
        (case / "slice-001.png").write_bytes(PNG_1X1)
        (case / "report.txt").write_text("synthetic report", encoding="utf-8")
        settings = GallerySettings(
            enabled=True,
            datasets=(
                GalleryDatasetSettings(
                    dataset_id="synthetic",
                    path="synthetic",
                    modality="CT",
                    version="v1",
                    license_id="synthetic-only",
                ),
            ),
        )
        self.scanner = GalleryScanner(
            settings,
            ImagingLimits(max_gallery_slices=8),
            data_root=str(self.root),
            max_pixels=100,
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_gallery_scans_datasets_cases_and_normalized_slices(self) -> None:
        datasets = self.scanner.list_datasets()
        self.assertTrue(datasets["datasets"][0]["available"])
        cases = self.scanner.list_cases("synthetic")
        self.assertEqual(cases["cases"][0]["case_id"], "case-1")
        self.assertFalse(cases["storage_paths_exposed"])
        self.assertNotIn(str(self.root), json.dumps(cases))
        self.assertTrue(all("path" not in item for item in cases["cases"]))
        case = self.scanner.get_case("synthetic", "case-1")
        self.assertEqual(case["case"]["n_slices"], 1)
        rendered = self.scanner.get_slice("synthetic", "case-1", 0)
        self.assertEqual(rendered["media_type"], "image/png")
        self.assertFalse(rendered["diagnostic_grade"])

    def test_configured_paths_reject_traversal_and_phi_persistence_is_opt_in(self) -> None:
        with self.assertRaises(ValueError):
            SidecarSettings.from_mapping(
                {
                    "data": {"root": str(self.root)},
                    "gallery": {
                        "enabled": True,
                        "datasets": [
                            {
                                "id": "synthetic",
                                "path": "../escape",
                                "version": "v1",
                                "license_id": "synthetic-only",
                            }
                        ],
                    },
                }
            )
        with self.assertRaisesRegex(ValueError, "persist_phi=true"):
            SidecarSettings.from_mapping(
                {
                    "data": {"root": str(self.root)},
                    "volume_storage": {
                        "mode": "filesystem",
                        "root": "volumes",
                        "persist_phi": False,
                    },
                }
            )


class VolumeStorageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.volume = npy_bytes((2, 2, 2), range(8))
        self.store = VolumeStore(
            VolumeStorageSettings(
                mode="temporary",
                default_ttl_seconds=5,
                max_ttl_seconds=30,
                max_items=4,
                max_stored_bytes=1024 * 1024,
            ),
            ImagingLimits(
                max_volume_bytes=1024 * 1024,
                max_voxels=100,
                max_preview_slices=8,
            ),
            data_root=None,
            clock=lambda: self.now,
        )

    def test_temporary_store_lists_details_slices_and_expires(self) -> None:
        uploaded = self.store.upload(
            self.volume,
            filename="synthetic.npy",
            requested_slices=2,
        )
        volume_id = uploaded["volume"]["volume_id"]
        self.assertFalse(uploaded["retention"]["phi_persisted"])
        self.assertEqual(len(self.store.list()["volumes"]), 1)
        self.assertEqual(self.store.get(volume_id)["volume"]["volume_id"], volume_id)
        rendered = self.store.slice(volume_id, 1)
        self.assertEqual(rendered["slice"]["source_index"], 1)
        self.now += timedelta(seconds=6)
        self.assertEqual(self.store.list()["volumes"], [])
        with self.assertRaises(VolumeNotFoundError):
            self.store.get(volume_id)

    def test_rest_upload_list_slice_and_delete(self) -> None:
        settings = SidecarSettings(
            imaging=ImagingLimits(
                max_volume_bytes=1024 * 1024,
                max_voxels=100,
                max_preview_slices=8,
            ),
            volume_storage=VolumeStorageSettings(
                mode="temporary",
                max_stored_bytes=1024 * 1024,
            ),
        )
        client = TestClient(create_app(settings), base_url="http://localhost")
        response = client.post(
            "/v1/imaging/volumes",
            json={
                "name": "synthetic.npy",
                "data": base64.b64encode(self.volume).decode("ascii"),
                "maxSlices": 2,
            },
        )
        self.assertEqual(response.status_code, 200)
        volume_id = response.json()["volume"]["volume_id"]
        self.assertEqual(len(client.get("/v1/imaging/volumes").json()["volumes"]), 1)
        slice_response = client.get(f"/v1/imaging/volumes/{volume_id}/slices/1")
        self.assertEqual(slice_response.status_code, 200)
        self.assertEqual(
            client.delete(f"/v1/imaging/volumes/{volume_id}").status_code,
            200,
        )

    def test_explicit_filesystem_store_survives_reload_without_exposing_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = VolumeStorageSettings(
                mode="filesystem",
                root="volumes",
                persist_phi=True,
                default_ttl_seconds=30,
                max_ttl_seconds=60,
                max_stored_bytes=1024 * 1024,
            )
            limits = ImagingLimits(
                max_volume_bytes=1024 * 1024,
                max_voxels=100,
                max_preview_slices=8,
            )
            first = VolumeStore(
                settings,
                limits,
                data_root=temp,
                clock=lambda: self.now,
            )
            uploaded = first.upload(
                self.volume,
                filename="synthetic.npy",
                requested_slices=1,
            )
            volume_id = uploaded["volume"]["volume_id"]
            second = VolumeStore(
                settings,
                limits,
                data_root=temp,
                clock=lambda: self.now,
            )
            listed = second.list()
            self.assertEqual(listed["volumes"][0]["volume_id"], volume_id)
            self.assertTrue(listed["volumes"][0]["phi_persisted"])
            self.assertNotIn(str(temp), json.dumps(listed))
            second.delete(volume_id)
            self.assertEqual(second.list()["volumes"], [])


class PromptContractTests(unittest.TestCase):
    def test_table_ocr_prompt_and_parser_are_versioned(self) -> None:
        prompt = build_table_ocr_prompt(
            [{"image_id": "table-1", "page": 0}],
            language="zh-CN",
        )
        self.assertEqual(prompt["contract_version"], "table-ocr.v1")
        self.assertEqual(prompt["generation_owner"], "pilotdeck")
        parsed = parse_table_ocr_output(
            '{"title":"合成表","columns":["A"],"rows":[["1"]]}',
            budget=TableBudget(max_columns=4, max_rows=4),
        )
        self.assertEqual(parsed["status"], "parsed")
        self.assertEqual(parsed["table"]["rows"], [["1"]])

    def test_all_clinical_workflows_expose_structured_prompts(self) -> None:
        limits = WorkflowLimits()
        payloads = {
            ClinicalWorkflow.TREATMENT_PLAN: {
                "sources": [
                    {"id": "s1", "content": "synthetic source one"},
                    {"id": "s2", "content": "synthetic source two"},
                ]
            },
            ClinicalWorkflow.TRANSLATION: {
                "text": "synthetic medical text",
                "target_language": "zh-CN",
            },
            ClinicalWorkflow.CASE_LIBRARY: {
                "sources": [{"id": "s1", "content": "synthetic case"}]
            },
            ClinicalWorkflow.EVAL: {
                "candidates": [
                    {"id": "a", "content": "candidate a"},
                    {"id": "b", "content": "candidate b"},
                ]
            },
            ClinicalWorkflow.COMPARE: {
                "candidates": [
                    {"id": "a", "content": "candidate a"},
                    {"id": "b", "content": "candidate b"},
                ]
            },
        }
        for workflow, payload in payloads.items():
            with self.subTest(workflow=workflow.value):
                prompt = build_clinical_prompt(
                    workflow.value,
                    payload,
                    limits=limits,
                )
                self.assertEqual(prompt["generation_owner"], "pilotdeck")
                self.assertFalse(prompt["phi_persisted"])
                self.assertIn("output_schema", prompt)
                self.assertEqual(
                    contract_document(workflow.value)["workflow"],
                    workflow.value,
                )

    def test_treatment_output_parser_enforces_required_shape(self) -> None:
        valid = {
            "summary": "synthetic",
            "assessments": [
                {
                    "problem": "p",
                    "evidence": "e",
                    "certainty": "low",
                    "source_ids": ["s1"],
                }
            ],
            "plan": [
                {
                    "priority": 1,
                    "problem": "p",
                    "actions": ["a"],
                    "rationale": "r",
                    "source_ids": ["s1"],
                    "monitoring": [],
                    "contraindications": [],
                }
            ],
            "uncertainties": [],
            "safety_escalations": [],
        }
        parsed = parse_clinical_output(
            "treatment_plan",
            json.dumps(valid),
            limits=WorkflowLimits(),
        )
        self.assertEqual(parsed["status"], "valid")
        with self.assertRaisesRegex(ValueError, "required"):
            parse_clinical_output(
                "treatment_plan",
                '{"summary":"incomplete"}',
                limits=WorkflowLimits(),
            )

    def test_rest_prompt_contracts_do_not_generate(self) -> None:
        client = TestClient(create_app(), base_url="http://localhost")
        ocr = client.post(
            "/v1/tables/ocr/prompt",
            json={"images": [{"image_id": "table-1"}]},
        )
        self.assertEqual(ocr.status_code, 200)
        self.assertFalse(ocr.json()["sidecar_calls_model"])
        clinical = client.post(
            "/v1/clinical/prompts/translation",
            json={"text": "synthetic", "target_language": "zh-CN"},
        )
        self.assertEqual(clinical.status_code, 200)
        self.assertEqual(clinical.json()["generation_owner"], "pilotdeck")


class M3DAdapterTests(unittest.TestCase):
    def test_disabled_or_offline_service_is_honestly_unavailable(self) -> None:
        disabled = M3DClient(M3DSettings())
        self.assertEqual(disabled.health()["reason"], "feature_disabled")
        with self.assertRaises(M3DUnavailableError):
            disabled.infer("segment", {})

        offline = M3DClient(
            M3DSettings(enabled=True, timeout_seconds=0.25),
            opener=_OfflineOpener(),
        )
        self.assertEqual(offline.health()["reason"], "service_unavailable")
        with self.assertRaises(M3DUnavailableError):
            offline.infer("segment", {"volume_id": "vol-synthetic"})

    def test_adapter_uses_configured_timeout_and_filters_paths(self) -> None:
        opener = _JsonOpener()
        client = M3DClient(
            M3DSettings(enabled=True, timeout_seconds=0.5),
            opener=opener,
        )
        self.assertTrue(client.health()["available"])
        result = client.infer("segment", {"volume_id": "vol-synthetic"})
        self.assertEqual(result["contract_version"], "m3d-adapter.v1")
        self.assertEqual(opener.timeouts, [0.5, 0.5])
        with self.assertRaisesRegex(ValueError, "filesystem paths"):
            client.infer("segment", {"file_path": "C:/phi/scan.nii"})

    def test_non_loopback_m3d_endpoint_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            SidecarSettings(
                m3d=M3DSettings(
                    enabled=True,
                    endpoint="http://10.1.2.3:8770",
                )
            ).validate()


class RootedRagTests(unittest.TestCase):
    def test_rooted_artifacts_support_vector_and_offline_lexical_search(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            artifact_dir = root / "rag"
            artifact_dir.mkdir()
            corpus = artifact_dir / "corpus.jsonl"
            corpus.write_text(
                json.dumps(
                    {
                        "chunk_id": "c1",
                        "contents": "synthetic",
                        "metadata": {"topic": "a"},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            embeddings = artifact_dir / "embeddings.npy"
            embeddings.write_bytes(npy_bytes((1, 2), [1.0, 0.0]))
            settings = RagLimits(
                corpus_id="synthetic",
                version="v1",
                corpus_path="rag/corpus.jsonl",
                embedding_path="rag/embeddings.npy",
                corpus_sha256=hashlib.sha256(corpus.read_bytes()).hexdigest(),
                embedding_sha256=hashlib.sha256(embeddings.read_bytes()).hexdigest(),
                embedding_model="synthetic-2d",
                license_id="synthetic-only",
                default_min_score=0,
            )
            loader = RagArtifactLoader(settings, data_root=str(root))
            self.assertTrue(loader.status(validate=True)["ready"])
            vector_result = tools.search_rag(
                loader,
                query="synthetic",
                corpus_id="synthetic",
                query_vector=[1.0, 0.0],
                top_k=1,
                min_score=0,
            )
            self.assertEqual(vector_result["result"]["items"][0]["chunk_id"], "c1")
            text_result = tools.query_rag(
                loader,
                None,
                query="synthetic",
                corpus_id="synthetic",
                top_k=1,
                min_score=0,
            )
            self.assertEqual(text_result["mode"], "lexical-fallback")
            self.assertEqual(text_result["result"]["items"][0]["chunk_id"], "c1")


class _OfflineOpener:
    def open(self, request, timeout):  # type: ignore[no-untyped-def]
        raise URLError("synthetic offline")


class _JsonResponse:
    def __init__(self, body: object):
        self.body = json.dumps(body).encode("utf-8")

    def __enter__(self):  # type: ignore[no-untyped-def]
        return self

    def __exit__(self, *args):  # type: ignore[no-untyped-def]
        return False

    def read(self, amount: int) -> bytes:
        return self.body[:amount]


class _JsonOpener:
    def __init__(self) -> None:
        self.timeouts: list[float] = []

    def open(self, request, timeout):  # type: ignore[no-untyped-def]
        self.timeouts.append(timeout)
        if request.method == "GET":
            return _JsonResponse({"status": "ok", "local_path": "hidden"})
        return _JsonResponse({"mask_id": "synthetic"})


if __name__ == "__main__":
    unittest.main()
