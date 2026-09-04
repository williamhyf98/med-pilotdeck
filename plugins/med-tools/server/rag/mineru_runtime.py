"""Configuration boundary for an externally managed MinerU runtime.

MinerU is intentionally not packaged with Med-PilotDeck.  A deployment
provides its launcher and its already-downloaded local model directory through
environment variables; the ingestion code receives only the resolved values.
"""

from __future__ import annotations

import os
import shlex
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


MINERU_LAUNCHER_ENV = "MED_RAG_MINERU_LAUNCHER"
MINERU_MODEL_ROOT_ENV = "MED_RAG_MINERU_MODEL_ROOT"


class MinerURuntimeConfigError(ValueError):
    """The externally supplied MinerU runtime is absent or unusable."""


@dataclass(frozen=True)
class MinerURuntime:
    """Resolved external MinerU command and local model directory."""

    launcher: tuple[str, ...]
    model_root: Path

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None) -> "MinerURuntime":
        values = os.environ if environment is None else environment
        launcher_raw = values.get(MINERU_LAUNCHER_ENV, "").strip()
        model_root_raw = values.get(MINERU_MODEL_ROOT_ENV, "").strip()
        if not launcher_raw:
            raise MinerURuntimeConfigError(f"{MINERU_LAUNCHER_ENV} must be configured")
        if not model_root_raw:
            raise MinerURuntimeConfigError(f"{MINERU_MODEL_ROOT_ENV} must be configured")
        try:
            launcher = tuple(shlex.split(launcher_raw))
        except ValueError as exc:
            raise MinerURuntimeConfigError(
                f"{MINERU_LAUNCHER_ENV} is not a valid command"
            ) from exc
        if not launcher:
            raise MinerURuntimeConfigError(f"{MINERU_LAUNCHER_ENV} must not be empty")
        return cls(launcher=launcher, model_root=Path(model_root_raw).expanduser().resolve())

    def validate(self) -> None:
        executable = self.launcher[0]
        if not shutil.which(executable):
            raise MinerURuntimeConfigError(
                f"MinerU launcher cannot be found: {executable!r}; check {MINERU_LAUNCHER_ENV}"
            )
        if not self.model_root.is_dir():
            raise MinerURuntimeConfigError(
                f"MinerU model directory is missing: {self.model_root}; check {MINERU_MODEL_ROOT_ENV}"
            )
