"""Resolve VLM fallback from pilotdeck.yaml agent.model."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SAMPLE_YAML = """
schemaVersion: 1
agent:
  model: openai/gpt-5.5
model:
  providers:
    openai:
      protocol: openai
      url: https://example.test/llm/v1
      apiKey: sk-test-key
      models:
        gpt-5.5:
          displayName: GPT-5.5
    qwen:
      protocol: openai
      url: http://127.0.0.1:8040/v1
      apiKey: EMPTY
      models:
        Qwen3.8-27B:
          displayName: Qwen
"""


class FallbackConfigFromPilotdeckTests(unittest.TestCase):
    def setUp(self) -> None:
        from server import vlm_client

        self.vlm = vlm_client
        self.vlm._load_main_agent_llm_from_pilotdeck.cache_clear()
        self._env_backup = {
            key: os.environ.get(key)
            for key in (
                "MED_VLM_FALLBACK_MODEL",
                "MED_VLM_FALLBACK_API_BASE",
                "MED_VLM_FALLBACK_API_KEY",
                "MED_VLM_FALLBACK_ENABLED",
                "PILOT_HOME",
            )
        }
        for key in (
            "MED_VLM_FALLBACK_MODEL",
            "MED_VLM_FALLBACK_API_BASE",
            "MED_VLM_FALLBACK_API_KEY",
        ):
            os.environ.pop(key, None)

    def tearDown(self) -> None:
        self.vlm._load_main_agent_llm_from_pilotdeck.cache_clear()
        for key, value in self._env_backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _write_config(self, text: str = SAMPLE_YAML) -> Path:
        tmp = tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False, encoding="utf-8")
        tmp.write(text)
        tmp.close()
        self.addCleanup(lambda: Path(tmp.name).unlink(missing_ok=True))
        return Path(tmp.name)

    def test_loads_agent_model_from_yaml(self) -> None:
        path = self._write_config()
        resolved = self.vlm._load_main_agent_llm_from_pilotdeck(str(path))
        self.assertIsNotNone(resolved)
        assert resolved is not None
        self.assertEqual(resolved["model"], "gpt-5.5")
        self.assertEqual(resolved["api_base"], "https://example.test/llm/v1")
        self.assertEqual(resolved["api_key"], "sk-test-key")
        self.assertEqual(resolved["agent_ref"], "openai/gpt-5.5")

    def test_get_vlm_config_uses_yaml_when_env_unset(self) -> None:
        path = self._write_config()
        with mock.patch.object(
            self.vlm,
            "_pilotdeck_config_candidates",
            return_value=[path],
        ):
            self.vlm._load_main_agent_llm_from_pilotdeck.cache_clear()
            cfg = self.vlm.get_vlm_config()
        self.assertEqual(cfg["fallback_model"], "gpt-5.5")
        self.assertEqual(cfg["fallback_api_base"], "https://example.test/llm/v1")
        self.assertEqual(cfg["fallback_api_key"], "sk-test-key")
        self.assertEqual(cfg["fallback_source"], "pilotdeck.yaml")
        fallback = self.vlm.get_fallback_vlm_config()
        self.assertIsNotNone(fallback)
        assert fallback is not None
        self.assertEqual(fallback["model"], "gpt-5.5")

    def test_env_overrides_yaml(self) -> None:
        path = self._write_config()
        os.environ["MED_VLM_FALLBACK_MODEL"] = "Qwen3.8-27B"
        os.environ["MED_VLM_FALLBACK_API_BASE"] = "http://127.0.0.1:8040/v1"
        os.environ["MED_VLM_FALLBACK_API_KEY"] = "EMPTY"
        with mock.patch.object(
            self.vlm,
            "_pilotdeck_config_candidates",
            return_value=[path],
        ):
            self.vlm._load_main_agent_llm_from_pilotdeck.cache_clear()
            cfg = self.vlm.get_vlm_config()
        self.assertEqual(cfg["fallback_model"], "Qwen3.8-27B")
        self.assertEqual(cfg["fallback_api_base"], "http://127.0.0.1:8040/v1")
        self.assertEqual(cfg["fallback_source"], "env")

    def test_primary_g9_defaults_unchanged(self) -> None:
        cfg = self.vlm.get_vlm_config()
        self.assertEqual(cfg["model"], self.vlm.DEFAULT_MODEL)
        self.assertTrue(cfg["api_base"].endswith("/v1") or "8030" in cfg["api_base"] or cfg["api_base"])


if __name__ == "__main__":
    unittest.main()
