"""Self-contained war-trauma RAG for med-tools (no products/ dependency)."""

from __future__ import annotations

from .store import RagStore, activate_manifest, get_active_manifest_path, get_default_store
from .query import query_rag, rag_status

__all__ = [
    "RagStore",
    "activate_manifest",
    "get_active_manifest_path",
    "get_default_store",
    "query_rag",
    "rag_status",
]
