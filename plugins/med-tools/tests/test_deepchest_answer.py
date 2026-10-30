import unittest
from types import SimpleNamespace
from deepchest_service.answer import collect_report


def chunk(text=None, reason=None, thinking=None):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content=text, reasoning_content=thinking),
                finish_reason=reason,
            )
        ]
    )


class AnswerTests(unittest.TestCase):
    def test_stream_preserves_report_and_excludes_reasoning(self):
        stream = [
            chunk(thinking="internal thoughts"),
            chunk("影像"),
            chunk("证据分析"),
            chunk(reason="stop"),
        ]
        self.assertEqual(collect_report(stream), "影像证据分析")

    def test_incomplete_and_empty_answers_are_rejected(self):
        for chunks in (
            [chunk("部分答案"), chunk(reason="length")],
            [chunk(reason="stop")],
            [chunk("断流")],
        ):
            with self.subTest(chunks=chunks), self.assertRaises(ValueError):
                collect_report(chunks)
