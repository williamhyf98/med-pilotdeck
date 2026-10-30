"""Local-only subprocess boundary for MinerU parsing."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .mineru_runtime import MinerURuntime


class MinerUExecutionError(RuntimeError):
    """MinerU could not execute successfully."""


class MinerUOutputError(MinerUExecutionError):
    """MinerU exited but did not produce the required artifacts."""


@dataclass(frozen=True)
class MinerUInvocation:
    """One bounded MinerU parse request using local models only."""

    launcher: tuple[str, ...]
    source: Path
    output_dir: Path
    model_root: Path
    language: str = "ch"
    device: str = "cpu"
    start_page: int | None = None
    end_page: int | None = None
    formula_enabled: bool = False
    table_enabled: bool = False
    timeout_seconds: int = 3_600
    cpu_threads: int = 1

    @classmethod
    def from_runtime(
        cls,
        *,
        runtime: MinerURuntime,
        source: Path,
        output_dir: Path,
        language: str = "ch",
        device: str = "cpu",
        start_page: int | None = None,
        end_page: int | None = None,
        formula_enabled: bool = False,
        table_enabled: bool = False,
        timeout_seconds: int = 3_600,
        cpu_threads: int = 1,
    ) -> "MinerUInvocation":
        runtime.validate()
        return cls(
            launcher=runtime.launcher,
            source=source,
            output_dir=output_dir,
            model_root=runtime.model_root,
            language=language,
            device=device,
            start_page=start_page,
            end_page=end_page,
            formula_enabled=formula_enabled,
            table_enabled=table_enabled,
            timeout_seconds=timeout_seconds,
            cpu_threads=cpu_threads,
        )

    def command(self) -> list[str]:
        command = [
            *self.launcher,
            "-p",
            str(self.source.resolve()),
            "-o",
            str(self.output_dir.resolve()),
            "-m",
            "ocr",
            "-b",
            "pipeline",
            "-l",
            self.language,
            "-f",
            str(self.formula_enabled).lower(),
            "-t",
            str(self.table_enabled).lower(),
            "-d",
            self.device,
            "--source",
            "local",
        ]
        if self.start_page is not None:
            command.extend(["-s", str(self.start_page)])
        if self.end_page is not None:
            command.extend(["-e", str(self.end_page)])
        return command

    @property
    def parsed_output_dir(self) -> Path:
        return self.output_dir / self.source.stem / "ocr"

    @property
    def job_key(self) -> str:
        payload = {
            "source": str(self.source.resolve()),
            "output_dir": str(self.output_dir.resolve()),
            "model_root": str(self.model_root.resolve()),
            "language": self.language,
            "device": self.device,
            "start_page": self.start_page,
            "end_page": self.end_page,
            "formula_enabled": self.formula_enabled,
            "table_enabled": self.table_enabled,
            "cpu_threads": self.cpu_threads,
        }
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True).encode("utf-8")
        ).hexdigest()


@dataclass(frozen=True)
class MinerUOutput:
    markdown_path: Path
    content_list_path: Path
    model_path: Path


def run_mineru(invocation: MinerUInvocation) -> subprocess.CompletedProcess[str]:
    """Run MinerU with a deliberately small, isolated environment."""

    _validate_invocation(invocation)
    invocation.output_dir.mkdir(parents=True, exist_ok=True)
    isolated_home = invocation.output_dir / ".mineru-home"
    for directory in (
        isolated_home,
        isolated_home / "cache",
        isolated_home / "config",
        isolated_home / "hf-cache",
        isolated_home / "tmp",
    ):
        directory.mkdir(parents=True, exist_ok=True)
    config_path = isolated_home / "mineru.json"
    config_path.write_text(
        json.dumps(
            {"models-dir": {"pipeline": str(invocation.model_root.resolve())}},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(isolated_home),
        "XDG_CACHE_HOME": str(isolated_home / "cache"),
        "XDG_CONFIG_HOME": str(isolated_home / "config"),
        "HF_HOME": str(isolated_home / "hf-cache"),
        "TMPDIR": str(isolated_home / "tmp"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "MINERU_MODEL_SOURCE": "local",
        "MINERU_TOOLS_CONFIG_JSON": str(config_path),
        "MINERU_DEVICE_MODE": invocation.device,
        "MINERU_FORMULA_ENABLE": str(invocation.formula_enabled).lower(),
        "MINERU_TABLE_ENABLE": str(invocation.table_enabled).lower(),
        "OMP_NUM_THREADS": str(invocation.cpu_threads),
        "MKL_NUM_THREADS": str(invocation.cpu_threads),
        "OPENBLAS_NUM_THREADS": str(invocation.cpu_threads),
        "NUMEXPR_NUM_THREADS": str(invocation.cpu_threads),
        "VECLIB_MAXIMUM_THREADS": str(invocation.cpu_threads),
    }
    try:
        result = subprocess.run(
            invocation.command(),
            check=False,
            capture_output=True,
            cwd=invocation.output_dir,
            env=environment,
            text=True,
            timeout=invocation.timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise MinerUExecutionError(
            f"MinerU timed out after {invocation.timeout_seconds}s"
        ) from exc
    except OSError as exc:
        raise MinerUExecutionError(f"MinerU could not start: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "no process output").strip()[:2_000]
        raise MinerUExecutionError(f"MinerU exited {result.returncode}: {detail}")
    return result


def validate_mineru_output(invocation: MinerUInvocation) -> MinerUOutput:
    """Require the three stable MinerU products used downstream."""

    root = invocation.parsed_output_dir
    markdown_path = root / f"{invocation.source.stem}.md"
    content_list_path = root / f"{invocation.source.stem}_content_list.json"
    model_path = root / f"{invocation.source.stem}_model.json"
    missing = [
        path.name
        for path in (markdown_path, content_list_path, model_path)
        if not path.is_file()
    ]
    if missing:
        raise MinerUOutputError(
            f"MinerU output is incomplete under {root}: {', '.join(missing)}"
        )
    output_root = invocation.output_dir.resolve()
    for path in (markdown_path, content_list_path, model_path):
        try:
            path.resolve(strict=True).relative_to(output_root)
        except (OSError, RuntimeError, ValueError) as exc:
            raise MinerUOutputError(
                f"MinerU output escapes output directory: {path.name}"
            ) from exc
    if not markdown_path.read_text(encoding="utf-8").strip():
        raise MinerUOutputError(f"MinerU Markdown is empty: {markdown_path}")
    return MinerUOutput(markdown_path, content_list_path, model_path)


def _validate_invocation(invocation: MinerUInvocation) -> None:
    if not invocation.launcher:
        raise MinerUExecutionError("MinerU launcher must not be empty")
    if not invocation.source.is_file():
        raise MinerUExecutionError(f"source PDF is missing: {invocation.source}")
    if not invocation.model_root.is_dir():
        raise MinerUExecutionError(
            f"local MinerU model root is missing: {invocation.model_root}"
        )
    if invocation.timeout_seconds < 1:
        raise MinerUExecutionError("timeout_seconds must be positive")
    if invocation.cpu_threads < 1:
        raise MinerUExecutionError("cpu_threads must be positive")
    if invocation.start_page is not None and invocation.start_page < 0:
        raise MinerUExecutionError("start_page must be non-negative")
    if invocation.end_page is not None and invocation.end_page < 0:
        raise MinerUExecutionError("end_page must be non-negative")
    if (
        invocation.start_page is not None
        and invocation.end_page is not None
        and invocation.end_page < invocation.start_page
    ):
        raise MinerUExecutionError("end_page must not precede start_page")
