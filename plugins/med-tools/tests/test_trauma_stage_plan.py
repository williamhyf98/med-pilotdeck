"""Unit tests for six-stage trauma plan prompts (no network)."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from server.trauma_stage_plan import (
    STAGE_TASKS,
    STAGES,
    build_user_prompt,
    generate_stage_plan,
    generate_stage_plan_stream,
    normalize_stage,
    sanitize_care_plan,
)


class TraumaStagePlanTests(unittest.TestCase):
    def test_normalize_canonical(self) -> None:
        for name in STAGES:
            self.assertEqual(normalize_stage(name), name)

    def test_normalize_alias(self) -> None:
        self.assertEqual(normalize_stage("发生地"), "伤员发生地")
        self.assertEqual(normalize_stage("洗消"), "洗消组")
        self.assertIsNone(normalize_stage("急诊室"))

    def test_build_prompt_includes_stage_task(self) -> None:
        text = build_user_prompt(
            stage="野战分类场",
            injury_text="右大腿贯通伤，活动性出血",
            has_images=False,
        )
        self.assertIn("【野战分类场】", text)
        self.assertIn(STAGE_TASKS["野战分类场"], text)
        self.assertIn("一、图像/影像判读", text)
        self.assertNotIn("【逐图像判读要求】", text)

    def test_build_prompt_multi_image_appendix(self) -> None:
        text = build_user_prompt(
            stage="伤员发生地",
            injury_text="创面渗血",
            has_images=True,
        )
        self.assertIn("【逐图像判读要求】", text)
        self.assertIn("请基于图像本身判读", text)

    def test_sanitize_care_plan_removes_markdown_from_required_titles(self) -> None:
        plan = "## 图像/影像判读\n所见\n**二、本阶段处置措施**\n处置"
        self.assertEqual(
            sanitize_care_plan(plan),
            "一、图像/影像判读\n所见\n二、本阶段处置措施\n处置",
        )

    def test_invalid_stage_no_network(self) -> None:
        payload = generate_stage_plan(
            stage="不存在的阶段",
            injury_text="测试",
        )
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["care_plan"], "")
        self.assertIn("无效阶段", payload["error"])

    def test_missing_inputs(self) -> None:
        payload = generate_stage_plan(stage="伤员发生地", injury_text="  ")
        self.assertFalse(payload["ok"])
        self.assertIn("injury_text", payload["error"])


class TraumaStagePlanStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_forwards_text_and_returns_direct_plan(self) -> None:
        async def fake_chat_vlm_stream(*, on_text, **_kwargs):
            await on_text("一、图像/影像判读\n")
            await on_text("未见图像。")
            return {
                "ok": True,
                "error": "",
                "model": "G9-V-Med",
                "api_base": "http://g9.test/v1",
                "fallback_used": False,
                "agent_continue": False,
                "report": "一、图像/影像判读\n未见图像。",
                "streamed": True,
            }

        chunks = []

        async def collect(text: str) -> None:
            chunks.append(text)

        with patch(
            "server.trauma_stage_plan.chat_vlm_stream",
            new=fake_chat_vlm_stream,
        ):
            payload = await generate_stage_plan_stream(
                stage="伤员发生地",
                injury_text="右大腿贯通伤",
                image_paths=["/path/does/not/exist.jpg"],
                on_text=collect,
            )

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["streamed"])
        self.assertEqual(payload["model"], "G9-V-Med")
        self.assertEqual(payload["image_count"], 0)
        self.assertEqual("".join(chunks), payload["care_plan"])


if __name__ == "__main__":
    unittest.main()
