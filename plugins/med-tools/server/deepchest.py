"""HTTP client for asynchronous DeepChest jobs; no shell or GPU required locally."""

import json
import os
import re
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

import httpx


class DeepChestClient:
    def __init__(self, transport=None):
        self.base = os.environ.get("MED_DEEPCHEST_API_BASE", "").strip().rstrip("/")
        url = urlsplit(self.base)
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("Configure MED_DEEPCHEST_API_BASE")
        if url.scheme == "http" and url.hostname not in (
            "localhost",
            "127.0.0.1",
            "::1",
        ):
            raise ValueError(
                "Remote DeepChest requires HTTPS; HTTP is allowed only through a loopback tunnel"
            )
        key = os.environ.get("MED_DEEPCHEST_API_KEY", "").strip()
        if not key and os.environ.get("MED_DEEPCHEST_API_KEY_FILE"):
            key = (
                Path(os.environ["MED_DEEPCHEST_API_KEY_FILE"])
                .expanduser()
                .read_text()
                .strip()
            )
        if not key:
            raise ValueError("Configure MED_DEEPCHEST_API_KEY_FILE")
        ca = os.environ.get("MED_DEEPCHEST_CA_BUNDLE", "").strip()
        import ssl

        verify = ssl.create_default_context(cafile=ca) if ca else True
        self.http = httpx.Client(
            base_url=self.base,
            headers={"Authorization": f"Bearer {key}"},
            verify=verify,
            trust_env=False,
            timeout=httpx.Timeout(300, connect=10),
            transport=transport,
        )

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.http.close()

    def health(self):
        response = self.http.get("/health", timeout=10)
        response.raise_for_status()
        return response.json()

    def submit(self, path, question, body_region, modality, intensity_units):
        source = Path(path).expanduser()
        if source.is_symlink():
            raise ValueError("Symlink inputs are not allowed")
        source = source.resolve(strict=True)
        data = {
            "question": question,
            "body_region": body_region,
            "modality": modality,
            "intensity_units": intensity_units,
        }
        with tempfile.TemporaryDirectory(prefix="deepchest-upload-") as temp:
            if source.is_dir():
                files = list(source.rglob("*"))
                if any(p.is_symlink() for p in files):
                    raise ValueError("Symlink inputs are not allowed")
                files = [p for p in files if p.is_file()]
                if (
                    not files
                    or len(files) > 10000
                    or sum(p.stat().st_size for p in files) > 2 * 1024**3
                ):
                    raise ValueError(
                        "DICOM series exceeds size/count limits or is empty"
                    )
                archive = Path(temp) / "series.zip"
                with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as z:
                    for p in files:
                        z.write(p, p.relative_to(source))
                source = archive
            if not source.is_file() or source.stat().st_size > 2 * 1024**3:
                raise ValueError("Upload exceeds size limit")
            with source.open("rb") as handle:
                response = self.http.post(
                    "/v1/jobs",
                    data=data,
                    files={"file": (source.name, handle, "application/octet-stream")},
                )
            response.raise_for_status()
            result = response.json()
            result["next_action"] = (
                "使用 med_deepchest_job 查询此 job_id；等待成功后再回答，不要重新提交任务。"
            )
            return result

    def inspect(self, job_id):
        if not re.fullmatch("[0-9a-f]{32}", job_id):
            raise ValueError("Invalid DeepChest job ID")
        response = self.http.get(f"/v1/jobs/{job_id}", timeout=15)
        response.raise_for_status()
        state = response.json()
        if state.get("job_id") != job_id:
            raise ValueError("Mismatched DeepChest job ID")
        if state.get("status") != "succeeded":
            return state
        response = self.http.get(f"/v1/jobs/{job_id}/result", timeout=30)
        response.raise_for_status()
        result = response.json()
        if result.get("case_id") != job_id or not result.get("report"):
            raise ValueError("Mismatched or empty DeepChest result")
        configured = os.environ.get("MED_DEEPCHEST_OUTPUT_DIR")
        pilot = Path(os.environ.get("PILOT_HOME") or Path.home() / ".pilotdeck")
        root = (
            Path(configured).expanduser()
            if configured
            else pilot / "artifacts" / "deepchest"
        )
        output = root.resolve() / job_id
        if output.is_symlink():
            raise ValueError("Unsafe output directory")
        output.mkdir(parents=True, exist_ok=True)
        for name in ("report.md", "result.json"):
            if (output / name).is_symlink():
                raise ValueError("Unsafe output file")
        (output / "report.md").write_text(result["report"])
        (output / "result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2)
        )
        return {
            **state,
            **result,
            "artifacts": [
                {"path": str(output / "report.md"), "label": "胸部 CT 分析报告"},
                {"path": str(output / "result.json"), "label": "胸部 CT 模型证据"},
            ],
            "presentation": "纯判读任务请完整呈现 report，不重复总结；复合任务保留报告并完成后续工作。",
        }


def call_deepchest(action, **kwargs):
    try:
        with DeepChestClient() as client:
            return getattr(client, action)(**kwargs)
    except httpx.HTTPStatusError as exc:
        return {
            "status": "error",
            "error": f"DeepChest HTTP {exc.response.status_code}，请检查服务、凭据或输入。",
        }
    except (ValueError, OSError, httpx.HTTPError) as exc:
        return {"status": "error", "error": str(exc)}
