"""Streaming med_parse_medical report path (no network)."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from server import app


class MedicalParseStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_forwards_report_and_marks_direct(self) -> None:
        base_payload = {
            "tool": "med_parse_medical",
            "status": "ready",
            "report": "",
            "warnings": [],
            "_vlm": {
                "run": True,
                "summary": "共解析 1 个医学附件。胸片。",
                "png_paths": [],
                "max_images": 1,
            },
        }

        async def fake_stream(*, on_text, **_kwargs):
            await on_text("【资料概况】\n")
            await on_text("胸片一张，未见明显异常。")
            return {
                "ok": True,
                "error": "",
                "model": "G9-V-Med",
                "api_base": "http://g9.test/v1",
                "fallback_used": False,
                "agent_continue": False,
                "report": "【资料概况】\n胸片一张，未见明显异常。",
                "streamed": True,
            }

        chunks: list[str] = []

        async def collect(text: str) -> None:
            chunks.append(text)

        with patch.object(app, "_prepare_medical_parse", return_value=dict(base_payload)), \
                patch(
                    "server.vlm_client.analyze_medical_with_vlm_stream",
                    new=fake_stream,
                ):
            payload = await app._run_medical_parse_stream(
                path="/tmp/whatever",
                on_text=collect,
            )

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["vlm_ok"])
        self.assertTrue(payload["streamed"])
        self.assertEqual(payload["model"], "G9-V-Med")
        self.assertEqual("".join(chunks), payload["report"])
        self.assertNotIn("_vlm", payload)

    async def test_skip_vlm_short_circuits_without_stream(self) -> None:
        base_payload = {
            "tool": "med_parse_medical",
            "status": "degraded",
            "report": "",
            "vlm_error": "skipped",
            "_vlm": {"run": False},
        }
        chunks: list[str] = []

        async def collect(text: str) -> None:
            chunks.append(text)

        with patch.object(app, "_prepare_medical_parse", return_value=dict(base_payload)):
            payload = await app._run_medical_parse_stream(
                path="/tmp/whatever",
                on_text=collect,
                skip_vlm=True,
            )

        self.assertEqual(chunks, [])
        self.assertNotIn("ok", payload)
        self.assertNotIn("_vlm", payload)


if __name__ == "__main__":
    unittest.main()
