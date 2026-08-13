"""Attachment formats, manifests, resource budgets, and safe path handling."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
import hashlib
from pathlib import Path, PurePosixPath
import re
from typing import Any, Iterable, Mapping


class AttachmentKind(StrEnum):
    TEXT = "text"
    STRUCTURED_TEXT = "structured_text"
    PDF = "pdf"
    IMAGE = "image"
    DICOM = "dicom"
    ECG = "ecg"
    WFDB = "wfdb"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class AttachmentFormat:
    subtype: str
    kind: AttachmentKind
    extensions: tuple[str, ...]
    media_types: tuple[str, ...]
    parser_extra: str | None = None
    preview_kind: str | None = None

    def to_dict(self) -> dict[str, Any]:
        body = asdict(self)
        body["kind"] = self.kind.value
        return body


FORMATS: tuple[AttachmentFormat, ...] = (
    AttachmentFormat("text", AttachmentKind.TEXT, (".txt",), ("text/plain",)),
    AttachmentFormat("markdown", AttachmentKind.TEXT, (".md", ".markdown"), ("text/markdown",)),
    AttachmentFormat("json", AttachmentKind.STRUCTURED_TEXT, (".json",), ("application/json",)),
    AttachmentFormat(
        "xml",
        AttachmentKind.STRUCTURED_TEXT,
        (".xml",),
        ("application/xml", "text/xml"),
    ),
    AttachmentFormat(
        "cda",
        AttachmentKind.STRUCTURED_TEXT,
        (".cda",),
        ("application/cda+xml",),
    ),
    AttachmentFormat("pdf", AttachmentKind.PDF, (".pdf",), ("application/pdf",), "formats", "image"),
    AttachmentFormat("png", AttachmentKind.IMAGE, (".png",), ("image/png",), "formats", "image"),
    AttachmentFormat(
        "jpeg",
        AttachmentKind.IMAGE,
        (".jpg", ".jpeg"),
        ("image/jpeg",),
        "formats",
        "image",
    ),
    AttachmentFormat("bmp", AttachmentKind.IMAGE, (".bmp",), ("image/bmp",), "formats", "image"),
    AttachmentFormat(
        "dicom",
        AttachmentKind.DICOM,
        (".dcm", ".dicom"),
        ("application/dicom",),
        "formats",
        "image",
    ),
    AttachmentFormat(
        "aecg_xml",
        AttachmentKind.ECG,
        (".aecg",),
        ("application/aecg+xml",),
        "formats",
        "image",
    ),
    AttachmentFormat(
        "wfdb_header",
        AttachmentKind.WFDB,
        (".hea",),
        ("application/x-wfdb-header",),
        "formats",
        "image",
    ),
    AttachmentFormat(
        "wfdb_signal",
        AttachmentKind.WFDB,
        (".dat",),
        ("application/x-wfdb-signal",),
        "formats",
        "image",
    ),
)

UNKNOWN_FORMAT = AttachmentFormat("unknown", AttachmentKind.UNKNOWN, (), ())


def detect_format(filename: str, media_type: str | None = None) -> AttachmentFormat:
    """Detect a registered format without sniffing untrusted bytes."""

    lowered = (filename or "").strip().lower()
    # Compound and specific extensions must win over a generic XML media type.
    if lowered.endswith(".aecg.xml"):
        return next(item for item in FORMATS if item.subtype == "aecg_xml")
    if lowered.endswith(".cda.xml"):
        return next(item for item in FORMATS if item.subtype == "cda")

    normalized_media = (media_type or "").split(";", 1)[0].strip().lower()
    if normalized_media:
        for item in FORMATS:
            if normalized_media in item.media_types:
                return item

    for item in FORMATS:
        if any(lowered.endswith(ext) for ext in item.extensions):
            return item
    return UNKNOWN_FORMAT


def safe_relative_path(value: str, *, max_depth: int = 8) -> PurePosixPath:
    """Validate an upload-relative POSIX path.

    Absolute paths, Windows separators, drive prefixes, empty segments and
    traversal are rejected rather than silently normalized.
    """

    raw = (value or "").strip()
    if not raw or "\x00" in raw or "\\" in raw:
        raise ValueError("relative path is empty or contains a forbidden character")
    if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        raise ValueError("absolute paths are forbidden")
    parts = raw.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("relative path contains an empty or traversal segment")
    if len(parts) > max_depth:
        raise ValueError(f"relative path exceeds maximum depth {max_depth}")
    return PurePosixPath(*parts)


def safe_filename(value: str) -> str:
    filename = (value or "").strip()
    if (
        not filename
        or filename in {".", ".."}
        or "\x00" in filename
        or "/" in filename
        or "\\" in filename
    ):
        raise ValueError("filename must be a non-empty basename")
    return filename


def resolve_under_root(
    root: str | Path,
    relative_path: str,
    *,
    must_exist: bool = False,
    allow_root: bool = False,
) -> Path:
    """Resolve a relative path while blocking traversal and symlink escape."""

    relative = safe_relative_path(relative_path)
    root_path = Path(root).resolve(strict=must_exist)
    candidate = root_path.joinpath(*relative.parts).resolve(strict=must_exist)
    try:
        candidate.relative_to(root_path)
    except ValueError as exc:
        raise ValueError("resolved path escapes the configured root") from exc
    if not allow_root and candidate == root_path:
        raise ValueError("resolved path cannot be the storage root")
    return candidate


def validated_derived_refs(values: Any) -> tuple[list[str], int]:
    """Keep unique ``derived/...`` references and count rejected values."""

    if not isinstance(values, (list, tuple)):
        return [], 1 if values else 0
    accepted: list[str] = []
    rejected = 0
    for value in values:
        if not isinstance(value, str):
            rejected += 1
            continue
        try:
            path = safe_relative_path(value)
        except ValueError:
            rejected += 1
            continue
        normalized = path.as_posix()
        if not path.parts or path.parts[0] != "derived":
            rejected += 1
            continue
        if normalized not in accepted:
            accepted.append(normalized)
    return accepted, rejected


@dataclass(frozen=True)
class AttachmentDescriptor:
    filename: str
    relative_path: str
    kind: str
    subtype: str
    media_type: str
    byte_size: int
    sha256: str

    @classmethod
    def from_bytes(
        cls,
        *,
        filename: str,
        relative_path: str,
        data: bytes,
        media_type: str | None = None,
    ) -> "AttachmentDescriptor":
        safe_relative_path(relative_path)
        fmt = detect_format(filename, media_type)
        return cls(
            filename=safe_filename(filename),
            relative_path=relative_path,
            kind=fmt.kind.value,
            subtype=fmt.subtype,
            media_type=(media_type or (fmt.media_types[0] if fmt.media_types else "application/octet-stream")),
            byte_size=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
        )


@dataclass
class Artifact:
    artifact_id: str
    filename: str
    relative_path: str
    kind: str
    subtype: str
    status: str
    included: bool
    byte_size: int
    sha256: str
    summary: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    preview_kind: str | None = None
    preview_ref: str | None = None
    model_image_refs: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        safe_filename(self.filename)
        safe_relative_path(self.relative_path)
        if self.byte_size < 0:
            raise ValueError("artifact.byte_size cannot be negative")
        if self.sha256 and not re.fullmatch(r"[0-9a-fA-F]{64}", self.sha256):
            raise ValueError("artifact.sha256 must be a 64-character hex digest")
        self.warnings = [str(item) for item in self.warnings]
        self.model_image_refs, rejected = validated_derived_refs(self.model_image_refs)
        if rejected:
            self.warnings.append(f"ignored {rejected} invalid derived image reference(s)")
        if self.preview_ref:
            refs, preview_rejected = validated_derived_refs([self.preview_ref])
            if preview_rejected:
                self.preview_ref = None
                self.preview_kind = None
                self.warnings.append("ignored invalid preview reference")
            else:
                self.preview_ref = refs[0]

    def preview_frame_count(self) -> int:
        if self.preview_kind != "image" or not self.preview_ref:
            return 0
        if self.model_image_refs:
            return len(self.model_image_refs)
        for key in ("rendered_preview_pages", "selected_frames"):
            value = self.metadata.get(key)
            if isinstance(value, int) and value > 0:
                return value
        return 1

    def to_public_dict(self, batch_id: str) -> dict[str, Any]:
        preview_url = (
            f"/attachments/{batch_id}/preview/{self.artifact_id}"
            if self.preview_kind and self.preview_ref
            else None
        )
        return {
            "artifact_id": self.artifact_id,
            "filename": self.filename,
            "relative_path": self.relative_path,
            "kind": self.kind,
            "subtype": self.subtype,
            "status": self.status,
            "included": self.included,
            "byte_size": self.byte_size,
            "sha256": self.sha256.lower(),
            "summary": self.summary,
            "metadata": _public_metadata(self.metadata),
            "warnings": list(self.warnings),
            "preview_kind": self.preview_kind,
            "preview_url": preview_url,
            "model_image_count": len(self.model_image_refs),
            "preview_frame_count": self.preview_frame_count(),
        }

    def to_manifest_dict(self, batch_id: str) -> dict[str, Any]:
        body = self.to_public_dict(batch_id)
        body["_preview"] = {"kind": self.preview_kind, "ref": self.preview_ref}
        body["_model_image_refs"] = list(self.model_image_refs)
        return body

    @classmethod
    def from_manifest_dict(cls, body: Mapping[str, Any]) -> "Artifact":
        preview = body.get("_preview")
        preview_body = preview if isinstance(preview, Mapping) else {}
        raw_refs = body.get("_model_image_refs")
        refs = list(raw_refs) if isinstance(raw_refs, (list, tuple)) else []
        raw_metadata = body.get("metadata")
        return cls(
            artifact_id=str(body.get("artifact_id") or ""),
            filename=str(body.get("filename") or ""),
            relative_path=str(body.get("relative_path") or ""),
            kind=str(body.get("kind") or "unknown"),
            subtype=str(body.get("subtype") or "unknown"),
            status=str(body.get("status") or "failed"),
            included=bool(body.get("included")),
            byte_size=int(body.get("byte_size") or 0),
            sha256=str(body.get("sha256") or ""),
            summary=str(body.get("summary") or ""),
            metadata=dict(raw_metadata) if isinstance(raw_metadata, Mapping) else {},
            warnings=[str(item) for item in (body.get("warnings") or [])],
            preview_kind=(
                str(preview_body["kind"]) if preview_body.get("kind") is not None else None
            ),
            preview_ref=(
                str(preview_body["ref"]) if preview_body.get("ref") is not None else None
            ),
            model_image_refs=refs,
        )


@dataclass
class BatchManifest:
    batch_id: str
    created_at: str
    artifacts: list[Artifact]
    summary_text: str = ""
    warnings: list[str] = field(default_factory=list)
    schema_version: int = 2

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "batch_id": self.batch_id,
            "artifacts": [item.to_public_dict(self.batch_id) for item in self.artifacts],
            "summary_text": self.summary_text,
            "warnings": list(self.warnings),
        }

    def to_manifest_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "batch_id": self.batch_id,
            "created_at": self.created_at,
            "artifacts": [item.to_manifest_dict(self.batch_id) for item in self.artifacts],
            "summary_text": self.summary_text,
            "warnings": list(self.warnings),
        }

    @classmethod
    def from_manifest_dict(cls, body: Mapping[str, Any]) -> "BatchManifest":
        raw_artifacts = body.get("artifacts")
        if not isinstance(raw_artifacts, list):
            raise ValueError("manifest.artifacts must be an array")
        return cls(
            batch_id=str(body.get("batch_id") or ""),
            created_at=str(body.get("created_at") or ""),
            artifacts=[
                Artifact.from_manifest_dict(item)
                for item in raw_artifacts
                if isinstance(item, Mapping)
            ],
            summary_text=str(body.get("summary_text") or ""),
            warnings=[str(item) for item in (body.get("warnings") or [])],
            schema_version=int(body.get("schema_version") or 1),
        )


@dataclass(frozen=True)
class IngestionBudget:
    max_files: int = 32
    max_file_bytes: int = 50 * 1024 * 1024
    max_total_bytes: int = 200 * 1024 * 1024
    max_directory_depth: int = 8
    max_pages: int = 100
    max_frames: int = 64
    max_pixels: int = 100_000_000

    def validate(self, artifacts: Iterable[Artifact]) -> None:
        items = list(artifacts)
        if len(items) > self.max_files:
            raise ValueError(f"attachment count exceeds {self.max_files}")
        total = 0
        for item in items:
            safe_relative_path(item.relative_path, max_depth=self.max_directory_depth)
            if item.byte_size > self.max_file_bytes:
                raise ValueError(f"artifact {item.artifact_id!r} exceeds per-file budget")
            total += item.byte_size
            _bounded_metadata_int(item.metadata, "page_count", self.max_pages)
            _bounded_metadata_int(item.metadata, "frame_count", self.max_frames)
            _bounded_metadata_int(item.metadata, "pixel_count", self.max_pixels)
        if total > self.max_total_bytes:
            raise ValueError(f"attachment batch exceeds {self.max_total_bytes} bytes")


def _bounded_metadata_int(metadata: Mapping[str, Any], key: str, maximum: int) -> None:
    value = metadata.get(key)
    if value is None:
        return
    if not isinstance(value, int) or value < 0:
        raise ValueError(f"metadata.{key} must be a non-negative integer")
    if value > maximum:
        raise ValueError(f"metadata.{key} exceeds {maximum}")


def _public_metadata(value: Any, *, key: str = "") -> Any:
    """Remove internal path-bearing metadata before public serialization."""

    normalized_key = key.lower()
    if normalized_key == "path" or normalized_key.endswith("_path"):
        return None
    if isinstance(value, Path):
        return None
    if isinstance(value, str) and (value.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", value)):
        return None
    if isinstance(value, Mapping):
        output: dict[str, Any] = {}
        for child_key, child_value in value.items():
            public = _public_metadata(child_value, key=str(child_key))
            if public is not None:
                output[str(child_key)] = public
        return output
    if isinstance(value, (list, tuple)):
        return [
            public
            for item in value
            if (public := _public_metadata(item, key=key)) is not None
        ]
    return value

