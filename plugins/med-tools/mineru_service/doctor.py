"""Non-invasive readiness checks for the node12 MinerU service."""

from __future__ import annotations

import os
import shutil
import subprocess
import json
import sys
from pathlib import Path
from typing import Mapping

from .config import MinerUServiceConfig


def runtime_doctor(
    config: MinerUServiceConfig, environment: Mapping[str, str] | None = None
) -> dict:
    values = os.environ if environment is None else environment
    launcher_exists = bool(config.launcher) and shutil.which(config.launcher[0]) is not None
    model_exists = config.model_root.is_dir()
    model_files = model_exists and any(path.is_file() for path in config.model_root.rglob("*"))
    version = _mineru_version(config) if launcher_exists else ""
    cuda = _cuda_check()
    storage = _storage_check(config.root)
    configured = bool(
        str(values.get("MED_RAG_MINERU_LAUNCHER", "")).strip()
        and str(values.get("MED_RAG_MINERU_MODEL_ROOT", "")).strip()
    )
    valid = configured and launcher_exists and model_exists and model_files and storage["writable"]
    return {
        "ok": valid and (cuda["cuda_available"] if config.default_device == "cuda" else True),
        "runtime": {
            "configured": configured,
            "launcher_exists": launcher_exists,
            "model_root_exists": model_exists,
            "model_files_present": model_files,
            "version": version,
            "valid": valid,
        },
        "cuda": cuda,
        "storage": storage,
    }


def _mineru_version(config: MinerUServiceConfig) -> str:
    try:
        completed = subprocess.run(
            [*config.launcher, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
            env={
                "PATH": os.environ.get("PATH", ""),
                "HOME": os.environ.get("HOME", ""),
                "PYTHONNOUSERSITE": "1",
                "MINERU_MODEL_SOURCE": "local",
            },
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return (completed.stdout or completed.stderr or "").strip()[:120]


def _cuda_check() -> dict[str, object]:
    try:
        completed = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"cuda_available": False, "gpu_count": 0}
    names = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    return {
        "cuda_available": completed.returncode == 0 and bool(names),
        "gpu_count": len(names),
    }


def _storage_check(root: Path) -> dict[str, object]:
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        writable = os.access(root, os.W_OK)
    except OSError:
        writable = False
    return {"writable": writable}


def main() -> int:
    try:
        config = MinerUServiceConfig.from_environment()
        report = runtime_doctor(config)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__}, ensure_ascii=False))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
