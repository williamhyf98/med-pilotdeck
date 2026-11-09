from __future__ import annotations

import os
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, UnidentifiedImageError

from .common import DocxSkillError, pilotdeck_workspace_root


MAX_IMAGE_PIXELS = 80_000_000


def resolve_local_image(path_value: Any, *, base_dir: Path) -> Path:
    raw_value = str(path_value or "").strip()
    if not raw_value:
        raise DocxSkillError("Image path is required", code="invalid-image")
    if raw_value.startswith(("http://", "https://")):
        raise DocxSkillError(
            "Remote images are not allowed; use a local image path already in the workspace",
            code="remote-image-not-allowed",
        )
    raw_path = Path(raw_value).expanduser()
    candidate = Path(
        os.path.abspath(raw_path if raw_path.is_absolute() else base_dir / raw_path)
    )
    image_path = candidate
    if os.environ.get("PILOTDECK_WORKSPACE_DIR", "").strip() or os.environ.get(
        "PILOTDECK_WORKSPACE_CWD", ""
    ).strip():
        workspace_root = pilotdeck_workspace_root()
        try:
            relative = Path(os.path.realpath(candidate)).relative_to(workspace_root)
        except ValueError as exc:
            raise DocxSkillError(
                "Image must be inside the current task workspace",
                code="image-outside-workspace",
            ) from exc
        if not relative.parts or relative.parts[0] not in {"inbox", "scratch", "exports"}:
            raise DocxSkillError(
                "Image must be under inbox, scratch, or exports",
                code="image-outside-workspace",
            )
        cursor = workspace_root
        for part in Path(os.path.relpath(candidate, workspace_root)).parts:
            cursor /= part
            if cursor.is_symlink():
                raise DocxSkillError(
                    "Image cannot use a symbolic-link path",
                    code="image-symlink",
                )
        image_path = Path(os.path.realpath(candidate))
    else:
        image_path = candidate.resolve()
    if not image_path.is_file():
        raise DocxSkillError(
            f"Image not found: {image_path}",
            code="image-not-found",
        )
    return image_path


def normalized_image_stream(image_path: Path) -> tuple[BytesIO, dict[str, Any]]:
    """Decode an image, flatten transparency, and return a stable PNG stream."""
    try:
        with Image.open(image_path) as source:
            source.load()
            width, height = source.size
            if width < 1 or height < 1:
                raise DocxSkillError(
                    f"Image has invalid dimensions: {image_path}",
                    code="invalid-image",
                )
            if width * height > MAX_IMAGE_PIXELS:
                raise DocxSkillError(
                    f"Image is too large to embed safely: {width}x{height}",
                    code="image-too-large",
                    details={"path": str(image_path), "width": width, "height": height},
                )

            rgba = source.convert("RGBA")
            alpha = rgba.getchannel("A")
            if alpha.getbbox() is None:
                raise DocxSkillError(
                    f"Image is fully transparent: {image_path}",
                    code="blank-image",
                )

            white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            flattened = Image.alpha_composite(white, rgba).convert("RGB")
            background = Image.new("RGB", flattened.size, (255, 255, 255))
            if ImageChops.difference(flattened, background).getbbox() is None:
                raise DocxSkillError(
                    f"Image is visually blank after transparency is flattened: {image_path}",
                    code="blank-image",
                )

            stream = BytesIO()
            flattened.save(stream, format="PNG", optimize=True)
            stream.seek(0)
            return stream, {
                "path": str(image_path),
                "width_px": width,
                "height_px": height,
                "normalized_format": "PNG",
                "transparency_flattened": "A" in source.getbands()
                or "transparency" in source.info,
            }
    except DocxSkillError:
        raise
    except (
        Image.DecompressionBombError,
        UnidentifiedImageError,
        OSError,
        ValueError,
    ) as exc:
        raise DocxSkillError(
            f"Unable to decode image: {image_path}",
            code="invalid-image",
            details={"error": str(exc)},
        ) from exc
