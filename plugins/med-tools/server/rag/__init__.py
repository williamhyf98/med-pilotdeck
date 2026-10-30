"""Self-contained war-trauma RAG for med-tools (no products/ dependency)."""

from __future__ import annotations

from .store import RagStore, get_default_store
from .query import query_rag, rag_status
from .rag_service_client import (
    RagServiceError,
    get_rag_service_config,
    remote_health,
    resolve_topic,
)

__all__ = [
    "RagStore",
    "get_default_store",
    "query_rag",
    "rag_status",
    "RagServiceError",
    "get_rag_service_config",
    "remote_health",
    "resolve_topic",
]
