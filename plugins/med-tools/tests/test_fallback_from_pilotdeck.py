"""Resolve VLM fallback from pilotdeck.yaml agent.model."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SAMPLE_YAML = """
schemaVersion: 1
medical:
  interpretationModel: qwen/Qwen3.8-27B
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
        self._env_backup = {
            key: os.environ.get(key)
            for key in (
                "MED_VLM_FALLBACK_MODEL",
                "MED_VLM_FALLBACK_API_BASE",
                "MED_VLM_FALLBACK_API_KEY",
                "MED_VLM_FALLBACK_ENABLED",
                "MED_VLM_MODEL",
                "MED_VLM_API_BASE",
                "MED_VLM_API_KEY",
                "PILOT_HOME",
            )
        }
        for key in (
            "MED_VLM_FALLBACK_MODEL",
            "MED_VLM_FALLBACK_API_BASE",
            "MED_VLM_FALLBACK_API_KEY",
            "MED_VLM_MODEL",
            "MED_VLM_API_BASE",
            "MED_VLM_API_KEY",
        ):
            os.environ.pop(key, None)

    def tearDown(self) -> None:
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
            cfg = self.vlm.get_vlm_config()
            fallback = self.vlm.get_fallback_vlm_config()
        self.assertEqual(cfg["fallback_model"], "gpt-5.5")
        self.assertEqual(cfg["fallback_api_base"], "https://example.test/llm/v1")
        self.assertEqual(cfg["fallback_api_key"], "sk-test-key")
        self.assertEqual(cfg["fallback_source"], "pilotdeck.yaml")
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
            cfg = self.vlm.get_vlm_config()
        self.assertEqual(cfg["fallback_model"], "Qwen3.8-27B")
        self.assertEqual(cfg["fallback_api_base"], "http://127.0.0.1:8040/v1")
        self.assertEqual(cfg["fallback_source"], "env")

    def test_primary_model_follows_medical_reference_and_yaml_changes(self) -> None:
        path = self._write_config()
        with mock.patch.object(self.vlm, "_pilotdeck_config_candidates", return_value=[path]):
            cfg = self.vlm.get_vlm_config()
            self.assertEqual(cfg["model"], "Qwen3.8-27B")
            self.assertEqual(cfg["api_base"], "http://127.0.0.1:8040/v1")
            path.write_text(SAMPLE_YAML.replace("qwen/Qwen3.8-27B", "openai/gpt-5.5"), encoding="utf-8")
            updated = self.vlm.get_vlm_config()
            self.assertEqual(updated["model"], "gpt-5.5")
            self.assertEqual(updated["api_base"], "https://example.test/llm/v1")

    def test_primary_environment_override_is_explicit(self) -> None:
        path = self._write_config()
        os.environ["MED_VLM_MODEL"] = "one-off-model"
        with mock.patch.object(self.vlm, "_pilotdeck_config_candidates", return_value=[path]):
            cfg = self.vlm.get_vlm_config()
        self.assertEqual(cfg["model"], "one-off-model")
        self.assertEqual(cfg["api_base"], "http://127.0.0.1:8040/v1")

    def test_embedding_follows_yaml_updates(self) -> None:
        from server.rag.embedding_client import get_embedding_config

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "pilotdeck.yaml"
            path.write_text(
                SAMPLE_YAML + "\nembedding:\n  apiBase: http://127.0.0.1:1111/v1\n"
                "  endpoint: http://127.0.0.1:1111/v1/embeddings\n"
                "  model: first-embedding\n  apiKey: EMPTY\n  dimension: 2048\n",
                encoding="utf-8",
            )
            overrides = {key: "" for key in (
                "MED_EMBEDDING_API_BASE", "MED_EMBEDDING_ENDPOINT",
                "MED_EMBEDDING_MODEL", "MED_EMBEDDING_API_KEY", "MED_EMBEDDING_DIMENSION",
            )}
            overrides["PILOT_HOME"] = directory
            with mock.patch.dict(os.environ, overrides):
                initial = get_embedding_config()
                self.assertEqual(initial["model"], "first-embedding")
                self.assertEqual(initial["api_base"], "http://127.0.0.1:1111/v1")
                path.write_text(
                    path.read_text(encoding="utf-8").replace("first-embedding", "next-embedding"),
                    encoding="utf-8",
                )
                self.assertEqual(get_embedding_config()["model"], "next-embedding")


if __name__ == "__main__":
    unittest.main()
