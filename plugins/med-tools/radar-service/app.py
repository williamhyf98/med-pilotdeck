"""Persistent HTTP service for DAMO RADAR inference on a dedicated GPU node."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import shutil
import stat
import sys
import time
import uuid
import zipfile
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask
from starlette.types import ASGIApp, Message, Receive, Scope, Send


SERVICE_ROOT = Path(os.environ.get("RADAR_SERVICE_ROOT", "/local_data/radar-service")).resolve()
RADAR_ROOT = Path(os.environ.get("RADAR_ROOT", SERVICE_ROOT / "damo-radar")).resolve()
MODEL_ROOT = Path(os.environ.get("RADAR_MODEL_ROOT", SERVICE_ROOT / "models")).resolve()
TEXT_EMBEDDING = Path(
    os.environ.get(
        "RADAR_TEXT_EMBEDDING",
        RADAR_ROOT / "ckpt" / "infer_text_embedding_radar.pt",
    )
).resolve()
WORK_ROOT = Path(os.environ.get("RADAR_WORK_ROOT", SERVICE_ROOT / "work")).resolve()
DEVICE = os.environ.get("RADAR_DEVICE", "cuda:0").strip() or "cuda:0"
API_KEY = os.environ.get("RADAR_API_KEY", "").strip()
MAX_UPLOAD_BYTES = int(os.environ.get("RADAR_MAX_UPLOAD_BYTES", str(8 * 1024**3)))
MAX_MULTIPART_OVERHEAD_BYTES = max(
    0, int(os.environ.get("RADAR_MAX_MULTIPART_OVERHEAD_BYTES", str(1024**2)))
)
MAX_ARCHIVE_MEMBERS = int(os.environ.get("RADAR_MAX_ARCHIVE_MEMBERS", "20000"))
RETENTION_SECONDS = max(300, int(os.environ.get("RADAR_RETENTION_SECONDS", "3600")))
CLEANUP_INTERVAL_SECONDS = max(
    60, int(os.environ.get("RADAR_CLEANUP_INTERVAL_SECONDS", "600"))
)
MODEL_RETRY_SECONDS = max(30, int(os.environ.get("RADAR_MODEL_RETRY_SECONDS", "60")))

HELPER_ROOT = Path(os.environ.get("RADAR_HELPER_ROOT", SERVICE_ROOT)).resolve()
REPOSITORY_HELPER_ROOT = Path(__file__).resolve().parent.parent / "scripts"
if not (HELPER_ROOT / "radar_inference.py").is_file() and (
    REPOSITORY_HELPER_ROOT / "radar_inference.py"
).is_file():
    HELPER_ROOT = REPOSITORY_HELPER_ROOT

sys.path.insert(0, str(HELPER_ROOT))
sys.path.insert(0, str(RADAR_ROOT / "RADAR_inference"))

from radar_inference import domain_flags, stage_inputs, summarize_csv  # noqa: E402


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path, ignore_errors=True)


class RadarRuntime:
    def __init__(self) -> None:
        self.device: Any = None
        self.initialized: Any = None
        self.loaded = False
        self.load_error = ""
        self.lock = asyncio.Lock()
        self.active_request_id = ""

    def load(self) -> None:
        os.environ["MODEL_ROOT"] = str(MODEL_ROOT)
        os.environ["CONFIGS_ROOT"] = str(MODEL_ROOT)
        os.environ["TEXT_EMBEDDING_PATH"] = str(TEXT_EMBEDDING)
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
        self.loaded = False
        self.load_error = ""
        try:
            import torch
            from inference_demo import initialize

            self.device = torch.device(DEVICE)
            if self.device.type == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("CUDA was requested but is unavailable")
            self.initialized = initialize(self.device)
            self.loaded = True
        except Exception as exc:  # noqa: BLE001
            self.load_error = f"{type(exc).__name__}: {exc}"

    def infer(
        self,
        *,
        input_path: Path,
        output_dir: Path,
        top_k: int,
        threshold: float,
        max_cases: int,
        study_context: str,
    ) -> dict[str, Any]:
        import torch
        from inference_demo import inference

        staging = output_dir / "input"
        manifest = stage_inputs(input_path, staging, max_cases)
        try:
            inference(
                self.initialized,
                str(staging),
                str(output_dir),
                "remote",
                self.device,
                0,
            )
            csv_path = output_dir / "RADAR_infer_results_remote.csv"
            cases = summarize_csv(csv_path, manifest, top_k, threshold)
        finally:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        completed = {str(case.get("file_name") or "") for case in cases}
        missing = [
            item for item in manifest if str(item.get("staged_file") or "") not in completed
        ]
        if not cases:
            raise RuntimeError("RADAR produced no result rows for the staged CT volumes")
        return {
            "ok": True,
            "status": "partial" if missing else "completed",
            "model": "DAMO RADAR",
            "device": str(self.device),
            "study_context": study_context,
            "training_domain": "primarily contrast-enhanced abdominal CT",
            "domain_flags": domain_flags(study_context),
            "warnings": [
                "RADAR scores are uncalibrated model signals, not clinical probabilities or diagnoses.",
                "A low score does not establish absence, and a high score requires image-level and clinical review.",
                "Use outside contrast-enhanced abdominal CT is subject to domain shift.",
            ],
            "cases": cases,
            "failed_cases": missing,
        }


runtime = RadarRuntime()


class RequestBodyTooLarge(Exception):
    pass


class RadarGuardMiddleware:
    """Authenticate and admit uploads before Starlette parses multipart bodies."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        supplied = headers.get(b"authorization", b"")
        expected = f"Bearer {API_KEY}".encode("utf-8")
        if not API_KEY or not secrets.compare_digest(supplied, expected):
            await JSONResponse(status_code=401, content={"detail": "invalid API key"})(
                scope, receive, send
            )
            return

        if scope.get("path") != "/v1/analyze":
            await self.app(scope, receive, send)
            return

        # A free asyncio.Lock acquires without yielding, so the check and acquire are
        # atomic with respect to other requests on this event loop.
        if runtime.lock.locked():
            await JSONResponse(
                status_code=429,
                content={"detail": "RADAR is processing another request"},
            )(scope, receive, send)
            return
        await runtime.lock.acquire()

        request_limit = MAX_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
        content_length = headers.get(b"content-length", b"")
        try:
            declared_bytes = int(content_length) if content_length else 0
        except ValueError:
            declared_bytes = 0
        received_bytes = 0

        async def limited_receive() -> Message:
            nonlocal received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > request_limit:
                    raise RequestBodyTooLarge
            return message

        try:
            if declared_bytes > request_limit:
                await JSONResponse(
                    status_code=413,
                    content={"detail": "upload exceeds configured limit"},
                )(scope, receive, send)
                return
            scope.setdefault("state", {})["radar_admitted"] = True
            try:
                await self.app(scope, limited_receive, send)
            except RequestBodyTooLarge:
                await JSONResponse(
                    status_code=413,
                    content={"detail": "upload exceeds configured limit"},
                )(scope, receive, send)
        finally:
            runtime.lock.release()


def cleanup_expired_requests(now: float | None = None) -> int:
    if not WORK_ROOT.is_dir():
        return 0
    cutoff = (time.time() if now is None else now) - RETENTION_SECONDS
    removed = 0
    for path in WORK_ROOT.iterdir():
        if path.name == runtime.active_request_id:
            continue
        try:
            expired = path.stat().st_mtime < cutoff
        except OSError:
            continue
        if expired:
            _remove_path(path)
            removed += 1
    return removed


async def _cleanup_loop() -> None:
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        await asyncio.to_thread(cleanup_expired_requests)


async def _model_retry_loop() -> None:
    while not runtime.loaded:
        await asyncio.sleep(MODEL_RETRY_SECONDS)
        await asyncio.to_thread(runtime.load)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not API_KEY:
        raise RuntimeError("RADAR_API_KEY must be configured; unauthenticated mode is disabled")
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(cleanup_expired_requests)
    await asyncio.to_thread(runtime.load)
    cleanup_task = asyncio.create_task(_cleanup_loop())
    model_retry_task = asyncio.create_task(_model_retry_loop())
    try:
        yield
    finally:
        for task in (cleanup_task, model_retry_task):
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


app = FastAPI(title="DAMO RADAR Service", version="1.0.0", lifespan=lifespan)
app.add_middleware(RadarGuardMiddleware)


def authorize(request: Request) -> None:
    supplied = request.headers.get("authorization", "")
    expected = f"Bearer {API_KEY}"
    if not API_KEY or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="invalid API key")


def safe_extract(archive: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as handle:
        members = handle.infolist()
        if len(members) > MAX_ARCHIVE_MEMBERS:
            raise ValueError(f"archive has too many members: {len(members)}")
        total = sum(member.file_size for member in members)
        if total > MAX_UPLOAD_BYTES:
            raise ValueError("expanded archive is too large")
        root = destination.resolve()
        for member in members:
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError(f"archive contains a symbolic link: {member.filename}")
            target = (destination / member.filename).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f"unsafe archive member: {member.filename}")
        handle.extractall(destination)
    return destination


async def save_upload(upload: UploadFile, destination: Path) -> int:
    size = 0
    with destination.open("wb") as handle:
        while chunk := await upload.read(8 * 1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="upload exceeds configured limit")
            handle.write(chunk)
    return size


@app.get("/health")
async def health(request: Request) -> dict[str, Any]:
    authorize(request)
    details: dict[str, Any] = {
        "ok": runtime.loaded,
        "ready": runtime.loaded,
        "model": "DAMO RADAR",
        "device": DEVICE,
        "busy": runtime.lock.locked(),
        "load_error": runtime.load_error,
        "retention_seconds": RETENTION_SECONDS,
    }
    if runtime.loaded:
        import torch

        details["torch"] = torch.__version__
        details["cuda_available"] = torch.cuda.is_available()
    return details


@app.post("/v1/analyze")
async def analyze(
    request: Request,
    file: UploadFile = File(...),
    top_k: int = Form(15),
    threshold: float = Form(0.5),
    max_cases: int = Form(4),
    study_context: str = Form(""),
) -> dict[str, Any]:
    authorize(request)
    if not runtime.loaded:
        raise HTTPException(status_code=503, detail=runtime.load_error or "model not ready")
    if not getattr(request.state, "radar_admitted", False):
        raise HTTPException(status_code=503, detail="request admission middleware unavailable")
    request_id = uuid.uuid4().hex
    runtime.active_request_id = request_id
    request_dir = WORK_ROOT / request_id
    completed = False
    try:
        top_k = max(1, min(int(top_k), 50))
        threshold = max(0.0, min(float(threshold), 1.0))
        max_cases = max(1, min(int(max_cases), 8))
        request_dir.mkdir(parents=True, exist_ok=False)
        filename = Path(file.filename or "study.nii.gz").name
        upload_path = request_dir / f"upload-{filename}"
        upload_bytes = await save_upload(file, upload_path)
        if await asyncio.to_thread(zipfile.is_zipfile, upload_path):
            input_path = await asyncio.to_thread(
                safe_extract, upload_path, request_dir / "uploaded"
            )
        else:
            input_path = upload_path
        output_dir = request_dir / "output"
        output_dir.mkdir()
        result = await asyncio.to_thread(
            runtime.infer,
            input_path=input_path,
            output_dir=output_dir,
            top_k=top_k,
            threshold=threshold,
            max_cases=max_cases,
            study_context=study_context.strip(),
        )
        result["request_id"] = request_id
        result["upload_bytes"] = upload_bytes
        result["artifacts"] = {
            "scores_csv_url": f"/v1/artifacts/{request_id}/scores.csv",
        }
        (output_dir / "radar_summary.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        await asyncio.to_thread(_remove_path, upload_path)
        await asyncio.to_thread(_remove_path, request_dir / "uploaded")
        await asyncio.to_thread(_remove_path, output_dir / "input")
        completed = True
        return result
    except HTTPException:
        raise
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        raise HTTPException(status_code=400, detail=f"{type(exc).__name__}: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc
    finally:
        await file.close()
        if not completed:
            await asyncio.to_thread(_remove_path, request_dir)
        runtime.active_request_id = ""


@app.get("/v1/artifacts/{request_id}/scores.csv")
async def scores_csv(request: Request, request_id: str) -> FileResponse:
    authorize(request)
    if not re_full_request_id(request_id):
        raise HTTPException(status_code=400, detail="invalid request id")
    request_dir = WORK_ROOT / request_id
    path = request_dir / "output" / "RADAR_infer_results_remote.csv"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="scores not found")
    return FileResponse(
        path,
        media_type="text/csv",
        filename="RADAR_infer_results_remote.csv",
        background=BackgroundTask(_remove_path, request_dir),
    )


def re_full_request_id(value: str) -> bool:
    return len(value) == 32 and all(character in "0123456789abcdef" for character in value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18120)
    parser.add_argument("--ssl-certfile")
    parser.add_argument("--ssl-keyfile")
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        workers=1,
        ssl_certfile=args.ssl_certfile,
        ssl_keyfile=args.ssl_keyfile,
    )


if __name__ == "__main__":
    main()
