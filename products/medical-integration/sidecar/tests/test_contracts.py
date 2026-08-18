from __future__ import annotations

import json
from pathlib import Path
import unittest

from medical_sidecar.config import SidecarSettings, require_loopback_host
from medical_sidecar.imaging.contracts import (
    GalleryCaseMetadata,
    GalleryDatasetMetadata,
    VolumeMetadata,
)
from medical_sidecar.ingestion.contracts import (
    Artifact,
    BatchManifest,
    IngestionBudget,
    detect_format,
    safe_filename,
    safe_relative_path,
    validated_derived_refs,
)
from medical_sidecar.rag.contracts import (
    RagQuery,
    VectorRecord,
    cosine_similarity,
    retrieve,
)
from medical_sidecar.rag.embedding import validate_embedding_endpoint
from medical_sidecar.table.contracts import (
    parse_table_output,
    safe_csv_cell,
    table_to_safe_csv,
)
from medical_sidecar.trauma.prompt_builder import (
    OUTPUT_SECTIONS,
    TraumaStage,
    build_trauma_prompt,
)


SAMPLE_DIR = Path(__file__).resolve().parents[1] / "sample_data"


class AttachmentContractTests(unittest.TestCase):
    def test_detects_registered_medical_formats(self) -> None:
        self.assertEqual(detect_format("scan.DCM").subtype, "dicom")
        self.assertEqual(
            detect_format("lead.aecg.xml", "application/xml").subtype,
            "aecg_xml",
        )
        self.assertEqual(detect_format("record.hea").subtype, "wfdb_header")
        self.assertEqual(detect_format("unknown.bin").subtype, "unknown")

    def test_rejects_path_traversal_and_absolute_paths(self) -> None:
        for unsafe in ("../secret", "a/../../secret", "/etc/passwd", "C:/secret", r"a\secret"):
            with self.subTest(unsafe=unsafe), self.assertRaises(ValueError):
                safe_relative_path(unsafe)
        self.assertEqual(safe_relative_path("folder/report.pdf").as_posix(), "folder/report.pdf")
        with self.assertRaises(ValueError):
            safe_filename("../report.pdf")

    def test_filters_internal_derived_references(self) -> None:
        refs, rejected = validated_derived_refs(
            ["derived/page-1.png", "../escape", "/absolute", 123, "derived/page-1.png"]
        )
        self.assertEqual(refs, ["derived/page-1.png"])
        self.assertEqual(rejected, 3)

    def test_public_manifest_hides_storage_references(self) -> None:
        artifact = Artifact(
            artifact_id="a1",
            filename="report.pdf",
            relative_path="reports/report.pdf",
            kind="pdf",
            subtype="pdf",
            status="parsed",
            included=True,
            byte_size=12,
            sha256="a" * 64,
            metadata={"page_count": 1, "storage_path": "/private/report.pdf"},
            preview_kind="image",
            preview_ref="derived/page-1.png",
            model_image_refs=["derived/page-1.png"],
        )
        manifest = BatchManifest("batch-1", "2026-01-01T00:00:00Z", [artifact])
        public = manifest.to_public_dict()
        internal = manifest.to_manifest_dict()
        self.assertNotIn("_preview", public["artifacts"][0])
        self.assertNotIn("_model_image_refs", public["artifacts"][0])
        self.assertNotIn("storage_path", public["artifacts"][0]["metadata"])
        self.assertEqual(public["artifacts"][0]["preview_frame_count"], 1)
        self.assertEqual(internal["artifacts"][0]["_preview"]["ref"], "derived/page-1.png")
        restored = BatchManifest.from_manifest_dict(internal)
        self.assertEqual(restored.artifacts[0].model_image_refs, ["derived/page-1.png"])

    def test_budget_checks_total_size(self) -> None:
        artifact = Artifact(
            artifact_id="a1",
            filename="a.txt",
            relative_path="a.txt",
            kind="text",
            subtype="text",
            status="parsed",
            included=True,
            byte_size=11,
            sha256="b" * 64,
        )
        with self.assertRaises(ValueError):
            IngestionBudget(max_total_bytes=10).validate([artifact])


class RagContractTests(unittest.TestCase):
    def test_cosine_similarity(self) -> None:
        self.assertAlmostEqual(cosine_similarity([1, 0], [1, 0]), 1.0)
        self.assertAlmostEqual(cosine_similarity([1, 0], [0, 1]), 0.0)
        with self.assertRaises(ValueError):
            cosine_similarity([1], [1, 2])

    def test_retrieval_orders_and_filters_sources(self) -> None:
        records = [
            VectorRecord("s2", "c2", [0.8, 0.2], "second"),
            VectorRecord("s1", "c1", [1.0, 0.0], "first"),
            VectorRecord("s3", "c3", [0.0, 1.0], "filtered"),
        ]
        result = retrieve(
            RagQuery("query", "synthetic", top_k=2, min_score=0.5),
            [1.0, 0.0],
            records,
            corpus_version="v1",
            embedding_model="synthetic-2d",
        )
        self.assertEqual([item.chunk_id for item in result.items], ["c1", "c2"])
        self.assertEqual(result.to_dict()["corpus_version"], "v1")

    def test_rag_sample_is_synthetic_and_loadable(self) -> None:
        rows = [
            json.loads(line)
            for line in (SAMPLE_DIR / "rag_records.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row["metadata"]["synthetic"] == "true" for row in rows))


class EmbeddingSafetyTests(unittest.TestCase):
    @staticmethod
    def resolver(host: str, port: int, **kwargs):  # type: ignore[no-untyped-def]
        mapping = {
            "embed.internal": "10.20.30.40",
            "public.internal": "8.8.8.8",
            "metadata.internal": "169.254.169.254",
        }
        return [(2, 1, 6, "", (mapping[host], port))]

    def test_accepts_exact_allowlisted_private_host(self) -> None:
        endpoint = validate_embedding_endpoint(
            "http://embed.internal/v1/embeddings",
            ["embed.internal"],
            resolver=self.resolver,
        )
        self.assertEqual(endpoint, "http://embed.internal/v1/embeddings")

    def test_rejects_public_link_local_and_url_credentials(self) -> None:
        cases = (
            ("http://public.internal/embed", ["public.internal"]),
            ("http://metadata.internal/latest", ["metadata.internal"]),
            ("http://user:password@embed.internal/embed", ["embed.internal"]),
            ("http://embed.internal/embed?token=secret", ["embed.internal"]),
        )
        for endpoint, allowlist in cases:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                validate_embedding_endpoint(endpoint, allowlist, resolver=self.resolver)

    def test_rejects_non_allowlisted_host(self) -> None:
        with self.assertRaises(ValueError):
            validate_embedding_endpoint(
                "http://embed.internal/embed",
                ["other.internal"],
                resolver=self.resolver,
            )


class TableContractTests(unittest.TestCase):
    def test_parses_sample_json_and_protects_csv(self) -> None:
        document = parse_table_output(
            (SAMPLE_DIR / "table_model_output.md").read_text(encoding="utf-8")
        )
        self.assertEqual(document.source_format, "json")
        self.assertEqual(document.title, "合成库存表")
        csv_text = table_to_safe_csv(document.columns, document.rows)
        self.assertIn("'=1+1", csv_text)

    def test_markdown_fallback_aligns_rows(self) -> None:
        document = parse_table_output("| A | B |\n|---|---|\n| 1 |\n")
        self.assertEqual(document.source_format, "markdown")
        self.assertEqual(document.rows, [["1", ""]])

    def test_formula_prefixes_are_neutralized(self) -> None:
        for value in ("=1+1", "+cmd", "-2", "@sum", "\tformula", "\rformula"):
            with self.subTest(value=value):
                self.assertTrue(safe_csv_cell(value).startswith("'"))
        self.assertEqual(safe_csv_cell("42"), "42")


class TraumaPromptTests(unittest.TestCase):
    def test_all_six_stages_build_fixed_eval_sections(self) -> None:
        self.assertEqual(len(list(TraumaStage)), 6)
        for stage in TraumaStage:
            with self.subTest(stage=stage.value):
                bundle = build_trauma_prompt(stage=stage.value, description="合成描述")
                self.assertEqual(bundle.output_sections, OUTPUT_SECTIONS)
                self.assertEqual(bundle.prompt_version, "war-trauma.v1")
                self.assertEqual(bundle.to_dict()["generation_owner"], "pilotdeck")

    def test_sample_preserves_image_order(self) -> None:
        body = json.loads((SAMPLE_DIR / "trauma_request.json").read_text(encoding="utf-8"))
        bundle = build_trauma_prompt(
            stage=body["stage"],
            description=body["description"],
            scene=body["scene"],
            images=body["images"],
            style=body["prompt_style"],
        )
        self.assertEqual([item.image_id for item in bundle.images], [
            "synthetic-image-001",
            "synthetic-image-002",
        ])
        self.assertIn("逐图要求", bundle.user_prompt)

    def test_rejects_duplicate_image_identity(self) -> None:
        images = [
            {"image_id": "same", "category": "ct", "index": 0},
            {"image_id": "same", "category": "xray", "index": 1},
        ]
        with self.assertRaises(ValueError):
            build_trauma_prompt(stage="手术组", images=images)


class ImagingContractTests(unittest.TestCase):
    def test_volume_contract_keeps_legacy_aliases(self) -> None:
        metadata = VolumeMetadata.from_mapping(
            {
                "vid": "volume-1",
                "filename": "synthetic.nii.gz",
                "ext": ".nii.gz",
                "orig_shape": [32, 64, 64],
                "spacing": [1.0, 1.0, 1.0],
                "modality": "CT",
                "n_slices": 32,
                "thumb_index": 16,
                "value_range": [-1000, 1000],
                "byte_size": 1024,
                "sha256": "c" * 64,
            }
        ).validate()
        public = metadata.to_dict()
        self.assertEqual(public["vid"], "volume-1")
        self.assertEqual(public["orig_shape"], [32, 64, 64])
        self.assertFalse(public["diagnostic_grade"])

    def test_volume_rejects_oversized_voxel_count(self) -> None:
        metadata = VolumeMetadata.from_mapping(
            {
                "vid": "volume-1",
                "filename": "synthetic.npy",
                "ext": ".npy",
                "orig_shape": [100, 100, 100],
                "n_slices": 10,
                "thumb_index": 5,
                "byte_size": 100,
                "sha256": "d" * 64,
            }
        )
        with self.assertRaises(ValueError):
            metadata.validate(max_voxels=1000)

    def test_available_gallery_requires_version_and_license(self) -> None:
        dataset = GalleryDatasetMetadata.from_mapping(
            {
                "id": "synthetic",
                "available": True,
                "n_cases": 1,
            }
        )
        with self.assertRaises(ValueError):
            dataset.validate()

    def test_gallery_case_does_not_expose_report_text_or_path(self) -> None:
        case = GalleryCaseMetadata.from_mapping(
            {
                "dataset": "synthetic",
                "case_id": "case-1",
                "n_slices": 10,
                "thumb_index": 5,
                "has_text": True,
            }
        ).validate()
        public = case.to_dict()
        self.assertNotIn("text", public)
        self.assertNotIn("path", public)


class ConfigurationTests(unittest.TestCase):
    def test_bind_hosts_are_loopback_only(self) -> None:
        self.assertEqual(require_loopback_host("127.0.0.1"), "127.0.0.1")
        self.assertEqual(require_loopback_host("::1"), "::1")
        for host in ("0.0.0.0", "10.0.0.1", "example.internal"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                require_loopback_host(host)

    def test_environment_configuration_has_no_secret_field(self) -> None:
        settings = SidecarSettings.load(
            environ={
                "MEDICAL_API_PORT": "9001",
                "MEDICAL_MCP_PORT": "9002",
                "MEDICAL_EMBEDDING_ENABLED": "false",
            }
        )
        self.assertEqual(settings.api_port, 9001)
        self.assertEqual(settings.mcp_port, 9002)
        self.assertNotIn("api_key", settings.__dict__)

    def test_resource_limits_are_loaded_from_mapping(self) -> None:
        settings = SidecarSettings.from_mapping(
            {
                "ingestion": {"max_file_bytes": 20, "max_total_bytes": 30},
                "rag": {"default_top_k": 2, "max_top_k": 4},
                "table": {"max_rows": 5},
                "imaging": {"max_preview_slices": 8},
            }
        )
        self.assertEqual(settings.ingestion.max_file_bytes, 20)
        self.assertEqual(settings.rag.max_top_k, 4)
        self.assertEqual(settings.table.max_rows, 5)
        self.assertEqual(settings.imaging.max_preview_slices, 8)


if __name__ == "__main__":
    unittest.main()

