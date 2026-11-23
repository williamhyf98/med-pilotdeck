"""Dedicated resident RADAR model API. Accepts staged NIfTI volumes, returns raw CSV.

The existing app.py owns uploads, DICOM conversion, case mapping and summaries.
Run one worker only, on a GPU host, with private loopback access.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import secrets
import shutil
import stat
import sys
import uuid
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response

ROOT = Path(os.environ.get("RADAR_SERVICE_ROOT", Path(__file__).resolve().parent)).resolve()
RADAR_ROOT = Path(os.environ.get("RADAR_ROOT", ROOT / "damo-radar")).resolve()
MODEL_ROOT = Path(os.environ.get("RADAR_MODEL_ROOT", ROOT / "models")).resolve()
WORK_ROOT = Path(os.environ.get("RADAR_GPU_WORK_ROOT", ROOT / "gpu-work")).resolve()
DEVICE = os.environ.get("RADAR_DEVICE", "cuda:0")
KEY_FILE = os.environ.get("RADAR_INFERENCE_API_KEY_FILE", "")
MAX_UPLOAD = int(os.environ.get("RADAR_MAX_UPLOAD_BYTES", str(8 * 1024**3)))
sys.path.insert(0, str(RADAR_ROOT / "RADAR_inference"))

ready = False
load_error = ""
initialized = None
device = None
lock = asyncio.Lock()
api_key = ""


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global ready, load_error, initialized, device, api_key
    api_key = Path(KEY_FILE).read_text(encoding="utf-8").strip() if KEY_FILE else ""
    if KEY_FILE and not api_key:
        raise RuntimeError("RADAR inference API key is empty")
    WORK_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.environ["MODEL_ROOT"] = str(MODEL_ROOT)
    os.environ["CONFIGS_ROOT"] = str(MODEL_ROOT)
    os.environ["TEXT_EMBEDDING_PATH"] = os.environ.get(
        "RADAR_TEXT_EMBEDDING",
        str(RADAR_ROOT / "ckpt" / "infer_text_embedding_radar.pt"),
    )
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    try:
        import torch
        from inference_demo import initialize

        device = torch.device(DEVICE)
        if device.type != "cuda" or not torch.cuda.is_available():
            raise RuntimeError("A CUDA device is required for this resident GPU API")
        initialized = await asyncio.to_thread(initialize, device)
        ready = True
    except Exception as exc:  # report load errors without accepting inference
        load_error = f"{type(exc).__name__}: {exc}"
    try:
        yield
    finally:
        ready = False
        initialized = None


app = FastAPI(title="RADAR model inference API", lifespan=lifespan, docs_url=None)


@app.middleware("http")
async def authenticate_and_bound(request: Request, call_next):
    if api_key and not secrets.compare_digest(
        request.headers.get("authorization", ""), f"Bearer {api_key}"
    ):
        return JSONResponse({"detail": "invalid API key"}, status_code=401)
    if request.method == "POST":
        try:
            size = int(request.headers.get("content-length", "-1"))
        except ValueError:
            size = -1
        if size < 0 or size > MAX_UPLOAD + 1024**2:
            return JSONResponse({"detail": "invalid upload size"}, status_code=413)
    return await call_next(request)


@app.get("/health")
async def health():
    return {
        "ready": ready,
        "load_error": load_error,
        "device": str(device),
        "busy": lock.locked(),
        "model": "DAMO RADAR",
    }


def unpack_staged_volumes(archive: Path, destination: Path) -> None:
    destination.mkdir()
    with zipfile.ZipFile(archive) as reader:
        members = reader.infolist()
        if not 1 <= len(members) <= 8:
            raise ValueError("Expected 1-8 staged NIfTI volumes")
        if sum(member.file_size for member in members) > MAX_UPLOAD:
            raise ValueError("Expanded upload exceeds configured limit")
        for member in members:
            name = member.filename
            if (
                "/" in name
                or "\\" in name
                or name in (".", "..")
                or not name.lower().endswith((".nii", ".nii.gz"))
                or stat.S_ISLNK(member.external_attr >> 16)
            ):
                raise ValueError("Archive must contain only flat NIfTI files")
        reader.extractall(destination)


def run_inference(staging: Path, output: Path) -> bytes:
    from inference_demo import inference
    from radar_inference import validate_nifti_header

    for volume in staging.iterdir():
        validate_nifti_header(volume)
    output.mkdir()
    inference(initialized, str(staging), str(output), "remote", device, 0)
    csv = output / "RADAR_infer_results_remote.csv"
    if not csv.is_file():
        raise RuntimeError("RADAR did not produce a CSV")
    return csv.read_bytes()


@app.post("/v1/infer")
async def infer(file: UploadFile = File(...)):
    if not ready:
        raise HTTPException(503, load_error or "model not ready")
    if lock.locked():
        raise HTTPException(429, "GPU model is processing another request")
    async with lock:
        job = WORK_ROOT / uuid.uuid4().hex
        job.mkdir(mode=0o700)
        try:
            upload = job / "upload.zip"
            size = 0
            with upload.open("wb") as handle:
                while chunk := await file.read(8 * 1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise HTTPException(413, "upload too large")
                    handle.write(chunk)
            staging = job / "input"
            unpack_staged_volumes(upload, staging)
            csv = await asyncio.to_thread(run_inference, staging, job / "output")
            return Response(csv, media_type="text/csv; charset=utf-8")
        except (ValueError, zipfile.BadZipFile) as exc:
            raise HTTPException(400, str(exc)) from exc
        finally:
            await file.close()
            shutil.rmtree(job, ignore_errors=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18221)
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, workers=1)
