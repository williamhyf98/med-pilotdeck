"""Allowlisted internal embedding client.

This module supports embeddings only. It has no authentication or generative
model API surface and refuses redirects to keep the validated destination
stable.
"""

from __future__ import annotations

import ipaddress
import json
import socket
from typing import Callable, Iterable, Sequence
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


Resolver = Callable[..., Iterable[tuple]]


def validate_embedding_endpoint(
    endpoint: str,
    allowed_hosts: Sequence[str],
    *,
    resolver: Resolver = socket.getaddrinfo,
) -> str:
    parsed = urlsplit((endpoint or "").strip())
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("embedding endpoint must use http or https")
    if not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("embedding endpoint must contain a host and no URL credentials")
    if parsed.fragment or parsed.query:
        raise ValueError("embedding endpoint cannot contain a query or fragment")

    host = parsed.hostname.rstrip(".").lower()
    normalized_allowlist = {
        item.strip().rstrip(".").lower()
        for item in allowed_hosts
        if item and "*" not in item
    }
    if host not in normalized_allowlist:
        raise ValueError(f"embedding host {host!r} is not explicitly allowlisted")

    try:
        literal = ipaddress.ip_address(host)
        addresses = [literal]
    except ValueError:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        try:
            resolved = resolver(host, port, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise ValueError(f"embedding host could not be resolved: {host!r}") from exc
        addresses = []
        for item in resolved:
            try:
                addresses.append(ipaddress.ip_address(item[4][0]))
            except (IndexError, TypeError, ValueError):
                continue
        if not addresses:
            raise ValueError(f"embedding host has no usable address: {host!r}")

    for address in addresses:
        if address.is_loopback:
            continue
        # Link-local is deliberately rejected because it includes cloud
        # instance-metadata ranges such as 169.254.169.254.
        if (
            address.is_multicast
            or address.is_unspecified
            or address.is_reserved
            or address.is_link_local
            or not (address.is_private or address.is_loopback)
        ):
            raise ValueError(f"embedding host resolved to a forbidden address: {address}")
    return parsed.geturl()


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        raise HTTPError(req.full_url, code, "embedding redirects are forbidden", headers, fp)


class EmbeddingClient:
    def __init__(
        self,
        endpoint: str,
        allowed_hosts: Sequence[str],
        *,
        timeout_seconds: float = 10.0,
        max_response_bytes: int = 4 * 1024 * 1024,
        resolver: Resolver = socket.getaddrinfo,
    ) -> None:
        self.endpoint = validate_embedding_endpoint(endpoint, allowed_hosts, resolver=resolver)
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if max_response_bytes < 1024:
            raise ValueError("max_response_bytes must be at least 1024")
        self.timeout_seconds = timeout_seconds
        self.max_response_bytes = max_response_bytes
        self._opener = build_opener(_NoRedirect())

    def embed_texts(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts or len(texts) > 64:
            raise ValueError("embedding request must contain between 1 and 64 texts")
        if any(not text or len(text) > 50_000 for text in texts):
            raise ValueError("embedding text is empty or exceeds 50000 characters")

        payload = json.dumps({"input": list(texts)}, ensure_ascii=False).encode("utf-8")
        request = Request(
            self.endpoint,
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        with self._opener.open(request, timeout=self.timeout_seconds) as response:
            raw = response.read(self.max_response_bytes + 1)
        if len(raw) > self.max_response_bytes:
            raise ValueError("embedding response exceeds configured byte limit")
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("embedding response is not valid UTF-8 JSON") from exc

        vectors = _extract_vectors(body)
        if len(vectors) != len(texts):
            raise ValueError("embedding response count does not match request count")
        dimension = len(vectors[0])
        if dimension <= 0 or any(len(vector) != dimension for vector in vectors):
            raise ValueError("embedding response dimensions are empty or inconsistent")
        return vectors


def _extract_vectors(body: object) -> list[list[float]]:
    raw_vectors: object
    if isinstance(body, dict) and isinstance(body.get("embeddings"), list):
        raw_vectors = body["embeddings"]
    elif isinstance(body, dict) and isinstance(body.get("data"), list):
        raw_vectors = [
            item.get("embedding")
            for item in body["data"]
            if isinstance(item, dict)
        ]
    else:
        raise ValueError("embedding response lacks embeddings or data")

    vectors: list[list[float]] = []
    for raw in raw_vectors:
        if not isinstance(raw, list):
            raise ValueError("embedding vector must be an array")
        vector = [float(value) for value in raw]
        if any(not _finite(value) for value in vector):
            raise ValueError("embedding vector contains a non-finite value")
        vectors.append(vector)
    return vectors


def _finite(value: float) -> bool:
    return value == value and value not in {float("inf"), float("-inf")}

