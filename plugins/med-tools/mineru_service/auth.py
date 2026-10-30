"""Bearer-token authentication with token-derived tenant identities."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Mapping


class TokenAuthenticator:
    def __init__(self, tokens: Mapping[str, str] | None = None) -> None:
        self._tokens = {
            str(token): _safe_principal(principal)
            for token, principal in (tokens or {}).items()
            if str(token).strip()
        }

    @classmethod
    def from_environment(
        cls, environment: Mapping[str, str] | None = None, token_file: Path | None = None
    ) -> "TokenAuthenticator":
        values = os.environ if environment is None else environment
        direct = str(values.get("MINERU_SERVICE_API_TOKEN", "")).strip()
        configured_file = token_file
        if configured_file is None:
            raw_file = str(values.get("MINERU_SERVICE_API_TOKEN_FILE", "")).strip()
            configured_file = Path(raw_file).expanduser() if raw_file else None
        tokens: dict[str, str] = {}
        if direct:
            tokens[direct] = "default"
        if configured_file is not None:
            tokens.update(_read_token_file(configured_file))
        return cls(tokens)

    @property
    def configured(self) -> bool:
        return bool(self._tokens)

    def principal_for(self, authorization: str) -> str | None:
        prefix = "Bearer "
        if not authorization.startswith(prefix):
            return None
        presented = authorization[len(prefix) :].strip()
        if not presented:
            return None
        matched: str | None = None
        for token, principal in self._tokens.items():
            if secrets.compare_digest(presented, token):
                matched = principal
        return matched


def _read_token_file(path: Path) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError("MinerU API token file cannot be read") from exc
    stripped = text.strip()
    if not stripped:
        raise ValueError("MinerU API token file is empty")
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        return {str(token): _safe_principal(str(principal)) for principal, token in parsed.items()}

    result: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            principal, token = line.split("=", 1)
            result[token.strip()] = _safe_principal(principal.strip())
        else:
            result[line] = "default"
    if not result:
        raise ValueError("MinerU API token file contains no credentials")
    return result


def _safe_principal(value: str) -> str:
    value = value.strip()
    if not value or len(value) > 96 or any(
        character
        not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
        for character in value
    ):
        raise ValueError("MinerU token principal contains invalid characters")
    return value
