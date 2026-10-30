"""FastAPI transport for the node12 MinerU ingestion worker."""

from __future__ import annotations

import asyncio
import hashlib
import inspect as inspect_module
import json
import os
import re
import secrets
import shutil
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from .auth import TokenAuthenticator
from .config import MinerUServiceConfig
from .doctor import runtime_doctor
from .worker import run_job

try:
    from server.mineru_ingest import SUPPORTED_INPUT_SUFFIXES
except ImportError:  # pragma: no cover - only useful for direct package imports
    SUPPORTED_INPUT_SUFFIXES = [".doc", ".docx", ".pdf", ".txt"]


JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
SAFE_ARTIFACT_RE = re.compile(
    r"^(?:manifest\.json|quality_report\.json|corpus/(?:chunks|pages|assets)\.jsonl"
    r"|assets/[A-Za-z0-9._/-]+"
    r"|mineru_raw/[A-Za-z0-9._/-]+(?:\.md|_content_list\.json|_model\.json))$"
)
PATH_KEYS = {"path", "source_path", "job_dir", "manifest_path", "quality_report_path"}


def create_app(
    root: Path | str,
    api_tokens: Mapping[str, str] | None = None,
    *,
    runner: Callable[[Path], Any] | None = None,
    runtime_environment: Mapping[str, str] | None = None,
    max_upload_bytes: int | None = None,
    max_jobs: int | None = None,
    job_timeout_seconds: float | None = None,
) -> FastAPI:
    values = dict(os.environ if runtime_environment is None else runtime_environment)
    root_path = Path(root).expanduser().resolve()
    values["MINERU_SERVICE_ROOT"] = str(root_path)
    config = MinerUServiceConfig.from_environment(values)
    configured_max_upload = max_upload_bytes or config.max_upload_bytes
    configured_max_jobs = max_jobs or config.max_jobs
    configured_timeout = (
        float(job_timeout_seconds)
        if job_timeout_seconds is not None
        else float(config.job_timeout_seconds)
    )
    if configured_max_upload < 1 or configured_max_jobs < 1 or configured_timeout <= 0:
        raise ValueError("MinerU service limits must be positive")

    authenticator = (
        TokenAuthenticator(api_tokens)
        if api_tokens is not None
        else TokenAuthenticator.from_environment(values, config.api_token_file)
    )
    queue: asyncio.Queue[Path] = asyncio.Queue(maxsize=configured_max_jobs)
    active: set[str] = set()
    service_lock = None
    worker_task: asyncio.Task[None] | None = None
    cleanup_task: asyncio.Task[None] | None = None

    async def execute_runner(job_dir: Path) -> None:
        selected = runner or (lambda job: run_job(job, config))
        if inspect_module.iscoroutinefunction(selected):
            await selected(job_dir)
            return
        value = await asyncio.to_thread(selected, job_dir)
        if inspect_module.isawaitable(value):
            await value

    def status_path(job_dir: Path) -> Path:
        return job_dir / "status.json"

    def read_status(job_dir: Path) -> dict[str, Any]:
        try:
            return json.loads(status_path(job_dir).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise HTTPException(status_code=404, detail="Unknown job")

    def write_json(path: Path, value: Mapping[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = path.with_name(f".{path.name}.tmp-{secrets.token_hex(4)}")
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)

    def set_status(job_dir: Path, **updates: Any) -> dict[str, Any]:
        value = {}
        if status_path(job_dir).is_file():
            try:
                value = json.loads(status_path(job_dir).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                value = {}
        value.update(updates)
        value["updated_at"] = time.time()
        write_json(status_path(job_dir), value)
        return value

    def tenant_root(principal: str) -> Path:
        return root_path / "tenants" / principal

    def job_dir_for(principal: str, job_id: str) -> Path:
        if not JOB_ID_RE.fullmatch(job_id):
            raise HTTPException(status_code=404, detail="Unknown job")
        job_dir = tenant_root(principal) / "jobs" / job_id
        if not status_path(job_dir).is_file():
            raise HTTPException(status_code=404, detail="Unknown job")
        return job_dir

    def public_status(job_dir: Path) -> dict[str, Any]:
        value = read_status(job_dir)
        result = {
            key: value[key]
            for key in (
                "job_id",
                "status",
                "phase",
                "source_sha256",
                "input_type",
                "parser",
                "created_at",
                "updated_at",
                "error_code",
            )
            if key in value
        }
        if "parser" in result:
            result["parser"] = _redact_public(result["parser"], "parser")
        result["live"] = value.get("status") in {"uploading", "queued", "running"}
        return result

    def result_payload(job_dir: Path) -> dict[str, Any]:
        current = read_status(job_dir)
        if current.get("status") != "succeeded":
            raise HTTPException(status_code=409, detail="Job has not succeeded")
        try:
            result = json.loads((job_dir / "result.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise HTTPException(status_code=500, detail="Invalid job result")
        validation = validate_result(job_dir, result)
        if not validation["ok"]:
            raise HTTPException(status_code=500, detail="Invalid job result")
        return {
            "job_id": current["job_id"],
            "status": current["status"],
            "source_sha256": current.get("source_sha256"),
            "input_type": current.get("input_type"),
            "parser": _redact_public(result.get("parser") or {}),
            "manifest": _redact_public(result.get("manifest") or {}),
            "artifacts": validation["artifacts"],
        }

    def artifact_file(job_dir: Path, artifact_name: str) -> Path:
        if not _safe_artifact_name(artifact_name):
            raise HTTPException(status_code=404, detail="Unknown artifact")
        try:
            result = json.loads((job_dir / "result.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise HTTPException(status_code=404, detail="Unknown artifact")
        registered = {
            str(item.get("path"))
            for item in result.get("artifacts", [])
            if isinstance(item, Mapping)
        }
        if artifact_name not in registered:
            raise HTTPException(status_code=404, detail="Unknown artifact")
        public_root = job_dir / "artifacts"
        candidate = public_root / artifact_name
        if not candidate.is_file():
            candidate = job_dir / artifact_name
            base = job_dir
        else:
            base = public_root
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(base.resolve())
        except (OSError, RuntimeError, ValueError):
            raise HTTPException(status_code=404, detail="Unknown artifact")
        return resolved

    def validate_result(job_dir: Path, result: Mapping[str, Any]) -> dict[str, Any]:
        descriptors = result.get("artifacts")
        if not isinstance(descriptors, list) or not descriptors:
            return {"ok": False, "artifacts": []}
        public_root = job_dir / "artifacts"
        output: list[dict[str, Any]] = []
        seen: set[str] = set()
        for raw in descriptors:
            if not isinstance(raw, Mapping):
                return {"ok": False, "artifacts": []}
            name = str(raw.get("path") or "")
            if not _safe_artifact_name(name) or name in seen:
                return {"ok": False, "artifacts": []}
            seen.add(name)
            candidate = public_root / name
            base = public_root
            if not candidate.is_file():
                candidate = job_dir / name
                base = job_dir
            try:
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(base.resolve())
            except (OSError, RuntimeError, ValueError):
                return {"ok": False, "artifacts": []}
            digest = _sha256_file(resolved)
            expected = str(raw.get("sha256") or "")
            expected_bytes = raw.get("bytes")
            if (
                not re.fullmatch(r"[a-f0-9]{64}", expected)
                or not isinstance(expected_bytes, int)
                or expected_bytes != resolved.stat().st_size
                or not secrets.compare_digest(digest, expected)
            ):
                return {"ok": False, "artifacts": []}
            output.append(
                {
                    "path": name,
                    "sha256": digest,
                    "bytes": resolved.stat().st_size,
                }
            )
        return {"ok": True, "artifacts": output}

    def health_payload() -> dict[str, Any]:
        report = runtime_doctor(config, values)
        return {
            "ok": bool(report["ok"]) and authenticator.configured,
            "service": "mineru-http",
            "runtime": report["runtime"],
            "cuda": report["cuda"],
            "storage": report["storage"],
            "queue": {
                "capacity": configured_max_jobs,
                "running_jobs": sum(
                    1
                    for job_id in active
                    if _status_for_active(root_path, job_id).get("status") == "running"
                ),
                "queued_jobs": queue.qsize(),
                "available_slots": max(0, configured_max_jobs - len(active)),
            },
            "supported_inputs": list(SUPPORTED_INPUT_SUFFIXES),
            "authentication": {"configured": authenticator.configured},
        }

    async def consume() -> None:
        while True:
            job_dir = await queue.get()
            job_id = job_dir.name
            try:
                set_status(job_dir, status="running", phase="mineru_parse")
                await asyncio.wait_for(
                    execute_runner(job_dir), timeout=configured_timeout
                )
                result = json.loads(
                    (job_dir / "result.json").read_text(encoding="utf-8")
                )
                validation = validate_result(job_dir, result)
                if not validation["ok"]:
                    raise ValueError("invalid_result")
                set_status(
                    job_dir,
                    status="succeeded",
                    phase="complete",
                    parser=result.get("parser") or {},
                )
            except asyncio.CancelledError:
                set_status(
                    job_dir,
                    status="failed",
                    phase="service_restarted",
                    error_code="service_restarted",
                )
                raise
            except asyncio.TimeoutError:
                set_status(
                    job_dir,
                    status="failed",
                    phase="timeout",
                    error_code="job_timeout",
                )
            except Exception:
                set_status(
                    job_dir,
                    status="failed",
                    phase="failed",
                    error_code="pipeline_failed",
                )
            finally:
                active.discard(job_id)
                queue.task_done()

    async def cleanup() -> None:
        while True:
            await asyncio.sleep(60)
            cutoff = time.time() - config.retention_seconds
            for status_file in (root_path / "tenants").glob("*/jobs/*/status.json"):
                try:
                    value = json.loads(status_file.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if (
                    value.get("status") in {"succeeded", "failed"}
                    and float(value.get("updated_at", 0)) < cutoff
                    and status_file.parent.name not in active
                ):
                    shutil.rmtree(status_file.parent, ignore_errors=True)

    def mark_restarted_jobs() -> None:
        jobs_root = root_path / "tenants"
        if not jobs_root.is_dir():
            return
        for status_file in jobs_root.glob("*/jobs/*/status.json"):
            try:
                value = json.loads(status_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if value.get("status") in {"uploading", "queued", "running"}:
                job_dir = status_file.parent
                set_status(
                    job_dir,
                    status="failed",
                    phase="service_restarted",
                    error_code="service_restarted",
                )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        nonlocal cleanup_task, worker_task, service_lock
        root_path.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root_path, 0o700)
        try:
            import fcntl

            service_lock = (root_path / ".service.lock").open("a", encoding="utf-8")
            fcntl.flock(service_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except ImportError:
            service_lock = None
        except OSError as exc:
            if service_lock is not None:
                service_lock.close()
            service_lock = None
            raise RuntimeError("another MinerU service process owns the work root") from exc
        mark_restarted_jobs()
        worker_task = asyncio.create_task(consume())
        cleanup_task = asyncio.create_task(cleanup())
        try:
            yield
        finally:
            for task in (worker_task, cleanup_task):
                if task is not None:
                    task.cancel()
            for task in (worker_task, cleanup_task):
                if task is None:
                    continue
                with suppress(asyncio.CancelledError):
                    await task
            if service_lock is not None:
                service_lock.close()

    app = FastAPI(
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.middleware("http")
    async def authenticate(request: Request, call_next: Callable[..., Awaitable[Response]]):
        if not authenticator.configured:
            return JSONResponse({"detail": "service authentication is unavailable"}, status_code=503)
        principal = authenticator.principal_for(request.headers.get("authorization", ""))
        if principal is None:
            return JSONResponse({"detail": "invalid credentials"}, status_code=401)
        request.state.principal = principal
        if request.method == "POST":
            try:
                content_length = int(request.headers.get("content-length", "-1"))
            except ValueError:
                content_length = -1
            if content_length < 0:
                return JSONResponse({"detail": "Content-Length required"}, status_code=411)
            if content_length > configured_max_upload + 64 * 1024:
                return JSONResponse({"detail": "Upload too large"}, status_code=413)
        return await call_next(request)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return health_payload()

    @app.post("/v1/mineru/jobs", status_code=202)
    async def submit(
        request: Request,
        file: UploadFile = File(...),
        book_id: str | None = Form(None),
        title: str | None = Form(None),
        volume: str | None = Form(None),
        language: str = Form("ch"),
        start_page: str | None = Form(None),
        end_page: str | None = Form(None),
        page_index_offset: str | None = Form(None),
        formula_enabled: str = Form("false"),
        table_enabled: str = Form("false"),
        timeout_seconds: str | None = Form(None),
        cpu_threads: str | None = Form(None),
        max_chars: str = Form("1200"),
        overlap_chars: str = Form("160"),
    ) -> dict[str, Any]:
        if len(active) >= configured_max_jobs or queue.full():
            raise HTTPException(status_code=429, detail="MinerU queue is full")
        filename = Path(file.filename or "").name
        suffix = Path(filename).suffix.lower()
        if not filename or suffix not in set(SUPPORTED_INPUT_SUFFIXES):
            raise HTTPException(status_code=422, detail="Unsupported document type")
        fields = _parse_request_fields(
            {
                "book_id": book_id,
                "title": title,
                "volume": volume,
                "language": language,
                "start_page": start_page,
                "end_page": end_page,
                "page_index_offset": page_index_offset,
                "formula_enabled": formula_enabled,
                "table_enabled": table_enabled,
                "timeout_seconds": timeout_seconds,
                "cpu_threads": cpu_threads,
                "max_chars": max_chars,
                "overlap_chars": overlap_chars,
            },
            max_timeout=max(1, int(configured_timeout)),
        )
        principal = request.state.principal
        job_id = secrets.token_hex(16)
        job_dir = tenant_root(principal) / "jobs" / job_id
        job_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
        input_dir = job_dir / "input"
        input_dir.mkdir(mode=0o700)
        upload_path = input_dir / filename
        digest = hashlib.sha256()
        size = 0
        set_status(
            job_dir,
            job_id=job_id,
            status="uploading",
            phase="uploading",
            source_sha256="",
            input_type=suffix.lstrip("."),
            created_at=time.time(),
            updated_at=time.time(),
        )
        try:
            with upload_path.open("wb") as handle:
                while block := await file.read(1024 * 1024):
                    size += len(block)
                    if size > configured_max_upload:
                        raise HTTPException(status_code=413, detail="Upload too large")
                    digest.update(block)
                    handle.write(block)
            if size == 0:
                raise HTTPException(status_code=422, detail="Empty upload")
            source_sha256 = digest.hexdigest()
            write_json(
                job_dir / "request.json",
                {
                    "filename": filename,
                    "source_sha256": source_sha256,
                    **fields,
                },
            )
            set_status(
                job_dir,
                status="queued",
                phase="queued",
                source_sha256=source_sha256,
                input_type=suffix.lstrip("."),
            )
            active.add(job_id)
            try:
                queue.put_nowait(job_dir)
            except asyncio.QueueFull:
                active.discard(job_id)
                set_status(job_dir, status="failed", phase="queue_full", error_code="queue_full")
                raise HTTPException(status_code=429, detail="MinerU queue is full")
            return {
                "job_id": job_id,
                "status": "queued",
                "source_sha256": source_sha256,
                "input_type": suffix.lstrip("."),
                "parser": {"runtime": "mineru", "device": config.default_device},
            }
        except BaseException:
            if job_id in active:
                active.discard(job_id)
            raise
        finally:
            await file.close()

    @app.get("/v1/mineru/jobs/{job_id}")
    async def inspect_job(request: Request, job_id: str) -> dict[str, Any]:
        return public_status(job_dir_for(request.state.principal, job_id))

    @app.get("/v1/mineru/jobs/{job_id}/result")
    async def result(request: Request, job_id: str) -> dict[str, Any]:
        return result_payload(job_dir_for(request.state.principal, job_id))

    @app.get("/v1/mineru/jobs/{job_id}/validate")
    async def validate(request: Request, job_id: str) -> dict[str, Any]:
        job_dir = job_dir_for(request.state.principal, job_id)
        current = read_status(job_dir)
        if current.get("status") != "succeeded":
            return {"ok": False, "job_id": job_id, "status": current.get("status")}
        try:
            value = json.loads((job_dir / "result.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"ok": False, "job_id": job_id, "errors": ["invalid_result"]}
        validation = validate_result(job_dir, value)
        return {
            "ok": validation["ok"],
            "job_id": job_id,
            "status": current.get("status"),
            "artifacts": validation["artifacts"],
            "errors": [] if validation["ok"] else ["invalid_artifact"],
        }

    @app.get("/v1/mineru/jobs/{job_id}/artifacts/{artifact_name:path}")
    async def artifact(request: Request, job_id: str, artifact_name: str):
        job_dir = job_dir_for(request.state.principal, job_id)
        if read_status(job_dir).get("status") != "succeeded":
            raise HTTPException(status_code=409, detail="Job has not succeeded")
        path = artifact_file(job_dir, artifact_name)
        return Response(
            content=path.read_bytes(),
            media_type="application/octet-stream",
            headers={"X-MinerU-Artifact-SHA256": _sha256_file(path)},
        )

    return app


def configured_app() -> FastAPI:
    config = MinerUServiceConfig.from_environment()
    if not config.api_token_file and not os.environ.get("MINERU_SERVICE_API_TOKEN"):
        raise ValueError("MINERU_SERVICE_API_TOKEN_FILE is required")
    return create_app(config.root)


def _parse_request_fields(values: Mapping[str, Any], *, max_timeout: int) -> dict[str, Any]:
    def optional_int(name: str, minimum: int = 0, maximum: int | None = None) -> int | None:
        raw = values.get(name)
        if raw is None or str(raw).strip() == "":
            return None
        try:
            value = int(str(raw))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"Invalid {name}") from exc
        if value < minimum or (maximum is not None and value > maximum):
            raise HTTPException(status_code=422, detail=f"Invalid {name}")
        return value

    def text(name: str, maximum: int = 256) -> str | None:
        raw = values.get(name)
        if raw is None:
            return None
        value = str(raw).strip()
        if len(value) > maximum:
            raise HTTPException(status_code=422, detail=f"Invalid {name}")
        return value or None

    def boolean(name: str) -> bool:
        raw = str(values.get(name, "false")).strip().lower()
        if raw in {"1", "true", "yes", "on"}:
            return True
        if raw in {"0", "false", "no", "off", ""}:
            return False
        raise HTTPException(status_code=422, detail=f"Invalid {name}")

    start_page = optional_int("start_page")
    end_page = optional_int("end_page")
    if start_page is not None and end_page is not None and end_page < start_page:
        raise HTTPException(status_code=422, detail="Invalid page range")
    timeout = optional_int("timeout_seconds", minimum=1, maximum=max_timeout) or max_timeout
    cpu_threads = optional_int("cpu_threads", minimum=1, maximum=64)
    max_chars = optional_int("max_chars", minimum=1, maximum=100_000) or 1200
    overlap_chars = optional_int("overlap_chars", minimum=0, maximum=max_chars - 1)
    if overlap_chars is None:
        overlap_chars = 160 if max_chars > 160 else max_chars // 4
    return {
        "book_id": text("book_id"),
        "title": text("title"),
        "volume": text("volume"),
        "language": text("language", 32) or "ch",
        "start_page": start_page,
        "end_page": end_page,
        "page_index_offset": optional_int("page_index_offset") or 0,
        "formula_enabled": boolean("formula_enabled"),
        "table_enabled": boolean("table_enabled"),
        "timeout_seconds": timeout,
        "cpu_threads": cpu_threads,
        "max_chars": max_chars,
        "overlap_chars": overlap_chars,
    }


def _redact_public(value: Any, key: str | None = None) -> Any:
    if isinstance(value, Mapping):
        return {
            str(item_key): _redact_public(item, str(item_key))
            for item_key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_public(item, key) for item in value]
    if isinstance(value, str) and (value.startswith("/") or key in PATH_KEYS):
        return "<redacted-path>" if value.startswith("/") else value
    return value


def _safe_artifact_name(value: str) -> bool:
    return bool(SAFE_ARTIFACT_RE.fullmatch(value)) and not any(
        part in {"", ".", ".."} for part in Path(value).parts
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _status_for_active(root: Path, job_id: str) -> dict[str, Any]:
    for path in root.glob(f"tenants/*/jobs/{job_id}/status.json"):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
    return {}
