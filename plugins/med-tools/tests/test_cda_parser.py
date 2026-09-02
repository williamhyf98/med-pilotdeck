"""Unit tests for structured CDA extraction."""

from __future__ import annotations

import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from server.cda_parser import parse_cda_root, render_cda_text, summarize_cda_root
from server.parsers import parse_medical_file

FIXTURES = Path(__file__).resolve().parent / "fixtures"


class CdaParserTests(unittest.TestCase):
    def test_lab_cluster_pairs_codes_values_and_units(self) -> None:
        root = ET.fromstring((FIXTURES / "lab-biochem.cda.xml").read_bytes())
        summary, meta, warnings = summarize_cda_root(root, max_chars=8_000)
        self.assertIn("cTnI = 0.004 ng/mL", summary)
        self.assertIn("MYO = 11.400 ng/mL", summary)
        self.assertIn("NT-proBNP = 117.00 pg/ml", summary)
        self.assertNotIn("5581 =", summary)
        self.assertEqual(meta["lab_item_count"], 3)
        self.assertEqual(meta["name_unavailable_count"], 0)
        self.assertEqual(warnings, [])

    def test_unknown_internal_code_is_marked_not_guessed(self) -> None:
        xml = """<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <title>检验记录</title>
  <effectiveTime value="20250120"/>
  <component>
    <structuredBody>
      <component>
        <section>
          <code displayName="STUDIES SUMMARY"/>
          <title>STUDIES SUMMARY</title>
          <entry>
            <organizer classCode="CLUSTER" moodCode="EVN">
              <statusCode/>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <code displayName="检验项目代码"/>
                  <value xsi:type="ST">9999</value>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <code displayName="检验定量结果"/>
                  <value xsi:type="REAL" value="1.2"/>
                  <entryRelationship typeCode="COMP">
                    <observation classCode="OBS" moodCode="EVN">
                      <code displayName="检查定量结果计量单位"/>
                      <value xsi:type="ST">mg/L</value>
                    </observation>
                  </entryRelationship>
                </observation>
              </component>
            </organizer>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
""".encode("utf-8")
        root = ET.fromstring(xml)
        summary, meta, warnings = summarize_cda_root(root, max_chars=2_000)
        self.assertIn("院内项目代码 9999 = 1.2 mg/L", summary)
        self.assertIn("项目名称未提供", summary)
        self.assertEqual(meta["name_unavailable_count"], 1)
        self.assertTrue(any("院内项目代码" in w for w in warnings))
        self.assertNotIn("cTnI", summary)

    def test_admission_note_keeps_observation_pairs(self) -> None:
        root = ET.fromstring((FIXTURES / "admission-note.cda.xml").read_bytes())
        text = render_cda_text(parse_cda_root(root), max_chars=6_000)
        self.assertIn("主诉 = 胸痛1月余", text)
        self.assertIn("血压 = 129/81 mmHg", text)

    def test_parse_medical_file_uses_structured_cda_status_ready(self) -> None:
        derived = FIXTURES / "_derived"
        derived.mkdir(exist_ok=True)
        outcome = parse_medical_file(
            FIXTURES / "lab-biochem.cda.xml",
            derived_dir=derived,
            max_text_chars=6_000,
        )
        self.assertEqual(outcome.subtype, "cda_xml")
        self.assertEqual(outcome.status, "ready")
        self.assertTrue(outcome.metadata.get("cda_structured"))
        self.assertIn("cTnI = 0.004 ng/mL", outcome.summary)


if __name__ == "__main__":
    unittest.main()
