"""Read model settings from the active PilotDeck YAML for medical tools."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

try:
    import yaml
except ImportError:  # pragma: no cover - setup.sh installs PyYAML
    yaml = None


def config_candidates() -> list[Path]:
    plugin_root = Path(__file__).resolve().parents[1]
    paths = [
        *([Path(os.environ["PILOT_HOME"]) / "pilotdeck.yaml"] if os.environ.get("PILOT_HOME") else []),
        plugin_root.parent.parent / ".pilotdeck-home" / "pilotdeck.yaml",
        Path.home() / ".pilotdeck" / "pilotdeck.yaml",
    ]
    return list(dict.fromkeys(paths))


def load_config(paths: list[Path] | None = None) -> Optional[dict[str, Any]]:
    # Read on each call: the gateway reloads YAML between requests, and the
    # long-lived Python MCP process must observe the same changes.
    if yaml is None:
        return None
    for path in paths if paths is not None else config_candidates():
        if not path.is_file():
            continue
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            continue
        if isinstance(raw, dict):
            return raw
    return None


def resolve_model(raw: dict[str, Any], ref: str) -> Optional[dict[str, str]]:
    provider_id, sep, model_id = ref.strip().partition("/")
    if not sep or not provider_id or not model_id:
        return None
    model = raw.get("model")
    providers = model.get("providers") if isinstance(model, dict) else None
    provider = providers.get(provider_id) if isinstance(providers, dict) else None
    models = provider.get("models") if isinstance(provider, dict) else None
    if not isinstance(models, dict) or model_id not in models:
        return None
    key = str(provider.get("apiKey") or "").strip()
    if key.startswith("${") and key.endswith("}"):
        key = os.environ.get(key[2:-1], "").strip()
    return {
        "agent_ref": ref,
        "model": model_id,
        "api_base": str(provider.get("url") or "").strip().rstrip("/"),
        "api_key": key,
        "protocol": str(provider.get("protocol") or "").strip(),
    }
