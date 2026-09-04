"""Guarded paths for large, local-only medical RAG runtime artifacts.

The repository contains code and small test fixtures only.  MinerU models,
parsed documents, indexes, and task state must live in an explicitly selected
data-disk directory, never under a developer's home directory.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


RUNTIME_ROOT_ENV = "MED_RAG_RUNTIME_ROOT"


class RagRuntimePathError(ValueError):
    """The configured runtime data location is absent or unsafe."""


@dataclass(frozen=True)
class RagRuntimePaths:
    """Resolved layout for mutable RAG artifacts outside the source checkout."""

    root: Path

    @classmethod
    def from_environment(cls) -> "RagRuntimePaths":
        raw = os.environ.get(RUNTIME_ROOT_ENV, "").strip()
        if not raw:
            raise RagRuntimePathError(
                f"{RUNTIME_ROOT_ENV} must point to a dedicated data-disk directory"
            )
        return cls.from_root(Path(raw))

    @classmethod
    def from_root(cls, root: Path) -> "RagRuntimePaths":
        resolved = root.expanduser().resolve()
        home = Path.home().resolve()
        if resolved == home or home in resolved.parents:
            raise RagRuntimePathError(
                "medical RAG runtime artifacts must not be stored under $HOME"
            )
        if resolved == Path(resolved.anchor):
            raise RagRuntimePathError("medical RAG runtime root must not be a filesystem root")
        return cls(root=resolved)

    @property
    def conda_envs(self) -> Path:
        return self.root / "conda-envs"

    @property
    def model_cache(self) -> Path:
        return self.root / "model-cache"

    @property
    def artifacts(self) -> Path:
        return self.root / "artifacts"

    @property
    def corpora(self) -> Path:
        return self.root / "corpora"

    @property
    def indexes(self) -> Path:
        return self.root / "indexes"

    @property
    def state(self) -> Path:
        return self.root / "state"

    @property
    def temporary(self) -> Path:
        return self.root / "tmp"

    @property
    def ledger_path(self) -> Path:
        return self.state / "ingestion-ledger.sqlite"

    def ensure_layout(self) -> None:
        """Create the approved data layout only when an explicit job requests it."""

        for directory in (
            self.root,
            self.conda_envs,
            self.model_cache,
            self.artifacts,
            self.corpora,
            self.indexes,
            self.state,
            self.temporary,
        ):
            directory.mkdir(parents=True, exist_ok=True)
