"""Remote MinerU HTTP client and local MCP-compatible facade."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import time
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse

import httpx

from .mineru_ingest import (
    SCHEMA_VERSION,
    _read_jsonl,
    _sha256_file,
)
from .mineru_paths import (
    assert_mineru_source_path,
    resolve_mineru_root,
    to_mineru_user_relative_path,
)


REMOTE_JOB_RE = re.compile(r"^[0-9a-f]{32}$")
SAFE_ARTIFACT_RE = re.compile(
    r"^(?:manifest\.json|quality_report\.json|corpus/(?:chunks|pages|assets)\.jsonl"
    r"|assets/[A-Za-z0-9._/-]+"
    r"|mineru_raw/[A-Za-z0-9._/-]+(?:\.md|_content_list\.json|_model\.json))$"
)


class RemoteMinerUError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class RemoteMinerUClient:
    def __init__(
        self,
        *,
        environment: Mapping[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.environment = dict(os.environ if environment is None else environment)
        base = str(self.environment.get("MED_RAG_MINERU_API_BASE", "")).strip().rstrip("/")
        if not base:
            raise ValueError("MED_RAG_MINERU_API_BASE is required in remote mode")
        parsed = urlparse(base)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("MED_RAG_MINERU_API_BASE must be an HTTP(S) URL")
        if parsed.scheme == "http" and parsed.hostname not in {
            "127.0.0.1",
            "localhost",
            "::1",
        }:
            raise ValueError("plain HTTP is allowed only for the SSH tunnel loopback")
        self.base_url = base
        self.token = _read_token(self.environment)
        ca_bundle = str(self.environment.get("MED_RAG_MINERU_CA_BUNDLE", "")).strip()
        if ca_bundle and not Path(ca_bundle).is_file():
            raise OSError("configured MinerU CA bundle is missing")
        connect_timeout = _float_env(
            self.environment, "MED_RAG_MINERU_CONNECT_TIMEOUT", 10.0
        )
        self._http = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.token}"},
            timeout=httpx.Timeout(
                connect=connect_timeout,
                read=_float_env(self.environment, "MED_RAG_MINERU_READ_TIMEOUT", 60.0),
                write=_float_env(self.environment, "MED_RAG_MINERU_WRITE_TIMEOUT", 60.0),
                pool=connect_timeout,
            ),
            verify=ca_bundle or True,
            trust_env=False,
            transport=transport,
        )

    def __enter__(self) -> "RemoteMinerUClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def health(self) -> dict[str, Any]:
        return self._json_request("GET", "/health")

    def submit_file(self, source: Path, fields: Mapping[str, Any]) -> dict[str, Any]:
        source = Path(source)
        try:
            with source.open("rb") as handle:
                data = {
                    key: str(value)
                    for key, value in fields.items()
                    if value is not None and key not in {"source_path", "output_path"}
                }
                response = self._http.post(
                    "/v1/mineru/jobs",
                    data=data,
                    files={
                        "file": (
                            source.name,
                            handle,
                            mimetypes.guess_type(source.name)[0]
                            or "application/octet-stream",
                        )
                    },
                )
        except (OSError, httpx.HTTPError) as exc:
            raise RemoteMinerUError("source file cannot be read") from exc
        return self._response_json(response)

    def status(self, job_id: str) -> dict[str, Any]:
        self._validate_job_id(job_id)
        return self._json_request("GET", f"/v1/mineru/jobs/{job_id}")

    def result(self, job_id: str) -> dict[str, Any]:
        self._validate_job_id(job_id)
        return self._json_request("GET", f"/v1/mineru/jobs/{job_id}/result")

    def validate(self, job_id: str) -> dict[str, Any]:
        self._validate_job_id(job_id)
        return self._json_request("GET", f"/v1/mineru/jobs/{job_id}/validate")

    def download(self, job_id: str, artifact_name: str) -> bytes:
        self._validate_job_id(job_id)
        if not _safe_artifact_name(artifact_name):
            raise RemoteMinerUError("invalid artifact name", status_code=404)
        response = self._request_with_retry(
            "GET", f"/v1/mineru/jobs/{job_id}/artifacts/{artifact_name}"
        )
        if response.status_code >= 400:
            self._response_json(response)
        return response.content

    def _json_request(self, method: str, path: str) -> dict[str, Any]:
        try:
            response = self._request_with_retry(method, path)
        except httpx.HTTPError as exc:
            raise RemoteMinerUError("MinerU service network request failed") from exc
        return self._response_json(response)

    def _request_with_retry(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        attempts = 3 if method.upper() == "GET" else 1
        for attempt in range(attempts):
            try:
                response = self._http.request(method, path, **kwargs)
            except httpx.HTTPError:
                if attempt + 1 >= attempts:
                    raise
                time.sleep(0.1 * (attempt + 1))
                continue
            if response.status_code >= 500 and attempt + 1 < attempts:
                time.sleep(0.1 * (attempt + 1))
                continue
            return response
        raise RemoteMinerUError("MinerU service network request failed")

    @staticmethod
    def _validate_job_id(job_id: str) -> None:
        if not REMOTE_JOB_RE.fullmatch(str(job_id or "")):
            raise RemoteMinerUError("invalid MinerU job id", status_code=404)

    @staticmethod
    def _response_json(response: httpx.Response) -> dict[str, Any]:
        if response.status_code >= 400:
            message = {
                401: "MinerU service authentication failed",
                404: "MinerU job or artifact not found",
                413: "MinerU upload is too large",
                429: "MinerU service queue is full",
            }.get(response.status_code, "MinerU service request failed")
            raise RemoteMinerUError(message, status_code=response.status_code)
        try:
            value = response.json()
        except ValueError as exc:
            raise RemoteMinerUError("MinerU service returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise RemoteMinerUError("MinerU service returned an invalid response")
        return value


class RemoteMinerUIngestService:
    """Expose the local ingest service shape while storing remote bundles locally."""

    def __init__(
        self,
        *,
        client: RemoteMinerUClient | None = None,
        environment: Mapping[str, str] | None = None,
    ) -> None:
        self.environment = dict(os.environ if environment is None else environment)
        self.client = client or RemoteMinerUClient(environment=self.environment)
        self.output_root = resolve_mineru_root(self.environment)
        self.remote_root = self.output_root / "remote-jobs"
        self.remote_root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def health(self) -> dict[str, Any]:
        value = self.client.health()
        return {
            "ok": bool(value.get("ok", value.get("ready", False))),
            "service": "mineru-ingest-tools",
            "transport": "remote-http",
            "remote": _redact_remote(value),
            "supported_inputs": value.get("supported_inputs", []),
            "async": True,
            "embedding": {"enabled": False, "reason": "ingest stage only"},
        }

    def submit(self, *, pdf_path: str, force: bool = False, **kwargs: Any) -> dict[str, Any]:
        source = assert_mineru_source_path(pdf_path, self.environment)
        source_sha256 = _sha256_file(source)
        fingerprint = _fingerprint(source_sha256, kwargs)
        if not force:
            existing = self._find_mapping(fingerprint)
            if existing is not None:
                return self.status(existing["job_id"])
        fields = {
            key: value
            for key, value in kwargs.items()
            if key not in {"device", "force"} and value is not None
        }
        response = self.client.submit_file(source, fields)
        job_id = str(response.get("job_id") or "")
        if not REMOTE_JOB_RE.fullmatch(job_id):
            raise RemoteMinerUError("MinerU service returned an invalid job id")
        mapping = {
            "job_id": job_id,
            "fingerprint": fingerprint,
            "source_sha256": source_sha256,
            "source_path": to_mineru_user_relative_path(source, self.environment),
            "source_name": source.name,
            "created_at": time.time(),
        }
        self._write_mapping(mapping)
        self._write_local_status(
            job_id,
            {
                "job_id": job_id,
                "status": response.get("status", "queued"),
                "phase": response.get("phase", response.get("status", "queued")),
                "source_sha256": source_sha256,
                "input_type": response.get("input_type", source.suffix.lstrip(".")),
                "job_dir": str(self._local_job_dir(job_id)),
            },
        )
        return self.status(job_id)

    def status(self, job_id: str) -> dict[str, Any]:
        mapping = self._mapping(job_id)
        response = self.client.status(job_id)
        value = {
            **response,
            "exists": True,
            "job_id": job_id,
            "source_sha256": mapping["source_sha256"],
            "source_path": mapping["source_path"],
            "job_dir": str(self._local_job_dir(job_id)),
        }
        self._write_local_status(job_id, value)
        return value

    def result(
        self, job_id: str, *, include_samples: bool = False, sample_limit: int = 3
    ) -> dict[str, Any]:
        mapping = self._mapping(job_id)
        local = self._local_result(job_id, include_samples=include_samples, sample_limit=sample_limit)
        if local is not None:
            return local
        response = self.client.result(job_id)
        artifacts = response.get("artifacts")
        if not isinstance(artifacts, list) or not artifacts:
            raise RemoteMinerUError("MinerU service returned no artifacts")
        local_dir = self._local_job_dir(job_id)
        local_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        for item in artifacts:
            if not isinstance(item, Mapping):
                raise RemoteMinerUError("MinerU service returned an invalid artifact")
            name = str(item.get("path") or "")
            if not _safe_artifact_name(name):
                raise RemoteMinerUError("MinerU service returned an invalid artifact")
            destination = local_dir / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            content = self.client.download(job_id, name)
            expected = str(item.get("sha256") or "")
            expected_bytes = item.get("bytes")
            if (
                not re.fullmatch(r"[a-f0-9]{64}", expected)
                or not isinstance(expected_bytes, int)
                or expected_bytes != len(content)
                or hashlib.sha256(content).hexdigest() != expected
            ):
                raise RemoteMinerUError("MinerU artifact checksum mismatch")
            temporary = destination.with_name(f".{destination.name}.download")
            temporary.write_bytes(content)
            temporary.replace(destination)
        local_result = {
            "exists": True,
            "job_id": job_id,
            "status": "succeeded",
            "source_sha256": mapping["source_sha256"],
            "source_path": mapping["source_path"],
            "job_dir": str(local_dir),
            "manifest_path": str(local_dir / "manifest.json"),
            "quality_report_path": str(local_dir / "quality_report.json"),
            "artifact_paths": {
                "chunks_jsonl": str(local_dir / "corpus" / "chunks.jsonl"),
                "pages_jsonl": str(local_dir / "corpus" / "pages.jsonl"),
                "assets_jsonl": str(local_dir / "corpus" / "assets.jsonl"),
                "assets_dir": str(local_dir / "assets"),
            },
            "manifest": response.get("manifest", {}),
            "remote_artifacts": artifacts,
        }
        _write_json(local_dir / "result.json", local_result)
        self._write_local_status(job_id, local_result)
        if include_samples:
            local_result["samples"] = _read_jsonl(
                local_dir / "corpus" / "chunks.jsonl",
                max_rows=max(0, min(int(sample_limit), 100)),
            )
        return local_result

    def validate(self, job_id: str) -> dict[str, Any]:
        remote = self.client.validate(job_id)
        local = self._local_result(job_id)
        if local is None:
            return {"ok": False, "job_id": job_id, "errors": ["bundle not downloaded"]}
        errors: list[str] = []
        for item in local.get("remote_artifacts", []):
            path = self._local_job_dir(job_id) / str(item.get("path") or "")
            if not path.is_file() or (
                item.get("sha256")
                and _sha256_file(path) != str(item["sha256"])
            ):
                errors.append(f"invalid artifact: {path.name}")
        return {
            "ok": bool(remote.get("ok", False)) and not errors,
            "job_id": job_id,
            "remote": remote,
            "errors": errors,
            "warnings": [],
        }

    def submit_batch(self, *, documents: list[Any], **kwargs: Any) -> dict[str, Any]:
        if not isinstance(documents, list) or not documents:
            raise ValueError("documents must be a non-empty list")
        batch_id = "batch-" + hashlib.sha256(
            json.dumps(documents, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()[:24] + f"-{time.time_ns()}"
        items = []
        for index, document in enumerate(documents):
            try:
                spec = dict(document) if isinstance(document, Mapping) else {}
                path = spec.pop("source_path", spec.pop("path", ""))
                item_kwargs = dict(kwargs)
                item_kwargs.update(spec)
                status = self.submit(pdf_path=str(path), **item_kwargs)
                items.append({"index": index, **status})
            except Exception as exc:
                items.append(
                    {
                        "index": index,
                        "status": "submit_failed",
                        "error": f"{type(exc).__name__}: remote submission failed",
                    }
                )
        batch_dir = self.remote_root / "batches" / batch_id
        batch_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        _write_json(batch_dir / "batch.json", {"batch_id": batch_id, "items": items})
        return self.batch_status(batch_id)

    def batch_status(self, batch_id: str) -> dict[str, Any]:
        path = self.remote_root / "batches" / batch_id / "batch.json"
        if not path.is_file():
            return {"exists": False, "batch_id": batch_id, "status": "not_found"}
        payload = json.loads(path.read_text(encoding="utf-8"))
        items = []
        for item in payload.get("items", []):
            value = dict(item)
            if value.get("job_id"):
                try:
                    value.update(self.status(str(value["job_id"])))
                except RemoteMinerUError as exc:
                    value.update({"status": "failed", "error": str(exc)})
            items.append(value)
        statuses = [str(item.get("status") or "") for item in items]
        succeeded = sum(status == "succeeded" for status in statuses)
        failed = sum(status in {"failed", "submit_failed"} for status in statuses)
        status = "succeeded" if succeeded == len(items) else "partial_failed" if succeeded else "failed" if failed else "running"
        return {
            "exists": True,
            "batch_id": batch_id,
            "status": status,
            "items": items,
            "counts": {"total": len(items), "succeeded": succeeded, "failed": failed},
        }

    def batch_result(self, batch_id: str, **kwargs: Any) -> dict[str, Any]:
        status = self.batch_status(batch_id)
        results = []
        for item in status.get("items", []):
            if item.get("job_id"):
                results.append(self.result(str(item["job_id"]), **kwargs))
            else:
                results.append(item)
        return {**status, "job_results": results, "bundle": {"built": False, "reason": "remote batch bundle is not enabled"}}

    def batch_validate(self, batch_id: str) -> dict[str, Any]:
        status = self.batch_status(batch_id)
        validations = [
            self.validate(str(item["job_id"]))
            for item in status.get("items", [])
            if item.get("job_id")
        ]
        return {
            "ok": bool(status.get("status") == "succeeded")
            and all(item.get("ok") for item in validations),
            "batch_id": batch_id,
            "status": status.get("status"),
            "job_validations": validations,
            "errors": [],
            "warnings": [],
        }

    def _find_mapping(self, fingerprint: str) -> dict[str, Any] | None:
        for path in self.remote_root.glob("*/mapping.json"):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if value.get("fingerprint") == fingerprint:
                return value
        return None

    def _mapping(self, job_id: str) -> dict[str, Any]:
        if not REMOTE_JOB_RE.fullmatch(str(job_id or "")):
            raise ValueError("invalid job_id")
        path = self.remote_root / job_id / "mapping.json"
        if not path.is_file():
            raise ValueError("unknown remote job")
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError("invalid remote job mapping") from exc

    def _write_mapping(self, mapping: Mapping[str, Any]) -> None:
        path = self.remote_root / str(mapping["job_id"]) / "mapping.json"
        _write_json(path, mapping)

    def _local_job_dir(self, job_id: str) -> Path:
        return self.output_root / "jobs" / job_id

    def _write_local_status(self, job_id: str, value: Mapping[str, Any]) -> None:
        _write_json(self._local_job_dir(job_id) / "job.json", value)

    def _local_result(
        self, job_id: str, *, include_samples: bool = False, sample_limit: int = 3
    ) -> dict[str, Any] | None:
        path = self._local_job_dir(job_id) / "result.json"
        if not path.is_file():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if include_samples:
            value["samples"] = _read_jsonl(
                self._local_job_dir(job_id) / "corpus" / "chunks.jsonl",
                max_rows=max(0, min(int(sample_limit), 100)),
            )
        return value


def _read_token(environment: Mapping[str, str]) -> str:
    direct = str(environment.get("MED_RAG_MINERU_API_TOKEN", "")).strip()
    token_file = str(environment.get("MED_RAG_MINERU_API_TOKEN_FILE", "")).strip()
    if token_file:
        try:
            direct = Path(token_file).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise OSError("MinerU API token file cannot be read") from exc
    if not direct:
        raise ValueError("MED_RAG_MINERU_API_TOKEN or token file is required")
    return direct


def _float_env(environment: Mapping[str, str], name: str, default: float) -> float:
    try:
        value = float(str(environment.get(name, default)).strip())
    except ValueError as exc:
        raise ValueError(f"{name} must be numeric") from exc
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _fingerprint(source_sha256: str, values: Mapping[str, Any]) -> str:
    payload = {
        key: value
        for key, value in values.items()
        if key not in {"source_path", "device", "force"}
    }
    payload["schema_version"] = SCHEMA_VERSION
    payload["source_sha256"] = source_sha256
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def _redact_remote(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): _redact_remote(item)
            for key, item in value.items()
            if key not in {"output_root", "job_dir", "model_root", "launcher"}
        }
    if isinstance(value, list):
        return [_redact_remote(item) for item in value]
    if isinstance(value, str) and value.startswith("/"):
        return "<redacted-path>"
    return value


def _safe_artifact_name(value: str) -> bool:
    return bool(SAFE_ARTIFACT_RE.fullmatch(value)) and not any(
        part in {"", ".", ".."} for part in Path(value).parts
    )
