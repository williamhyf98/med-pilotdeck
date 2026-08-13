"""TTL-bound Volume storage with in-memory default and explicit PHI persistence."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import threading
from typing import Any, Callable

from ..config import ImagingLimits, VolumeStorageSettings
from ..ingestion.contracts import resolve_under_root, safe_filename
from .contracts import VolumeMetadata, validate_identifier
from .volume import VolumeLimits, prepare_volume, render_volume_slice


class VolumeUnavailableError(RuntimeError):
    pass


class VolumeNotFoundError(LookupError):
    pass


Clock = Callable[[], datetime]


@dataclass
class _VolumeRecord:
    volume_id: str
    filename: str
    metadata: dict[str, Any]
    created_at: datetime
    expires_at: datetime
    raw: bytes | None = None
    raw_path: Path | None = None
    manifest_path: Path | None = None

    @property
    def byte_size(self) -> int:
        return int(self.metadata.get("byte_size", 0))


class VolumeStore:
    def __init__(
        self,
        settings: VolumeStorageSettings,
        limits: ImagingLimits,
        *,
        data_root: str | None,
        clock: Clock | None = None,
    ) -> None:
        self.settings = settings
        self.limits = limits
        self.data_root = data_root
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._records: dict[str, _VolumeRecord] = {}
        self._lock = threading.RLock()
        self._root: Path | None = None
        if settings.mode == "filesystem":
            if not data_root:
                raise VolumeUnavailableError("filesystem Volume storage requires data.root")
            trusted_root = Path(data_root).expanduser().resolve(strict=True)
            if not trusted_root.is_dir():
                raise VolumeUnavailableError("data.root is not a directory")
            self._root = resolve_under_root(
                trusted_root,
                settings.root,
                must_exist=False,
            )
            self._root.mkdir(parents=True, exist_ok=True)
            self._root = self._root.resolve(strict=True)
            self._load_manifests()

    def status(self) -> dict[str, Any]:
        with self._lock:
            self._purge_expired()
            return {
                "status": "ready" if self.settings.configured else "unavailable",
                "available": self.settings.configured,
                "mode": self.settings.mode,
                "reason": None if self.settings.configured else "feature_disabled",
                "items": len(self._records),
                "stored_bytes": sum(record.byte_size for record in self._records.values()),
                "default_ttl_seconds": self.settings.default_ttl_seconds,
                "max_ttl_seconds": self.settings.max_ttl_seconds,
                "phi_persisted": self.settings.mode == "filesystem",
                "storage_paths_exposed": False,
            }

    def upload(
        self,
        data: bytes,
        *,
        filename: str,
        requested_slices: int = 8,
        ttl_seconds: int | None = None,
    ) -> dict[str, Any]:
        if not self.settings.configured:
            raise VolumeUnavailableError("Volume storage is disabled by configuration")
        safe_name = safe_filename(filename)
        ttl = (
            self.settings.default_ttl_seconds
            if ttl_seconds is None
            else int(ttl_seconds)
        )
        if not 1 <= ttl <= self.settings.max_ttl_seconds:
            raise ValueError(
                f"ttl_seconds must be between 1 and {self.settings.max_ttl_seconds}"
            )
        prepared = prepare_volume(
            data,
            filename=safe_name,
            limits=self._volume_limits(),
            requested_slices=requested_slices,
        )
        if prepared.get("status") != "ready":
            raise VolumeUnavailableError(str(prepared.get("reason") or "volume_unavailable"))

        metadata = dict(prepared["volume"])
        volume_id = validate_identifier(str(metadata["volume_id"]), "volume_id")
        now = self._normalized_now()
        record = _VolumeRecord(
            volume_id=volume_id,
            filename=safe_name,
            metadata=metadata,
            created_at=now,
            expires_at=now + timedelta(seconds=ttl),
        )
        with self._lock:
            self._purge_expired()
            previous = self._records.get(volume_id)
            prospective_items = len(self._records) + (0 if previous else 1)
            prospective_bytes = (
                sum(item.byte_size for item in self._records.values())
                - (previous.byte_size if previous else 0)
                + len(data)
            )
            if prospective_items > self.settings.max_items:
                raise ValueError("Volume store item count exceeds the configured budget")
            if prospective_bytes > self.settings.max_stored_bytes:
                raise ValueError("Volume store byte size exceeds the configured budget")
            if previous:
                self._delete_files(previous)
            if self.settings.mode == "temporary":
                record.raw = bytes(data)
            else:
                self._persist_record(record, data)
            self._records[volume_id] = record

        return {
            **prepared,
            "storage": self.settings.mode,
            "retention": {
                "temporary": self.settings.mode == "temporary",
                "phi_persisted": self.settings.mode == "filesystem",
                "expires_at": _iso(record.expires_at),
                "ttl_seconds": ttl,
            },
        }

    def list(self) -> dict[str, Any]:
        with self._lock:
            self._purge_expired()
            records = sorted(
                self._records.values(),
                key=lambda item: (item.created_at, item.volume_id),
                reverse=True,
            )
            return {
                "status": "ready" if self.settings.configured else "unavailable",
                "volumes": [self._public_record(item) for item in records],
                "storage": self.settings.mode,
                "storage_paths_exposed": False,
            }

    def get(self, volume_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._record(volume_id)
            return {
                "status": "ready",
                "volume": self._public_record(record),
                "storage_paths_exposed": False,
            }

    def slice(self, volume_id: str, index: int) -> dict[str, Any]:
        with self._lock:
            record = self._record(volume_id)
            raw = self._read_raw(record)
            filename = record.filename
        result = render_volume_slice(
            raw,
            filename=filename,
            index=int(index),
            limits=self._volume_limits(),
        )
        if result.get("status") != "ready":
            raise VolumeUnavailableError(str(result.get("reason") or "volume_unavailable"))
        return {
            **result,
            "volume_id": record.volume_id,
            "storage": self.settings.mode,
        }

    def delete(self, volume_id: str) -> dict[str, Any]:
        normalized = validate_identifier(volume_id, "volume_id")
        with self._lock:
            self._purge_expired()
            record = self._records.pop(normalized, None)
            if record is None:
                raise VolumeNotFoundError("unknown or expired Volume")
            self._delete_files(record)
        return {
            "status": "deleted",
            "volume_id": normalized,
            "storage": self.settings.mode,
        }

    def _record(self, volume_id: str) -> _VolumeRecord:
        normalized = validate_identifier(volume_id, "volume_id")
        self._purge_expired()
        record = self._records.get(normalized)
        if record is None:
            raise VolumeNotFoundError("unknown or expired Volume")
        return record

    def _public_record(self, record: _VolumeRecord) -> dict[str, Any]:
        return {
            **record.metadata,
            "created_at": _iso(record.created_at),
            "expires_at": _iso(record.expires_at),
            "storage": self.settings.mode,
            "temporary": self.settings.mode == "temporary",
            "phi_persisted": self.settings.mode == "filesystem",
        }

    def _volume_limits(self) -> VolumeLimits:
        return VolumeLimits(
            max_volume_bytes=self.limits.max_volume_bytes,
            max_voxels=self.limits.max_voxels,
            max_preview_slices=self.limits.max_preview_slices,
        )

    def _normalized_now(self) -> datetime:
        value = self._clock()
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def _purge_expired(self) -> None:
        now = self._normalized_now()
        expired = [
            volume_id
            for volume_id, record in self._records.items()
            if record.expires_at <= now
        ]
        for volume_id in expired:
            record = self._records.pop(volume_id)
            self._delete_files(record)

    def _persist_record(self, record: _VolumeRecord, data: bytes) -> None:
        assert self._root is not None
        extension = str(record.metadata["extension"])
        raw_path = self._root / f"{record.volume_id}{extension}"
        manifest_path = self._root / f"{record.volume_id}.json"
        raw_temp = self._root / f".{record.volume_id}.raw.tmp"
        manifest_temp = self._root / f".{record.volume_id}.json.tmp"
        raw_temp.write_bytes(data)
        manifest = {
            "schema_version": 1,
            "volume_id": record.volume_id,
            "filename": record.filename,
            "metadata": record.metadata,
            "created_at": _iso(record.created_at),
            "expires_at": _iso(record.expires_at),
            "raw_file": raw_path.name,
        }
        manifest_temp.write_text(
            json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        raw_temp.replace(raw_path)
        manifest_temp.replace(manifest_path)
        record.raw_path = raw_path
        record.manifest_path = manifest_path

    def _load_manifests(self) -> None:
        assert self._root is not None
        for path in sorted(self._root.glob("vol-*.json")):
            if path.is_symlink() or not path.is_file():
                continue
            try:
                body = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(body, dict) or body.get("schema_version") != 1:
                    continue
                volume_id = validate_identifier(str(body["volume_id"]), "volume_id")
                filename = safe_filename(str(body["filename"]))
                metadata = body["metadata"]
                if not isinstance(metadata, dict):
                    continue
                validated = (
                    VolumeMetadata.from_mapping(metadata)
                    .validate(
                        max_volume_bytes=self.limits.max_volume_bytes,
                        max_voxels=self.limits.max_voxels,
                        max_preview_slices=self.limits.max_preview_slices,
                    )
                    .to_dict()
                )
                if validated["volume_id"] != volume_id or validated["filename"] != filename:
                    continue
                raw_name = safe_filename(str(body["raw_file"]))
                raw_path = resolve_under_root(self._root, raw_name, must_exist=True)
                record = _VolumeRecord(
                    volume_id=volume_id,
                    filename=filename,
                    metadata=validated,
                    created_at=_parse_time(str(body["created_at"])),
                    expires_at=_parse_time(str(body["expires_at"])),
                    raw_path=raw_path,
                    manifest_path=path.resolve(strict=True),
                )
                if raw_path.stat().st_size != record.byte_size:
                    continue
                self._records[volume_id] = record
            except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
                continue
        self._purge_expired()

    def _read_raw(self, record: _VolumeRecord) -> bytes:
        if record.raw is not None:
            return record.raw
        if record.raw_path is None:
            raise VolumeUnavailableError("Volume bytes are unavailable")
        try:
            resolved = resolve_under_root(
                self._root or "",
                record.raw_path.name,
                must_exist=True,
            )
            raw = resolved.read_bytes()
        except (OSError, ValueError) as exc:
            raise VolumeUnavailableError("stored Volume is unreadable") from exc
        if len(raw) != record.byte_size:
            raise VolumeUnavailableError("stored Volume byte size no longer matches metadata")
        return raw

    @staticmethod
    def _delete_files(record: _VolumeRecord) -> None:
        for path in (record.raw_path, record.manifest_path):
            if path is not None:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("stored timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)
