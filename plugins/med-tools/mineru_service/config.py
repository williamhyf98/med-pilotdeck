"""Configuration for the single-worker node12 MinerU service."""

from __future__ import annotations

import os
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


def _int_value(values: Mapping[str, str], name: str, default: int, *, minimum: int = 1) -> int:
    raw = str(values.get(name, default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


@dataclass(frozen=True)
class MinerUServiceConfig:
    root: Path
    launcher: tuple[str, ...]
    model_root: Path
    default_device: str
    max_workers: int
    bind: str
    port: int
    max_upload_bytes: int
    max_jobs: int
    job_timeout_seconds: int
    retention_seconds: int
    api_token_file: Path | None

    @classmethod
    def from_environment(
        cls, environment: Mapping[str, str] | None = None
    ) -> "MinerUServiceConfig":
        values = os.environ if environment is None else environment
        root_raw = str(values.get("MINERU_SERVICE_ROOT", "")).strip()
        root = Path(root_raw).expanduser().resolve() if root_raw else Path.cwd().resolve()

        launcher_raw = str(values.get("MED_RAG_MINERU_LAUNCHER", "")).strip()
        try:
            launcher = tuple(shlex.split(launcher_raw)) if launcher_raw else ()
        except ValueError as exc:
            raise ValueError("MED_RAG_MINERU_LAUNCHER is not a valid command") from exc

        model_raw = str(values.get("MED_RAG_MINERU_MODEL_ROOT", "")).strip()
        model_root = (
            Path(model_raw).expanduser().resolve()
            if model_raw
            else Path("/nonexistent/mineru-models")
        )
        device = str(values.get("MED_RAG_MINERU_DEFAULT_DEVICE", "cuda")).strip().lower()
        if device != "cuda":
            raise ValueError("node12 MinerU service must use MED_RAG_MINERU_DEFAULT_DEVICE=cuda")

        max_workers = _int_value(values, "MED_RAG_MINERU_MAX_WORKERS", 1)
        if max_workers != 1:
            raise ValueError("node12 MinerU service requires exactly one worker")

        token_file_raw = str(values.get("MINERU_SERVICE_API_TOKEN_FILE", "")).strip()
        return cls(
            root=root,
            launcher=launcher,
            model_root=model_root,
            default_device=device,
            max_workers=max_workers,
            bind=str(values.get("MINERU_SERVICE_BIND", "127.0.0.1")).strip()
            or "127.0.0.1",
            port=_int_value(values, "MINERU_SERVICE_PORT", 18890),
            max_upload_bytes=_int_value(
                values, "MINERU_SERVICE_MAX_UPLOAD_BYTES", 2 * 1024**3
            ),
            max_jobs=_int_value(values, "MINERU_SERVICE_MAX_JOBS", 1),
            job_timeout_seconds=_int_value(
                values, "MINERU_SERVICE_JOB_TIMEOUT", 3600
            ),
            retention_seconds=_int_value(
                values, "MINERU_SERVICE_RETENTION_SECONDS", 86400
            ),
            api_token_file=Path(token_file_raw).expanduser().resolve()
            if token_file_raw
            else None,
        )

    def runtime_environment(self) -> dict[str, str]:
        values = dict(os.environ)
        values.update(
            {
                "MED_RAG_MINERU_LAUNCHER": shlex.join(self.launcher),
                "MED_RAG_MINERU_MODEL_ROOT": str(self.model_root),
                "MED_RAG_MINERU_DEFAULT_DEVICE": self.default_device,
                "MED_RAG_MINERU_MAX_WORKERS": str(self.max_workers),
            }
        )
        return values
