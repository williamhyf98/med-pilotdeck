"""DOCX to PDF conversion contract tests."""

import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "skills" / "docx" / "scripts"))

from docx_cli import _parser  # noqa: E402
from docxlib.common import DocxSkillError  # noqa: E402
from docxlib.convert import convert_docx_to_pdf  # noqa: E402


def minimal_docx(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
        )
        archive.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
        )


class _Response:
    def __init__(self, payload: bytes):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.payload


class ConvertPdfTest(unittest.TestCase):
    def test_cli_exposes_convert_pdf(self):
        args = _parser().parse_args(
            ["convert-pdf", "--input", "source.docx", "--out", "result.pdf"]
        )
        self.assertEqual(args.command, "convert-pdf")
        self.assertFalse(args.force)

    def test_remote_renderer_writes_pdf_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.docx"
            output = root / "exports" / "result.pdf"
            minimal_docx(source)
            pdf = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"

            with (
                patch.dict(
                    "os.environ",
                    {"PILOTDECK_OFFICE_RENDERER_URL": "http://renderer:19400"},
                    clear=False,
                ),
                patch(
                    "docxlib.convert.urllib.request.urlopen",
                    return_value=_Response(pdf),
                ) as urlopen,
            ):
                result = convert_docx_to_pdf(source, output)

            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["output"], str(output.resolve()))
            self.assertEqual(result["renderer"], "http://renderer:19400")
            self.assertEqual(output.read_bytes(), pdf)
            request = urlopen.call_args.args[0]
            self.assertEqual(request.full_url, "http://renderer:19400/v1/convert/pdf")
            self.assertEqual(request.get_header("Content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")

    def test_input_and_output_must_be_distinct_pdf_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.docx"
            minimal_docx(source)
            with self.assertRaises(DocxSkillError):
                convert_docx_to_pdf(source, source)

    def test_existing_output_requires_force(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.docx"
            output = root / "result.pdf"
            minimal_docx(source)
            output.write_bytes(b"%PDF-old")
            with self.assertRaises(DocxSkillError) as raised:
                convert_docx_to_pdf(source, output)
            self.assertEqual(raised.exception.code, "output-exists")

    def test_without_renderer_uses_local_conversion_backend(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.docx"
            output = root / "result.pdf"
            minimal_docx(source)
            pdf = b"%PDF-1.7\nlocal\n%%EOF\n"
            with (
                patch.dict("os.environ", {}, clear=True),
                patch(
                    "docxlib.convert._convert_local",
                    return_value=(pdf, "/usr/bin/soffice"),
                ),
            ):
                result = convert_docx_to_pdf(source, output)

            self.assertEqual(result["renderer"], "/usr/bin/soffice")
            self.assertEqual(output.read_bytes(), pdf)


if __name__ == "__main__":
    unittest.main()
