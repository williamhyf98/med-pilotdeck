"""Feature-flagged localhost adapter for an optional M3D service."""

from __future__ import annotations

import json
import math
import re
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from ..config import M3DSettings


class M3DUnavailableError(RuntimeError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        raise HTTPError(req.full_url, code, "M3D redirects are forbidden", headers, fp)


class M3DClient:
    def __init__(self, settings: M3DSettings, *, opener: Any | None = None) -> None:
        self.settings = settings
        self._opener = opener or build_opener(_NoRedirect())

    def health(self) -> dict[str, Any]:
        if not self.settings.enabled:
            return self._unavailable("feature_disabled")
        try:
            body = self._request("GET", self.settings.health_path)
        except M3DUnavailableError as exc:
            return self._unavailable(str(exc))
        upstream = _public_json(body)
        return {
            "status": "ready",
            "available": True,
            "reason": None,
            "feature_enabled": True,
            "timeout_seconds": self.settings.timeout_seconds,
            "upstream": upstream,
            "endpoint_exposed": False,
        }

    def infer(self, task: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        if not self.settings.enabled:
            raise M3DUnavailableError("feature_disabled")
        normalized_task = (task or "").strip().lower()
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", normalized_task):
            raise ValueError("M3D task must be a simple identifier")
        if not isinstance(payload, Mapping):
            raise ValueError("M3D payload must be an object")
        _reject_local_paths(payload)
        request_body = {
            "task": normalized_task,
            "input": dict(payload),
            "response_contract": "m3d-adapter.v1",
        }
        raw = json.dumps(request_body, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        if len(raw) > self.settings.max_response_bytes:
            raise ValueError("M3D request exceeds the configured byte budget")
        result = self._request("POST", self.settings.infer_path, raw)
        return {
            "status": "ready",
            "contract_version": "m3d-adapter.v1",
            "task": normalized_task,
            "result": _public_json(result),
            "generation_owner": "pilotdeck",
            "phi_persisted": False,
            "endpoint_exposed": False,
        }

    def _request(
        self,
        method: str,
        path: str,
        data: bytes | None = None,
    ) -> Any:
        url = self.settings.endpoint.rstrip("/") + path
        request = Request(
            url,
            data=data,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with self._opener.open(
                request,
                timeout=self.settings.timeout_seconds,
            ) as response:
                raw = response.read(self.settings.max_response_bytes + 1)
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            raise M3DUnavailableError(_network_reason(exc)) from exc
        if len(raw) > self.settings.max_response_bytes:
            raise M3DUnavailableError("response_too_large")
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise M3DUnavailableError("invalid_json_response") from exc

    def _unavailable(self, reason: str) -> dict[str, Any]:
        return {
            "status": "unavailable",
            "available": False,
            "reason": reason,
            "feature_enabled": self.settings.enabled,
            "timeout_seconds": self.settings.timeout_seconds,
            "endpoint_exposed": False,
        }


def _network_reason(error: Exception) -> str:
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, HTTPError):
        return f"http_{error.code}"
    reason = getattr(error, "reason", None)
    if isinstance(reason, TimeoutError):
        return "timeout"
    return "service_unavailable"


def _reject_local_paths(value: Any, *, depth: int = 0) -> None:
    if depth > 12:
        raise ValueError("M3D payload nesting exceeds the configured safety limit")
    if isinstance(value, Mapping):
        for key, item in value.items():
            normalized = str(key).lower()
            if "path" in normalized or normalized in {"directory", "folder"}:
                raise ValueError("M3D payload cannot contain local filesystem paths")
            _reject_local_paths(item, depth=depth + 1)
    elif isinstance(value, (list, tuple)):
        if len(value) > 10_000:
            raise ValueError("M3D payload array exceeds the configured safety limit")
        for item in value:
            _reject_local_paths(item, depth=depth + 1)


def _public_json(value: Any, *, depth: int = 0) -> Any:
    if depth > 12:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:100_000]
    if isinstance(value, list):
        return [_public_json(item, depth=depth + 1) for item in value[:10_000]]
    if isinstance(value, Mapping):
        public: dict[str, Any] = {}
        for key, item in list(value.items())[:1_000]:
            normalized = str(key)[:100]
            lowered = normalized.lower()
            if any(token in lowered for token in ("path", "secret", "token", "api_key")):
                continue
            public[normalized] = _public_json(item, depth=depth + 1)
        return public
    return str(value)[:1_000]
