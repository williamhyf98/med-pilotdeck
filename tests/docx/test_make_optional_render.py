"""A denied optional preview must not prevent delivery of a valid Word file."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "skills" / "docx" / "scripts"))

from docxlib.make import make_docx  # noqa: E402


class MakeOptionalRenderTest(unittest.TestCase):
    def test_permission_denied_while_probing_preview_still_delivers_docx(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "申请单.docx"
            with patch(
                "docxlib.make.find_soffice",
                side_effect=PermissionError(1, "Operation not permitted"),
            ):
                result = make_docx(output, title="检查申请单", body="姓名：张某")

            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["validation"]["status"], "ok")
            self.assertIn("PermissionError", result["warning"])
            self.assertTrue(output.is_file())

    def test_permission_denied_during_preview_still_delivers_docx(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "申请单.docx"
            with (
                patch("docxlib.make.find_soffice", return_value="/Applications/LibreOffice.app/Contents/MacOS/soffice"),
                patch("docxlib.make.render_docx", side_effect=PermissionError(1, "Operation not permitted")),
            ):
                result = make_docx(output, title="检查申请单", body="姓名：张某")

            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["output"], str(output.resolve()))
            self.assertEqual(result["validation"]["status"], "ok")
            self.assertIn("PermissionError", result["warning"])
            self.assertEqual(result["preview"], [])
            self.assertTrue(output.is_file())


if __name__ == "__main__":
    unittest.main()
