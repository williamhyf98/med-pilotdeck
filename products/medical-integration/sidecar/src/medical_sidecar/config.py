"""Configuration with local-only network defaults and no LLM secret fields."""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import os
from pathlib import Path
import re
from typing import Any, Mapping
from urllib.parse import urlsplit


def require_loopback_host(host: str) -> str:
    """Return a normalized loopback host or raise.

    Hostnames other than ``localhost`` are intentionally rejected to avoid
    DNS rebinding at the bind boundary.
    """

    value = (host or "").strip().lower()
    if value == "localhost":
        return value
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise ValueError(f"host must be localhost or a loopback IP: {host!r}") from exc
    if not address.is_loopback:
        raise ValueError(f"non-loopback bind address is forbidden: {host!r}")
    return address.compressed


def _port(value: Any, field: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be an integer") from exc
    if not 1 <= parsed <= 65535:
        raise ValueError(f"{field} must be between 1 and 65535")
    return parsed


def _positive_int(value: Any, field: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be an integer") from exc
    if parsed <= 0:
        raise ValueError(f"{field} must be positive")
    return parsed


def _positive_float(value: Any, field: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a number") from exc
    if parsed <= 0:
        raise ValueError(f"{field} must be positive")
    return parsed


def _bool(value: Any, field: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    raise ValueError(f"{field} must be a boolean")


def _section(body: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    value = body.get(name, {})
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _string_tuple(value: Any, field: str) -> tuple[str, ...]:
    if isinstance(value, str):
        items = value.split(",")
    elif isinstance(value, (list, tuple)):
        items = value
    else:
        raise ValueError(f"{field} must be a list or comma-separated string")
    normalized = tuple(str(item).strip() for item in items if str(item).strip())
    if len(set(normalized)) != len(normalized):
        raise ValueError(f"{field} cannot contain duplicates")
    return normalized


def _relative_config_path(value: str, field: str) -> str:
    normalized = (value or "").strip().replace("\\", "/")
    if (
        not normalized
        or normalized.startswith("/")
        or re.match(r"^[A-Za-z]:", normalized)
        or any(part in {"", ".", ".."} for part in normalized.split("/"))
    ):
        raise ValueError(f"{field} must be a traversal-free relative path")
    return normalized


def _validate_local_service_endpoint(endpoint: str, field: str) -> None:
    parsed = urlsplit((endpoint or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"{field} must be an HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f"{field} cannot contain credentials, query, or fragment")
    if parsed.path not in {"", "/"}:
        raise ValueError(f"{field} must be an origin URL without a path")
    require_loopback_host(parsed.hostname)


@dataclass(frozen=True)
class EmbeddingSettings:
    enabled: bool = False
    endpoint: str | None = None
    allowed_hosts: tuple[str, ...] = ()
    timeout_seconds: float = 10.0
    max_response_bytes: int = 4 * 1024 * 1024

    def validate(self) -> None:
        if not self.enabled:
            return
        if not self.endpoint:
            raise ValueError("embedding.endpoint is required when embedding is enabled")
        if not self.allowed_hosts:
            raise ValueError("embedding.allowed_hosts cannot be empty when embedding is enabled")
        if self.timeout_seconds <= 0 or self.timeout_seconds > 120:
            raise ValueError("embedding.timeout_seconds must be within (0, 120]")
        if not 1024 <= self.max_response_bytes <= 64 * 1024 * 1024:
            raise ValueError("embedding.max_response_bytes is outside the safe range")

        # Import lazily so pure contract tests do not need any HTTP dependency.
        from .rag.embedding import validate_embedding_endpoint

        validate_embedding_endpoint(self.endpoint, self.allowed_hosts)


@dataclass(frozen=True)
class IngestionLimits:
    max_files: int = 32
    max_file_bytes: int = 50 * 1024 * 1024
    max_total_bytes: int = 200 * 1024 * 1024
    max_directory_depth: int = 8
    max_pages: int = 100
    max_frames: int = 64
    max_pixels: int = 100_000_000


@dataclass(frozen=True)
class RagLimits:
    default_top_k: int = 3
    max_top_k: int = 8
    default_min_score: float = 0.75
    max_corpus_bytes: int = 512 * 1024 * 1024
    max_embedding_bytes: int = 4 * 1024 * 1024 * 1024
    max_rows: int = 1_000_000
    max_dimension: int = 16_384
    corpus_id: str = "war-trauma"
    version: str = ""
    corpus_path: str | None = None
    embedding_path: str | None = None
    corpus_sha256: str = ""
    embedding_sha256: str = ""
    embedding_model: str = ""
    license_id: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.corpus_path or self.embedding_path)


@dataclass(frozen=True)
class DataSettings:
    """Trusted anchor for every configured local data path."""

    root: str | None = None


@dataclass(frozen=True)
class GalleryDatasetSettings:
    dataset_id: str
    path: str
    label: str = ""
    description: str = ""
    modality: str = ""
    version: str = ""
    license_id: str = ""
    report_names: tuple[str, ...] = ("report.txt", "report.md")


@dataclass(frozen=True)
class GallerySettings:
    enabled: bool = False
    root: str = "gallery"
    datasets: tuple[GalleryDatasetSettings, ...] = ()
    max_cases_per_dataset: int = 10_000
    max_slice_bytes: int = 50 * 1024 * 1024
    slice_extensions: tuple[str, ...] = (".png", ".jpg", ".jpeg", ".bmp", ".webp")

    @property
    def configured(self) -> bool:
        return self.enabled and bool(self.datasets)


@dataclass(frozen=True)
class VolumeStorageSettings:
    mode: str = "temporary"
    root: str = "volumes"
    default_ttl_seconds: int = 15 * 60
    max_ttl_seconds: int = 24 * 60 * 60
    max_items: int = 32
    max_stored_bytes: int = 1024 * 1024 * 1024
    persist_phi: bool = False

    @property
    def configured(self) -> bool:
        return self.mode in {"temporary", "filesystem"}


@dataclass(frozen=True)
class M3DSettings:
    enabled: bool = False
    endpoint: str = "http://127.0.0.1:8770"
    health_path: str = "/health"
    infer_path: str = "/v1/infer"
    timeout_seconds: float = 2.0
    max_response_bytes: int = 16 * 1024 * 1024


@dataclass(frozen=True)
class WorkflowLimits:
    max_sources: int = 32
    max_source_chars: int = 100_000
    max_total_chars: int = 500_000
    max_output_chars: int = 2_000_000


@dataclass(frozen=True)
class TableLimits:
    max_columns: int = 256
    max_rows: int = 10_000
    max_cell_chars: int = 32_768


@dataclass(frozen=True)
class ImagingLimits:
    max_volume_bytes: int = 512 * 1024 * 1024
    max_voxels: int = 512 * 1024 * 1024
    max_preview_slices: int = 64
    max_gallery_slices: int = 4096


@dataclass(frozen=True)
class SidecarSettings:
    api_host: str = "127.0.0.1"
    api_port: int = 8765
    mcp_enabled: bool = True
    mcp_host: str = "127.0.0.1"
    mcp_port: int = 8766
    mcp_path: str = "/mcp"
    embedding: EmbeddingSettings = EmbeddingSettings()
    data: DataSettings = DataSettings()
    ingestion: IngestionLimits = IngestionLimits()
    rag: RagLimits = RagLimits()
    table: TableLimits = TableLimits()
    imaging: ImagingLimits = ImagingLimits()
    gallery: GallerySettings = GallerySettings()
    volume_storage: VolumeStorageSettings = VolumeStorageSettings()
    m3d: M3DSettings = M3DSettings()
    workflows: WorkflowLimits = WorkflowLimits()

    def validate(self) -> "SidecarSettings":
        require_loopback_host(self.api_host)
        require_loopback_host(self.mcp_host)
        _port(self.api_port, "api.port")
        _port(self.mcp_port, "mcp.port")
        if not self.mcp_path.startswith("/") or ".." in self.mcp_path.split("/"):
            raise ValueError("mcp.path must be an absolute URL path without '..'")
        self.embedding.validate()
        for section_name, section in (
            ("ingestion", self.ingestion),
            ("table", self.table),
            ("imaging", self.imaging),
        ):
            for field_name, value in section.__dict__.items():
                if value <= 0:
                    raise ValueError(f"{section_name}.{field_name} must be positive")
        if self.rag.default_top_k <= 0 or self.rag.max_top_k <= 0:
            raise ValueError("rag top_k limits must be positive")
        for field_name in (
            "max_corpus_bytes",
            "max_embedding_bytes",
            "max_rows",
            "max_dimension",
        ):
            if getattr(self.rag, field_name) <= 0:
                raise ValueError(f"rag.{field_name} must be positive")
        if self.rag.default_top_k > self.rag.max_top_k:
            raise ValueError("rag.default_top_k cannot exceed rag.max_top_k")
        if not 0.0 <= self.rag.default_min_score <= 1.0:
            raise ValueError("rag.default_min_score must be between 0 and 1")
        if not self.rag.corpus_id:
            raise ValueError("rag.corpus_id cannot be empty")
        if self.rag.configured:
            required = {
                "version": self.rag.version,
                "corpus_path": self.rag.corpus_path,
                "embedding_path": self.rag.embedding_path,
                "corpus_sha256": self.rag.corpus_sha256,
                "embedding_sha256": self.rag.embedding_sha256,
                "embedding_model": self.rag.embedding_model,
                "license_id": self.rag.license_id,
            }
            missing = [name for name, value in required.items() if not value]
            if missing:
                raise ValueError("configured RAG is missing: " + ", ".join(missing))
            for name, digest in (
                ("corpus_sha256", self.rag.corpus_sha256),
                ("embedding_sha256", self.rag.embedding_sha256),
            ):
                if not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
                    raise ValueError(f"rag.{name} must be a SHA-256 hex digest")
        if self.data.root:
            data_root = Path(self.data.root).expanduser().resolve()
            for field, value in (
                ("rag.corpus_path", self.rag.corpus_path),
                ("rag.embedding_path", self.rag.embedding_path),
                ("gallery.root", self.gallery.root if self.gallery.enabled else None),
                (
                    "volume_storage.root",
                    self.volume_storage.root
                    if self.volume_storage.mode == "filesystem"
                    else None,
                ),
            ):
                if value:
                    relative = _relative_config_path(value, field)
                    candidate = data_root.joinpath(*relative.split("/")).resolve()
                    try:
                        candidate.relative_to(data_root)
                    except ValueError as exc:
                        raise ValueError(f"{field} escapes data.root") from exc
        elif self.rag.configured or self.gallery.enabled or self.volume_storage.mode == "filesystem":
            # Programmatic RagLimits with absolute fixture paths remain supported.
            # YAML-backed storage and Gallery configurations require a common root.
            if self.gallery.enabled or self.volume_storage.mode == "filesystem":
                raise ValueError("data.root is required for Gallery or filesystem Volume storage")
        if self.gallery.enabled:
            if not self.gallery.datasets:
                raise ValueError("gallery.datasets cannot be empty when Gallery is enabled")
            _relative_config_path(self.gallery.root, "gallery.root")
            ids: set[str] = set()
            for item in self.gallery.datasets:
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", item.dataset_id):
                    raise ValueError("gallery dataset id is invalid")
                if item.dataset_id in ids:
                    raise ValueError("gallery dataset ids must be unique")
                ids.add(item.dataset_id)
                _relative_config_path(item.path, f"gallery.datasets[{item.dataset_id}].path")
                if not item.version or not item.license_id:
                    raise ValueError("enabled Gallery datasets require version and license_id")
                for report_name in item.report_names:
                    _relative_config_path(report_name, "gallery.report_names")
            for extension in self.gallery.slice_extensions:
                if not re.fullmatch(r"\.[a-z0-9]{1,10}", extension):
                    raise ValueError("gallery.slice_extensions must be lowercase extensions")
        if self.volume_storage.mode not in {"disabled", "temporary", "filesystem"}:
            raise ValueError("volume_storage.mode must be disabled, temporary, or filesystem")
        if self.volume_storage.mode == "filesystem":
            _relative_config_path(self.volume_storage.root, "volume_storage.root")
            if not self.volume_storage.persist_phi:
                raise ValueError(
                    "filesystem Volume storage requires explicit volume_storage.persist_phi=true"
                )
        if self.volume_storage.default_ttl_seconds > self.volume_storage.max_ttl_seconds:
            raise ValueError("volume_storage.default_ttl_seconds cannot exceed max_ttl_seconds")
        if self.m3d.enabled:
            _validate_local_service_endpoint(self.m3d.endpoint, "m3d.endpoint")
        for field, path in (
            ("m3d.health_path", self.m3d.health_path),
            ("m3d.infer_path", self.m3d.infer_path),
        ):
            if not path.startswith("/") or ".." in path.split("/") or "?" in path or "#" in path:
                raise ValueError(f"{field} must be an absolute URL path without traversal")
        for section_name, section in (
            ("gallery", self.gallery),
            ("volume_storage", self.volume_storage),
            ("workflows", self.workflows),
        ):
            for field_name, value in section.__dict__.items():
                if isinstance(value, (int, float)) and not isinstance(value, bool) and value <= 0:
                    raise ValueError(f"{section_name}.{field_name} must be positive")
        if self.m3d.timeout_seconds <= 0 or self.m3d.timeout_seconds > 120:
            raise ValueError("m3d.timeout_seconds must be within (0, 120]")
        if not 1024 <= self.m3d.max_response_bytes <= 64 * 1024 * 1024:
            raise ValueError("m3d.max_response_bytes is outside the safe range")
        if self.ingestion.max_file_bytes > self.ingestion.max_total_bytes:
            raise ValueError("ingestion.max_file_bytes cannot exceed max_total_bytes")
        return self

    @classmethod
    def from_mapping(cls, body: Mapping[str, Any]) -> "SidecarSettings":
        api = _section(body, "api")
        mcp = _section(body, "mcp")
        embedding = _section(body, "embedding")
        data = _section(body, "data")
        ingestion = _section(body, "ingestion")
        rag = _section(body, "rag")
        table = _section(body, "table")
        imaging = _section(body, "imaging")
        gallery = _section(body, "gallery")
        volume_storage = _section(body, "volume_storage")
        m3d = _section(body, "m3d")
        workflows = _section(body, "workflows")
        allowed_hosts = _string_tuple(
            embedding.get("allowed_hosts", ()),
            "embedding.allowed_hosts",
        )
        raw_datasets = gallery.get("datasets", ())
        if not isinstance(raw_datasets, (list, tuple)):
            raise ValueError("gallery.datasets must be a list")
        datasets: list[GalleryDatasetSettings] = []
        for index, raw in enumerate(raw_datasets):
            if not isinstance(raw, Mapping):
                raise ValueError(f"gallery.datasets[{index}] must be an object")
            dataset_id = str(raw.get("id", raw.get("dataset_id", ""))).strip()
            datasets.append(
                GalleryDatasetSettings(
                    dataset_id=dataset_id,
                    path=str(raw.get("path", dataset_id)).strip(),
                    label=str(raw.get("label", "")).strip(),
                    description=str(raw.get("description", raw.get("desc", ""))).strip(),
                    modality=str(raw.get("modality", "")).strip(),
                    version=str(raw.get("version", "")).strip(),
                    license_id=str(raw.get("license_id", "")).strip(),
                    report_names=_string_tuple(
                        raw.get("report_names", ("report.txt", "report.md")),
                        f"gallery.datasets[{index}].report_names",
                    ),
                )
            )

        settings = cls(
            api_host=str(api.get("host", "127.0.0.1")),
            api_port=_port(api.get("port", 8765), "api.port"),
            mcp_enabled=_bool(mcp.get("enabled", True), "mcp.enabled"),
            mcp_host=str(mcp.get("host", "127.0.0.1")),
            mcp_port=_port(mcp.get("port", 8766), "mcp.port"),
            mcp_path=str(mcp.get("path", "/mcp")),
            embedding=EmbeddingSettings(
                enabled=_bool(embedding.get("enabled", False), "embedding.enabled"),
                endpoint=(
                    str(embedding["endpoint"]).strip()
                    if embedding.get("endpoint") not in (None, "")
                    else None
                ),
                allowed_hosts=allowed_hosts,
                timeout_seconds=float(embedding.get("timeout_seconds", 10)),
                max_response_bytes=int(embedding.get("max_response_bytes", 4 * 1024 * 1024)),
            ),
            data=DataSettings(
                root=(
                    str(data["root"]).strip()
                    if data.get("root") not in (None, "")
                    else None
                )
            ),
            ingestion=IngestionLimits(
                max_files=_positive_int(ingestion.get("max_files", 32), "ingestion.max_files"),
                max_file_bytes=_positive_int(
                    ingestion.get("max_file_bytes", 50 * 1024 * 1024),
                    "ingestion.max_file_bytes",
                ),
                max_total_bytes=_positive_int(
                    ingestion.get("max_total_bytes", 200 * 1024 * 1024),
                    "ingestion.max_total_bytes",
                ),
                max_directory_depth=_positive_int(
                    ingestion.get("max_directory_depth", 8),
                    "ingestion.max_directory_depth",
                ),
                max_pages=_positive_int(ingestion.get("max_pages", 100), "ingestion.max_pages"),
                max_frames=_positive_int(ingestion.get("max_frames", 64), "ingestion.max_frames"),
                max_pixels=_positive_int(
                    ingestion.get("max_pixels", 100_000_000),
                    "ingestion.max_pixels",
                ),
            ),
            rag=RagLimits(
                default_top_k=_positive_int(rag.get("default_top_k", 3), "rag.default_top_k"),
                max_top_k=_positive_int(rag.get("max_top_k", 8), "rag.max_top_k"),
                default_min_score=float(rag.get("default_min_score", 0.75)),
                max_corpus_bytes=_positive_int(
                    rag.get("max_corpus_bytes", 512 * 1024 * 1024),
                    "rag.max_corpus_bytes",
                ),
                max_embedding_bytes=_positive_int(
                    rag.get("max_embedding_bytes", 4 * 1024 * 1024 * 1024),
                    "rag.max_embedding_bytes",
                ),
                max_rows=_positive_int(rag.get("max_rows", 1_000_000), "rag.max_rows"),
                max_dimension=_positive_int(
                    rag.get("max_dimension", 16_384),
                    "rag.max_dimension",
                ),
                corpus_id=str(rag.get("corpus_id", "war-trauma")).strip(),
                version=str(rag.get("version", "")).strip(),
                corpus_path=(
                    str(rag["corpus_path"]).strip()
                    if rag.get("corpus_path") not in (None, "")
                    else None
                ),
                embedding_path=(
                    str(rag["embedding_path"]).strip()
                    if rag.get("embedding_path") not in (None, "")
                    else None
                ),
                corpus_sha256=str(rag.get("corpus_sha256", "")).strip().lower(),
                embedding_sha256=str(rag.get("embedding_sha256", "")).strip().lower(),
                embedding_model=str(rag.get("embedding_model", "")).strip(),
                license_id=str(rag.get("license_id", "")).strip(),
            ),
            table=TableLimits(
                max_columns=_positive_int(table.get("max_columns", 256), "table.max_columns"),
                max_rows=_positive_int(table.get("max_rows", 10_000), "table.max_rows"),
                max_cell_chars=_positive_int(
                    table.get("max_cell_chars", 32_768),
                    "table.max_cell_chars",
                ),
            ),
            imaging=ImagingLimits(
                max_volume_bytes=_positive_int(
                    imaging.get("max_volume_bytes", 512 * 1024 * 1024),
                    "imaging.max_volume_bytes",
                ),
                max_voxels=_positive_int(
                    imaging.get("max_voxels", 512 * 1024 * 1024),
                    "imaging.max_voxels",
                ),
                max_preview_slices=_positive_int(
                    imaging.get("max_preview_slices", 64),
                    "imaging.max_preview_slices",
                ),
                max_gallery_slices=_positive_int(
                    imaging.get("max_gallery_slices", 4096),
                    "imaging.max_gallery_slices",
                ),
            ),
            gallery=GallerySettings(
                enabled=_bool(gallery.get("enabled", False), "gallery.enabled"),
                root=str(gallery.get("root", "gallery")).strip(),
                datasets=tuple(datasets),
                max_cases_per_dataset=_positive_int(
                    gallery.get("max_cases_per_dataset", 10_000),
                    "gallery.max_cases_per_dataset",
                ),
                max_slice_bytes=_positive_int(
                    gallery.get("max_slice_bytes", 50 * 1024 * 1024),
                    "gallery.max_slice_bytes",
                ),
                slice_extensions=tuple(
                    item.lower()
                    for item in _string_tuple(
                        gallery.get(
                            "slice_extensions",
                            (".png", ".jpg", ".jpeg", ".bmp", ".webp"),
                        ),
                        "gallery.slice_extensions",
                    )
                ),
            ),
            volume_storage=VolumeStorageSettings(
                mode=str(volume_storage.get("mode", "temporary")).strip().lower(),
                root=str(volume_storage.get("root", "volumes")).strip(),
                default_ttl_seconds=_positive_int(
                    volume_storage.get("default_ttl_seconds", 15 * 60),
                    "volume_storage.default_ttl_seconds",
                ),
                max_ttl_seconds=_positive_int(
                    volume_storage.get("max_ttl_seconds", 24 * 60 * 60),
                    "volume_storage.max_ttl_seconds",
                ),
                max_items=_positive_int(
                    volume_storage.get("max_items", 32),
                    "volume_storage.max_items",
                ),
                max_stored_bytes=_positive_int(
                    volume_storage.get("max_stored_bytes", 1024 * 1024 * 1024),
                    "volume_storage.max_stored_bytes",
                ),
                persist_phi=_bool(
                    volume_storage.get("persist_phi", False),
                    "volume_storage.persist_phi",
                ),
            ),
            m3d=M3DSettings(
                enabled=_bool(m3d.get("enabled", False), "m3d.enabled"),
                endpoint=str(m3d.get("endpoint", "http://127.0.0.1:8770")).strip(),
                health_path=str(m3d.get("health_path", "/health")).strip(),
                infer_path=str(m3d.get("infer_path", "/v1/infer")).strip(),
                timeout_seconds=_positive_float(
                    m3d.get("timeout_seconds", 2),
                    "m3d.timeout_seconds",
                ),
                max_response_bytes=_positive_int(
                    m3d.get("max_response_bytes", 16 * 1024 * 1024),
                    "m3d.max_response_bytes",
                ),
            ),
            workflows=WorkflowLimits(
                max_sources=_positive_int(
                    workflows.get("max_sources", 32),
                    "workflows.max_sources",
                ),
                max_source_chars=_positive_int(
                    workflows.get("max_source_chars", 100_000),
                    "workflows.max_source_chars",
                ),
                max_total_chars=_positive_int(
                    workflows.get("max_total_chars", 500_000),
                    "workflows.max_total_chars",
                ),
                max_output_chars=_positive_int(
                    workflows.get("max_output_chars", 2_000_000),
                    "workflows.max_output_chars",
                ),
            ),
        )
        return settings.validate()

    @classmethod
    def load(
        cls,
        config_path: str | Path | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> "SidecarSettings":
        body: dict[str, Any] = {}
        if config_path:
            import yaml

            resolved_config = Path(config_path).expanduser().resolve(strict=True)
            loaded = yaml.safe_load(resolved_config.read_text(encoding="utf-8"))
            if loaded is not None and not isinstance(loaded, Mapping):
                raise ValueError("medical config root must be an object")
            body = dict(loaded or {})
            data = dict(_section(body, "data"))
            if data.get("root") not in (None, ""):
                root = Path(str(data["root"])).expanduser()
                if not root.is_absolute():
                    root = resolved_config.parent / root
                data["root"] = str(root.resolve())
                body["data"] = data

        env = dict(os.environ if environ is None else environ)
        api = dict(_section(body, "api"))
        mcp = dict(_section(body, "mcp"))
        embedding = dict(_section(body, "embedding"))
        rag = dict(_section(body, "rag"))
        data = dict(_section(body, "data"))
        gallery = dict(_section(body, "gallery"))
        volume_storage = dict(_section(body, "volume_storage"))
        m3d = dict(_section(body, "m3d"))

        env_overrides: tuple[tuple[str, dict[str, Any], str], ...] = (
            ("MEDICAL_API_HOST", api, "host"),
            ("MEDICAL_API_PORT", api, "port"),
            ("MEDICAL_MCP_ENABLED", mcp, "enabled"),
            ("MEDICAL_MCP_HOST", mcp, "host"),
            ("MEDICAL_MCP_PORT", mcp, "port"),
            ("MEDICAL_MCP_PATH", mcp, "path"),
            ("MEDICAL_EMBEDDING_ENABLED", embedding, "enabled"),
            ("MEDICAL_EMBEDDING_ENDPOINT", embedding, "endpoint"),
            ("MEDICAL_EMBEDDING_ALLOWLIST", embedding, "allowed_hosts"),
            ("MEDICAL_EMBEDDING_TIMEOUT_SECONDS", embedding, "timeout_seconds"),
            ("MEDICAL_EMBEDDING_MAX_RESPONSE_BYTES", embedding, "max_response_bytes"),
            ("MEDICAL_DATA_ROOT", data, "root"),
            ("MEDICAL_RAG_CORPUS_ID", rag, "corpus_id"),
            ("MEDICAL_RAG_VERSION", rag, "version"),
            ("MEDICAL_RAG_CORPUS_PATH", rag, "corpus_path"),
            ("MEDICAL_RAG_EMBEDDING_PATH", rag, "embedding_path"),
            ("MEDICAL_RAG_CORPUS_SHA256", rag, "corpus_sha256"),
            ("MEDICAL_RAG_EMBEDDING_SHA256", rag, "embedding_sha256"),
            ("MEDICAL_RAG_EMBEDDING_MODEL", rag, "embedding_model"),
            ("MEDICAL_RAG_LICENSE_ID", rag, "license_id"),
            ("MEDICAL_GALLERY_ENABLED", gallery, "enabled"),
            ("MEDICAL_GALLERY_ROOT", gallery, "root"),
            ("MEDICAL_VOLUME_STORAGE_MODE", volume_storage, "mode"),
            ("MEDICAL_VOLUME_STORAGE_ROOT", volume_storage, "root"),
            ("MEDICAL_VOLUME_PERSIST_PHI", volume_storage, "persist_phi"),
            ("MEDICAL_M3D_ENABLED", m3d, "enabled"),
            ("MEDICAL_M3D_ENDPOINT", m3d, "endpoint"),
            ("MEDICAL_M3D_TIMEOUT_SECONDS", m3d, "timeout_seconds"),
        )
        for env_name, target, key in env_overrides:
            if env_name in env and env[env_name] != "":
                target[key] = env[env_name]

        body.update(
            {
                "api": api,
                "mcp": mcp,
                "embedding": embedding,
                "data": data,
                "rag": rag,
                "gallery": gallery,
                "volume_storage": volume_storage,
                "m3d": m3d,
            }
        )
        return cls.from_mapping(body)

