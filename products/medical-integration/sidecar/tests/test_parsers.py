from __future__ import annotations

import base64
from importlib.util import find_spec
import unittest

from medical_sidecar.config import IngestionLimits
from medical_sidecar.ingestion.parsers import parse_attachment
from medical_sidecar.ingestion.service import AttachmentInput, prepare_attachment_batch
from fixtures import minimal_dicom_bytes, minimal_pdf_bytes


class AttachmentParserTests(unittest.TestCase):
    def test_text_json_and_cda_are_really_parsed(self) -> None:
        text = parse_attachment(
            "人工测试文本".encode("utf-8"),
            filename="note.txt",
        )
        self.assertEqual(text.status, "ready")
        self.assertEqual(text.metadata["encoding"], "utf-8-sig")
        self.assertIn("人工测试文本", text.summary)

        structured = parse_attachment(
            b'{"kind":"synthetic","count":2}',
            filename="data.json",
        )
        self.assertEqual(structured.status, "ready")
        self.assertEqual(structured.metadata["item_count"], 2)

        cda = parse_attachment(
            (
                "<ClinicalDocument xmlns='urn:hl7-org:v3'>"
                "<title>人工 CDA</title><component><section>"
                "<title>合成章节</title><text>无真实患者数据</text>"
                "</section></component></ClinicalDocument>"
            ).encode("utf-8"),
            filename="synthetic.cda.xml",
        )
        self.assertEqual(cda.subtype, "cda_xml")
        self.assertEqual(cda.metadata["section_count"], 1)
        self.assertFalse(cda.metadata["external_entities_allowed"])

    def test_xml_dtd_and_entities_are_blocked(self) -> None:
        outcome = parse_attachment(
            b"<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><x>&e;</x>",
            filename="blocked.xml",
        )
        self.assertEqual(outcome.subtype, "xml_blocked")
        self.assertFalse(outcome.included)

    def test_aecg_metadata_has_explicit_degraded_status(self) -> None:
        outcome = parse_attachment(
            (
                "<AnnotatedECG><component><sequence>"
                "<code code='MDC_ECG_LEAD_I'/><increment value='2' unit='ms'/>"
                "<digits>0 1 2</digits></sequence></component></AnnotatedECG>"
            ).encode("utf-8"),
            filename="synthetic.aecg.xml",
        )
        self.assertEqual(outcome.subtype, "aecg_xml")
        self.assertEqual(outcome.status, "degraded")
        self.assertEqual(outcome.metadata["lead_count"], 1)

    def test_pdf_fixture_is_ready_or_honestly_degraded(self) -> None:
        outcome = parse_attachment(
            minimal_pdf_bytes(),
            filename="synthetic.pdf",
        )
        if find_spec("fitz") is None:
            self.assertEqual(outcome.status, "degraded")
            self.assertIn("dependency_missing:PyMuPDF", outcome.warnings)
        else:
            self.assertEqual(outcome.status, "ready")
            self.assertIn("Synthetic medical fixture", outcome.summary)

    def test_png_metadata_fallback_without_pillow(self) -> None:
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        outcome = parse_attachment(png, filename="synthetic.png")
        self.assertEqual(outcome.metadata["width"], 1)
        self.assertEqual(outcome.metadata["height"], 1)
        self.assertIn(outcome.status, {"ready", "degraded"})

    def test_dicom_fixture_never_exposes_direct_phi_fields(self) -> None:
        outcome = parse_attachment(
            minimal_dicom_bytes(),
            filename="synthetic.dcm",
        )
        if find_spec("pydicom") is not None:
            self.assertTrue(outcome.metadata["direct_identifiers_filtered"])
            self.assertFalse(outcome.metadata["burned_in_phi_evaluated"])
            self.assertFalse(outcome.metadata["pixel_data_deidentified"])
            self.assertEqual(outcome.previews, [])
            self.assertTrue(any("burned_in_phi_not_cleared" in item for item in outcome.warnings))
        self.assertNotIn("PatientName", outcome.metadata)
        self.assertNotIn("PatientID", outcome.metadata)
        if find_spec("pydicom") is None:
            self.assertEqual(outcome.status, "degraded")
            self.assertIn("dependency_missing:pydicom", outcome.warnings)

    def test_wfdb_missing_dependency_or_companion_is_explicit(self) -> None:
        header = b"synthetic 1 250 1000\nsynthetic.dat 16 200/mV 12 0 0 0 I\n"
        missing = parse_attachment(header, filename="synthetic.hea")
        self.assertEqual(missing.status, "degraded")
        self.assertIn("wfdb_companion_data_missing", missing.warnings)

        paired = parse_attachment(
            header,
            filename="synthetic.hea",
            companions={"synthetic.hea": header, "synthetic.dat": b"\x00" * 2000},
        )
        if find_spec("wfdb") is None:
            self.assertIn("dependency_missing:wfdb", paired.warnings)

    def test_batch_service_preserves_existing_rest_shape_and_parses(self) -> None:
        result = prepare_attachment_batch(
            [
                AttachmentInput(
                    filename="note.txt",
                    relative_path="folder/note.txt",
                    media_type="text/plain",
                    data=b"synthetic",
                )
            ],
            limits=IngestionLimits(),
        )
        self.assertEqual(result["status"], "prepared")
        self.assertTrue(result["parsing_performed"])
        self.assertEqual(result["artifacts"][0]["status"], "ready")
        self.assertEqual(result["storage"], "none")


if __name__ == "__main__":
    unittest.main()

