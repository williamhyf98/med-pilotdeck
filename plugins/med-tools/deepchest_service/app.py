"""Authenticated, bounded single-worker HTTP queue. Run exactly one Uvicorn worker."""

import asyncio
import json
import os
import re
import secrets
import shutil
import signal
import sys
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False))
    temporary.replace(path)


async def subprocess_runner(job):
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "deepchest_service.worker",
        str(job),
        start_new_session=True,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=int(os.environ.get("DEEPCHEST_JOB_TIMEOUT", "1800")),
        )
        (job / "worker-error.log").write_bytes(stderr or b"")
        if process.returncode:
            raise RuntimeError("pipeline_failed")
    finally:
        # Children inherit the group; clean up on timeout/shutdown even if the parent exited.
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()


def create_app(
    root, api_key, runner=subprocess_runner, max_upload=2 * 1024**3, max_jobs=4
):
    root = Path(root).resolve()
    if not api_key:
        raise ValueError("DEEPCHEST_API_KEY is required")
    queue = asyncio.Queue(maxsize=max_jobs)
    active = set()
    retention = max(3600, int(os.environ.get("DEEPCHEST_RETENTION_SECONDS", "86400")))

    def status(job, **updates):
        path = job / "status.json"
        value = json.loads(path.read_text()) if path.exists() else {"job_id": job.name}
        value.update(updates, updated_at=time.time())
        write_json(path, value)
        return value

    async def consume():
        while True:
            job = await queue.get()
            try:
                status(job, status="running")
                await runner(job)
                result = json.loads((job / "result.json").read_text())
                if result.get("case_id") != job.name or not result.get("report"):
                    raise ValueError("invalid_result")
                status(job, status="succeeded")
            except asyncio.CancelledError:
                status(job, status="failed", error="service_stopped")
                raise
            except Exception as exc:
                error = (
                    "job_timeout"
                    if isinstance(exc, TimeoutError)
                    else "pipeline_failed"
                )
                status(job, status="failed", error=error)
            finally:
                active.discard(job.name)
                queue.task_done()

    async def cleanup():
        while True:
            await asyncio.sleep(600)
            for job in root.iterdir():
                if (
                    not re.fullmatch("[0-9a-f]{32}", job.name)
                    or job.name in active
                    or job.is_symlink()
                ):
                    continue
                path = job / "status.json"
                if path.is_file():
                    value = json.loads(path.read_text())
                    if (
                        value.get("status") in ("succeeded", "failed")
                        and time.time() - value["updated_at"] > retention
                    ):
                        shutil.rmtree(job)

    @asynccontextmanager
    async def lifespan(app):
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Prevent two processes using one work directory (including accidental --workers > 1).
        import fcntl

        with (root / ".service.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for path in root.glob("*/status.json"):
                value = json.loads(path.read_text())
                if value.get("status") in ("waiting", "running", "uploading"):
                    status(path.parent, status="failed", error="service_restarted")
            worker = asyncio.create_task(consume())
            janitor = asyncio.create_task(cleanup())
            try:
                yield
            finally:
                for task in (worker, janitor):
                    task.cancel()
                for task in (worker, janitor):
                    with suppress(asyncio.CancelledError):
                        await task

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def authenticate(request, call_next):
        if not secrets.compare_digest(
            request.headers.get("authorization", ""), f"Bearer {api_key}"
        ):
            return JSONResponse({"detail": "invalid API key"}, status_code=401)
        # Require length on uploads so multipart parsing cannot spool an unbounded body.
        if request.method == "POST":
            try:
                length = int(request.headers.get("content-length", "-1"))
            except ValueError:
                length = -1
            if length < 0:
                return JSONResponse(
                    {"detail": "Content-Length required"}, status_code=411
                )
            if length > max_upload + 65536:
                return JSONResponse({"detail": "Upload too large"}, status_code=413)
        return await call_next(request)

    def get_job(job_id):
        if not re.fullmatch("[0-9a-f]{32}", job_id):
            raise HTTPException(404, "Unknown job")
        job = root / job_id
        if not (job / "status.json").is_file():
            raise HTTPException(404, "Unknown job")
        return job

    @app.get("/health")
    async def health():
        workspace = Path(os.environ.get("MED_DEEPCHEST_ROOT", "/nonexistent"))
        required = [
            ".venvs/radar/bin/python",
            "models/ct_clip/CT-CLIP_v2.pt",
            "models/biomedvlp/config.json",
            "experiments/3dmedagent_repro/run_ctclip_deepchest.py",
            "experiments/3dmedagent_repro/segment_deepchest.py",
        ]
        missing = [p for p in required if not (workspace / p).is_file()]
        config = all(
            os.environ.get(x)
            for x in (
                "DEEPCHEST_GPU",
                "FINAL_TEST_OPENAI_BASE_URL",
                "FINAL_TEST_OPENAI_MODEL",
            )
        )
        return {
            "ready": not missing and config,
            "missing": missing,
            "configuration_ready": config,
            "active_jobs": len(active),
            "capacity": max_jobs,
            "gpu_inference_verified": False,
            "note": "Readiness checks files/configuration only; inference is verified per job.",
        }

    @app.post("/v1/jobs", status_code=202)
    async def submit(
        file: UploadFile = File(...),
        question: str = Form(...),
        body_region: str = Form(...),
        modality: str = Form(...),
        intensity_units: str = Form(...),
    ):
        if (
            not question.strip()
            or len(question) > 12000
            or (body_region, modality, intensity_units) != ("chest", "CT", "HU")
        ):
            raise HTTPException(
                422, "Provide a question and confirm complete chest CT in HU"
            )
        filename = (file.filename or "").lower()
        suffix = next(
            (x for x in (".nii.gz", ".nii", ".zip") if filename.endswith(x)), None
        )
        if suffix is None:
            raise HTTPException(422, "Expected NIfTI or a single DICOM series ZIP")
        if len(active) >= max_jobs:
            raise HTTPException(429, "DeepChest queue is full")
        job = root / secrets.token_hex(16)
        active.add(job.name)
        job.mkdir(mode=0o700)
        status(job, status="uploading")
        try:
            size = 0
            with (job / f"upload{suffix}").open("wb") as handle:
                while block := await file.read(1024**2):
                    size += len(block)
                    if size > max_upload:
                        raise HTTPException(413, "Upload too large")
                    handle.write(block)
            if not size:
                raise HTTPException(422, "Empty upload")
            write_json(
                job / "request.json",
                {
                    "upload": f"upload{suffix}",
                    "question": question,
                    "body_region": body_region,
                    "modality": modality,
                    "intensity_units": intensity_units,
                },
            )
            value = status(job, status="waiting")
            queue.put_nowait(job)
            return value
        except BaseException:
            active.discard(job.name)
            status(job, status="failed", error="upload_failed")
            raise
        finally:
            await file.close()

    @app.get("/v1/jobs/{job_id}")
    async def inspect(job_id: str):
        job = get_job(job_id)
        value = json.loads((job / "status.json").read_text())
        phase = job / "phase.txt"
        if phase.is_file():
            value["phase"] = phase.read_text().strip()
        return value

    @app.get("/v1/jobs/{job_id}/result")
    async def result(job_id: str):
        job = get_job(job_id)
        if json.loads((job / "status.json").read_text())["status"] != "succeeded":
            raise HTTPException(409, "Job has not succeeded")
        return json.loads((job / "result.json").read_text())

    return app


def configured_app():
    os.umask(0o077)
    key_path = os.environ.get("DEEPCHEST_API_KEY_FILE")
    key = (
        Path(key_path).read_text().strip()
        if key_path
        else os.environ.get("DEEPCHEST_API_KEY", "")
    )
    return create_app(Path(os.environ["DEEPCHEST_WORK_ROOT"]), key)
