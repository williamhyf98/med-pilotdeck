"""HTTP client for the persistent DAMO RADAR service on the GPU node."""

from __future__ import annotations

import json
import os
import re
import shutil
import ssl
import uuid
import zipfile
from hashlib import sha256
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from urllib.parse import urljoin, urlsplit


DEFAULT_API_BASE = "https://127.0.0.1:18120"
DEFAULT_TIMEOUT_SECONDS = 840
MAX_DISCOVERY_FILES = 50_000
DEFAULT_MAX_UPLOAD_BYTES = 8 * 1024**3


def _read_api_key() -> str:
    direct = os.environ.get("MED_RADAR_API_KEY", "").strip()
    if direct:
        return direct
    configured = os.environ.get("MED_RADAR_API_KEY_FILE", "").strip()
    pilot_home = os.environ.get("PILOT_HOME", "").strip()
    key_path = Path(configured).expanduser() if configured else None
    if key_path is None and pilot_home:
        key_path = Path(pilot_home).expanduser() / "secrets" / "med-radar-api-key"
    if key_path is None:
        return ""
    try:
        return key_path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def get_radar_config() -> Dict[str, Any]:
    timeout_raw = os.environ.get(
        "MED_RADAR_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS)
    ).strip() or str(DEFAULT_TIMEOUT_SECONDS)
    upload_raw = os.environ.get(
        "MED_RADAR_MAX_UPLOAD_BYTES", str(DEFAULT_MAX_UPLOAD_BYTES)
    ).strip() or str(DEFAULT_MAX_UPLOAD_BYTES)
    try:
        timeout = max(30, min(int(timeout_raw), 3600))
    except ValueError:
        timeout = DEFAULT_TIMEOUT_SECONDS
    try:
        max_upload_bytes = max(1, int(upload_raw))
    except ValueError:
        max_upload_bytes = DEFAULT_MAX_UPLOAD_BYTES
    pilot_home = os.environ.get("PILOT_HOME", "").strip()
    ca_bundle = os.environ.get("MED_RADAR_CA_BUNDLE", "").strip()
    if not ca_bundle and pilot_home:
        ca_bundle = str(
            Path(pilot_home).expanduser() / "certs" / "med-radar-ca.crt"
        )
    return {
        "api_base": (
            os.environ.get("MED_RADAR_API_BASE", DEFAULT_API_BASE).strip()
            or DEFAULT_API_BASE
        ).rstrip("/"),
        "api_key": _read_api_key(),
        "ca_bundle": ca_bundle,
        "timeout_seconds": timeout,
        "max_upload_bytes": max_upload_bytes,
    }


def _headers(cfg: Dict[str, Any]) -> Dict[str, str]:
    return {"Authorization": f"Bearer {cfg['api_key']}"} if cfg.get("api_key") else {}


def _tls_verification(cfg: Dict[str, Any]) -> ssl.SSLContext | bool:
    if not str(cfg["api_base"]).lower().startswith("https://"):
        return True
    ca_bundle = str(cfg.get("ca_bundle") or "")
    if not ca_bundle:
        raise ValueError("MED_RADAR_CA_BUNDLE is required for HTTPS")
    ca_path = Path(ca_bundle).expanduser().resolve()
    if not ca_path.is_file():
        raise ValueError(f"RADAR CA certificate does not exist: {ca_path}")
    return ssl.create_default_context(cafile=str(ca_path))


def radar_status(validate_runtime: bool = False) -> Dict[str, Any]:
    """Probe node12; its health response includes resident model and CUDA state."""
    import httpx

    cfg = get_radar_config()
    try:
        verify = _tls_verification(cfg)
        response = httpx.get(
            f"{cfg['api_base']}/health",
            headers=_headers(cfg),
            timeout=30 if validate_runtime else 5,
            verify=verify,
        )
        response.raise_for_status()
        remote = response.json()
        ready = bool(remote.get("ready"))
        error = "" if ready else str(remote.get("load_error") or "remote model not ready")
    except Exception as exc:  # noqa: BLE001
        ready = False
        remote = None
        error = f"{type(exc).__name__}: {exc}"
    return {
        "tool": "med_radar_status",
        "ready": ready,
        "api_base": cfg["api_base"],
        "remote": remote,
        "error": error,
        "scope": "RADAR is trained primarily for contrast-enhanced abdominal CT.",
    }


def _resolve_input(path: str) -> Path:
    value = Path(path).expanduser()
    return (Path.cwd() / value).resolve() if not value.is_absolute() else value.resolve()


def _output_dir_for(input_path: Path, call_id: str) -> Path:
    anchor = input_path if input_path.is_dir() else input_path.parent
    project_root = next(
        (candidate.parent for candidate in (anchor, *anchor.parents) if candidate.name == "inbox"),
        None,
    )
    if project_root is not None:
        base = project_root / "exports" / "radar"
    else:
        override = os.environ.get("MED_RADAR_OUTPUT_DIR", "").strip()
        base = (
            Path(override).expanduser().resolve()
            if override
            else input_path.parent / "derived" / "radar"
        )
    raw_name = input_path.name.removesuffix(".gz").removesuffix(".nii") or "study"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", raw_name).strip("-._") or "study"
    digest = sha256(str(input_path).encode("utf-8")).hexdigest()[:10]
    return base / f"{slug}-{digest}" / call_id


def _is_nifti(path: Path) -> bool:
    lower = path.name.lower()
    return lower.endswith(".nii") or lower.endswith(".nii.gz")


def _validate_multiframe_ct_file(path: Path) -> Dict[str, Any]:
    """Validate a single-file 3D CT without decoding its pixel payload."""
    try:
        import pydicom
    except ImportError as exc:
        raise ValueError("pydicom is required to validate a multi-frame DICOM CT") from exc

    tags = [
        "Modality",
        "NumberOfFrames",
        "Rows",
        "Columns",
        "SOPClassUID",
    ]
    try:
        dataset = pydicom.dcmread(
            str(path), stop_before_pixels=True, specific_tags=tags, force=False
        )
    except Exception as first_error:  # noqa: BLE001
        try:
            dataset = pydicom.dcmread(
                str(path), stop_before_pixels=True, specific_tags=tags, force=True
            )
        except Exception as exc:  # noqa: BLE001
            raise ValueError(
                f"Single-file RADAR input is not a readable DICOM: {type(first_error).__name__}"
            ) from exc

    modality = str(getattr(dataset, "Modality", "")).strip().upper()
    try:
        frame_count = int(getattr(dataset, "NumberOfFrames", 1) or 1)
        rows = int(getattr(dataset, "Rows", 0) or 0)
        columns = int(getattr(dataset, "Columns", 0) or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("Multi-frame DICOM CT has invalid frame or matrix metadata") from exc

    if modality != "CT":
        raise ValueError(
            f"Single-file RADAR DICOM input must use Modality=CT, got {modality or 'UNKNOWN'}"
        )
    if frame_count < 3:
        raise ValueError(
            "Single-file RADAR DICOM input must contain at least 3 frames; "
            "a standalone CT slice is not a 3D volume"
        )
    if rows <= 0 or columns <= 0:
        raise ValueError("Multi-frame DICOM CT has invalid Rows/Columns metadata")
    if not str(getattr(dataset, "SOPClassUID", "")).strip():
        raise ValueError("Multi-frame DICOM CT is missing SOPClassUID")

    return {
        "kind": "dicom-multiframe",
        "selected_cases": 1,
        "frame_count": frame_count,
        "matrix": [rows, columns],
    }


def _visible_regular_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if any(part.startswith(".") for part in relative.parts):
            continue
        if path.is_symlink() or not path.is_file():
            continue
        files.append(path)
        if len(files) > MAX_DISCOVERY_FILES:
            raise ValueError(
                f"Directory contains more than {MAX_DISCOVERY_FILES} files; "
                "pass a narrower CT series directory."
            )
    return sorted(files)


def _dicom_series_files(files: Iterable[Path], max_cases: int) -> tuple[list[Path], int]:
    try:
        import pydicom
    except ImportError as exc:
        raise ValueError("pydicom is required to validate a DICOM CT directory") from exc

    series: dict[str, list[Path]] = {}
    tags = ["Modality", "SeriesInstanceUID", "SOPClassUID"]
    for path in files:
        dataset = None
        try:
            dataset = pydicom.dcmread(
                str(path), stop_before_pixels=True, specific_tags=tags, force=False
            )
        except Exception:  # noqa: BLE001
            if path.suffix.lower() not in {".dcm", ".dicom", ".ima"}:
                continue
            try:
                dataset = pydicom.dcmread(
                    str(path), stop_before_pixels=True, specific_tags=tags, force=True
                )
            except Exception:  # noqa: BLE001
                continue
        modality = str(getattr(dataset, "Modality", "")).strip().upper()
        series_uid = str(getattr(dataset, "SeriesInstanceUID", "")).strip()
        sop_class_uid = str(getattr(dataset, "SOPClassUID", "")).strip()
        if modality != "CT" or not series_uid or not sop_class_uid:
            continue
        series.setdefault(series_uid, []).append(path)

    selected = sorted(series.values(), key=lambda group: (-len(group), str(group[0])))[:max_cases]
    return [path for group in selected for path in sorted(group)], len(selected)


def _directory_files(root: Path, max_cases: int) -> tuple[list[Path], Dict[str, Any]]:
    discovered = _visible_regular_files(root)
    nifti = [path for path in discovered if _is_nifti(path)]
    if nifti:
        selected = nifti[:max_cases]
        return selected, {"kind": "nifti", "selected_cases": len(selected)}
    selected, series_count = _dicom_series_files(discovered, max_cases)
    return selected, {"kind": "dicom", "selected_cases": series_count}


def _make_archive(root: Path, files: Iterable[Path], destination: Path) -> int:
    count = 0
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in files:
            archive.write(path, path.relative_to(root).as_posix())
            count += 1
    return count


def _error_payload(status: str, error: str, **extra: Any) -> Dict[str, Any]:
    return {
        "tool": "med_radar_analyze_ct",
        "ok": False,
        "status": status,
        "error": error,
        **extra,
    }


def _response_error(response: Any) -> str:
    try:
        payload = response.json()
        return str(payload.get("detail") or payload)
    except Exception:  # noqa: BLE001
        return (response.text or f"HTTP {response.status_code}")[-4000:]


def _artifact_download_url(api_base: str, artifact_url: str) -> str:
    parsed = urlsplit(artifact_url)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("RADAR returned a non-local artifact URL")
    if not re.fullmatch(r"/v1/artifacts/[0-9a-f]{32}/scores\.csv", parsed.path):
        raise ValueError("RADAR returned an invalid artifact path")
    target = urljoin(f"{api_base}/", parsed.path.lstrip("/"))
    base_parts = urlsplit(api_base)
    target_parts = urlsplit(target)
    if (target_parts.scheme, target_parts.netloc) != (base_parts.scheme, base_parts.netloc):
        raise ValueError("RADAR artifact URL is not same-origin")
    return target


def run_radar_analysis(
    *,
    path: str,
    top_k: int = 15,
    threshold: float = 0.5,
    max_cases: int = 4,
    study_context: str = "",
) -> Dict[str, Any]:
    """Upload a local study to node12 and persist its response artifacts on node36."""
    import httpx

    input_path = _resolve_input(path)
    if not input_path.exists():
        return _error_payload("error", f"Path does not exist: {input_path}")

    cfg = get_radar_config()

    top_k = max(1, min(int(top_k or 15), 50))
    threshold = max(0.0, min(float(threshold), 1.0))
    max_cases = max(1, min(int(max_cases or 4), 8))
    call_id = uuid.uuid4().hex
    upload_path: Optional[Path] = None
    selection: Dict[str, Any]
    try:
        if input_path.is_dir():
            files, selection = _directory_files(input_path, max_cases)
            if not files:
                return _error_payload(
                    "unsupported",
                    "No validated NIfTI volumes or DICOM CT series were found in the directory.",
                )
            total_bytes = sum(item.stat().st_size for item in files)
        else:
            files = [input_path]
            selection = (
                {"kind": "nifti", "selected_cases": 1}
                if _is_nifti(input_path)
                else _validate_multiframe_ct_file(input_path)
            )
            total_bytes = input_path.stat().st_size
    except (OSError, ValueError) as exc:
        return _error_payload("unsupported", str(exc))
    if total_bytes > cfg["max_upload_bytes"]:
        return _error_payload(
            "unsupported",
            f"Selected input is {total_bytes} bytes, above MED_RADAR_MAX_UPLOAD_BYTES={cfg['max_upload_bytes']}.",
        )

    output_dir = _output_dir_for(input_path, call_id)
    output_dir.mkdir(parents=True, exist_ok=False)
    succeeded = False
    try:
        if input_path.is_dir():
            upload_path = output_dir / "upload.zip"
            file_count = _make_archive(input_path, files, upload_path)
            upload_name = f"{input_path.name or 'study'}.zip"
            content_type = "application/zip"
        else:
            upload_path = input_path
            file_count = 1
            upload_name = input_path.name
            content_type = (
                "application/octet-stream"
                if _is_nifti(input_path)
                else "application/dicom"
            )

        timeout = httpx.Timeout(
            connect=10,
            read=cfg["timeout_seconds"],
            write=cfg["timeout_seconds"],
            pool=10,
        )
        verify = _tls_verification(cfg)
        with upload_path.open("rb") as handle, httpx.Client(
            timeout=timeout, verify=verify
        ) as client:
            response = client.post(
                f"{cfg['api_base']}/v1/analyze",
                headers=_headers(cfg),
                files={"file": (upload_name, handle, content_type)},
                data={
                    "top_k": str(top_k),
                    "threshold": str(threshold),
                    "max_cases": str(max_cases),
                    "study_context": study_context.strip(),
                },
            )
            if response.status_code >= 400:
                return _error_payload(
                    "remote_error",
                    _response_error(response),
                    http_status=response.status_code,
                    api_base=cfg["api_base"],
                )
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("RADAR returned a non-object JSON response")
            artifact_url = str(
                ((payload.get("artifacts") or {}).get("scores_csv_url")) or ""
            )
            if not artifact_url:
                raise ValueError("RADAR response did not include scores_csv_url")
            artifact_response = client.get(
                _artifact_download_url(cfg["api_base"], artifact_url),
                headers=_headers(cfg),
            )
            artifact_response.raise_for_status()
            local_csv = output_dir / "RADAR_infer_results_remote.csv"
            csv_temp = output_dir / ".scores.csv.tmp"
            csv_temp.write_bytes(artifact_response.content)
            csv_temp.replace(local_csv)
            succeeded = True
    except httpx.TimeoutException as exc:
        return _error_payload(
            "timeout",
            f"RADAR request exceeded {cfg['timeout_seconds']} seconds: {exc}",
            api_base=cfg["api_base"],
        )
    except (httpx.HTTPError, OSError, ValueError, json.JSONDecodeError) as exc:
        return _error_payload(
            "error",
            f"Remote RADAR request failed: {type(exc).__name__}: {exc}",
            api_base=cfg["api_base"],
        )
    finally:
        if input_path.is_dir() and upload_path is not None:
            upload_path.unlink(missing_ok=True)
        if not succeeded:
            shutil.rmtree(output_dir, ignore_errors=True)

    summary_path = output_dir / "radar_summary.json"
    payload["tool"] = "med_radar_analyze_ct"
    payload["generation_owner"] = "pilotdeck"
    payload["agent_continue"] = True
    payload["transfer"] = {
        "api_base": cfg["api_base"],
        "uploaded_file_count": file_count,
        "uploaded_bytes": total_bytes,
        **selection,
    }
    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, dict):
        artifacts = {}
        payload["artifacts"] = artifacts
    artifacts.update(
        {
            "scores_csv": str(local_csv),
            "summary_json": str(summary_path),
        }
    )
    payload["presentation"] = (
        "直接用简体中文回答用户原始问题，不要输出分析计划、完成状态、自我提示或类似 "
        "Let me / analysis completed 的过渡语。将结构化分数解释为未校准的模型信号，"
        "而非诊断或概率；说明域偏移和局限，引用本地产物，并建议放射科医师复核。"
        "不得仅因分数低而声称某项不存在。"
        "面向用户的过程说明和最终回答不主动展示服务器/节点名、IP、端口、GPU/CUDA、"
        "环境变量、内部目录或部署细节；remote、api_base、transfer 等字段仅供内部判断。"
        "结果文件使用简短中文链接名称，优先链接项目内相对路径，不展示服务器绝对路径。"
        "用户明确询问技术部署时才按需解释，不隐瞒使用远程分析服务的事实。"
    )
    summary_temp = output_dir / ".summary.json.tmp"
    summary_temp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    summary_temp.replace(summary_path)
    return payload
