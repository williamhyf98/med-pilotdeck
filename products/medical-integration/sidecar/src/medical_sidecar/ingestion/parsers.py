"""In-memory medical attachment parsers with explicit degraded outcomes."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from io import BytesIO
import json
import math
from pathlib import Path
import re
import tempfile
from typing import Any, Mapping
import xml.etree.ElementTree as ElementTree

from .contracts import AttachmentFormat, detect_format


@dataclass(frozen=True)
class ParserLimits:
    max_text_chars: int = 6_000
    max_preview_text_chars: int = 50_000
    max_structured_bytes: int = 16 * 1024 * 1024
    max_pages: int = 100
    max_frames: int = 64
    max_pixels: int = 100_000_000
    max_image_long_side: int = 1600
    max_preview_bytes: int = 4 * 1024 * 1024


@dataclass
class ParseOutcome:
    kind: str
    subtype: str
    status: str
    summary: str
    metadata: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    included: bool = True
    previews: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "subtype": self.subtype,
            "status": self.status,
            "summary": self.summary,
            "metadata": self.metadata,
            "warnings": self.warnings,
            "included": self.included,
            "preview_kind": self.previews[0]["kind"] if self.previews else None,
            "previews": self.previews,
            "preview_frame_count": len(self.previews),
        }


def parse_attachment(
    data: bytes,
    *,
    filename: str,
    media_type: str = "",
    companions: Mapping[str, bytes] | None = None,
    limits: ParserLimits = ParserLimits(),
) -> ParseOutcome:
    fmt = detect_format(filename, media_type)
    lowered = filename.lower()
    if (
        fmt.kind.value in {"text", "structured_text"}
        or fmt.subtype == "aecg_xml"
    ) and len(data) > limits.max_structured_bytes:
        return ParseOutcome(
            kind=fmt.kind.value,
            subtype=fmt.subtype,
            status="degraded",
            included=False,
            summary="文本或结构化文档超过解析内存预算，未解码。",
            warnings=["structured_document_byte_budget_exceeded"],
        )
    if fmt.subtype in {"text", "markdown"}:
        return _parse_text(data, fmt, limits)
    if fmt.subtype == "json":
        return _parse_json(data, limits)
    if fmt.subtype in {"xml", "cda", "aecg_xml"} or lowered.endswith((".xml", ".cda")):
        return _parse_xml(data, filename, limits)
    if fmt.subtype == "pdf":
        return _parse_pdf(data, limits)
    if fmt.kind.value == "image":
        return _parse_image(data, fmt, limits)
    if fmt.subtype == "dicom":
        return _parse_dicom(data, limits)
    if fmt.kind.value == "wfdb":
        return _parse_wfdb(data, filename, companions or {}, limits)
    return ParseOutcome(
        kind=fmt.kind.value,
        subtype=fmt.subtype,
        status="degraded",
        included=False,
        summary=f"附件格式 {fmt.subtype} 当前没有可用解析器。",
        warnings=["format_not_supported"],
    )


def _parse_text(data: bytes, fmt: AttachmentFormat, limits: ParserLimits) -> ParseOutcome:
    text, encoding = _decode_text(data)
    cleaned = _clean_text(text)
    subtype = "markdown" if fmt.subtype == "markdown" else "plain_text"
    return ParseOutcome(
        kind="document",
        subtype=subtype,
        status="ready",
        summary=f"{'Markdown' if subtype == 'markdown' else '文本'}文档（{len(cleaned)} 字符）\n"
        f"{_cap(cleaned, limits.max_text_chars)}",
        metadata={"encoding": encoding, "character_count": len(cleaned)},
        previews=[_text_preview(cleaned, limits)],
    )


def _parse_json(data: bytes, limits: ParserLimits) -> ParseOutcome:
    raw, encoding = _decode_text(data)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        cleaned = _clean_text(raw)
        return ParseOutcome(
            kind="document",
            subtype="json_invalid",
            status="degraded",
            summary=f"JSON 解析失败，按文本降级读取\n{_cap(cleaned, limits.max_text_chars)}",
            metadata={"encoding": encoding, "character_count": len(cleaned)},
            warnings=[f"JSON 语法错误：{exc.msg}（第 {exc.lineno} 行）"],
            previews=[_text_preview(cleaned, limits)],
        )
    rendered = json.dumps(parsed, ensure_ascii=False, indent=2)
    metadata: dict[str, Any] = {
        "encoding": encoding,
        "top_level_type": type(parsed).__name__,
        "character_count": len(rendered),
    }
    if isinstance(parsed, dict):
        metadata["item_count"] = len(parsed)
        metadata["top_level_keys"] = [str(key)[:200] for key in list(parsed)[:50]]
    elif isinstance(parsed, list):
        metadata["item_count"] = len(parsed)
    return ParseOutcome(
        kind="document",
        subtype="json",
        status="ready",
        summary=f"JSON 文档（{metadata.get('item_count', 1)} 项）\n"
        f"{_cap(rendered, limits.max_text_chars)}",
        metadata=metadata,
        previews=[_text_preview(rendered, limits)],
    )


def _parse_xml(data: bytes, filename: str, limits: ParserLimits) -> ParseOutcome:
    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", data, flags=re.IGNORECASE):
        return ParseOutcome(
            kind="document",
            subtype="xml_blocked",
            status="degraded",
            included=False,
            summary="XML 包含被禁止的 DTD 或实体声明，未解析。",
            warnings=["xml_dtd_or_entity_forbidden"],
        )
    try:
        root = ElementTree.fromstring(data)
    except ElementTree.ParseError as exc:
        raw, encoding = _decode_text(data)
        cleaned = _clean_text(raw)
        return ParseOutcome(
            kind="document",
            subtype="xml_invalid",
            status="degraded",
            summary=f"XML 解析失败，按文本降级读取\n{_cap(cleaned, limits.max_text_chars)}",
            metadata={"encoding": encoding},
            warnings=[f"XML 语法错误：{exc}"],
            previews=[_text_preview(cleaned, limits)],
        )
    if _looks_like_aecg(root):
        return _summarize_aecg(root, limits)

    root_name = _local_name(root.tag)
    is_cda = root_name.lower() == "clinicaldocument" or filename.lower().endswith((".cda", ".cda.xml"))
    title = _first_element_text(root, {"title"}) or Path(filename).stem
    sections = _xml_sections(root)
    narrative = _xml_narrative(root, limits.max_preview_text_chars)
    rendered_parts = [f"标题：{title}", f"根元素：{root_name}"]
    if sections:
        rendered_parts.append("章节：" + "、".join(sections[:30]))
    if narrative:
        rendered_parts.append(narrative)
    rendered = "\n".join(rendered_parts)
    return ParseOutcome(
        kind="document",
        subtype="cda_xml" if is_cda else "xml",
        status="degraded",
        summary=f"{'CDA' if is_cda else 'XML'} 文档\n{_cap(rendered, limits.max_text_chars)}",
        metadata={
            "parser": "ElementTree",
            "root_element": root_name,
            "title": title,
            "section_count": len(sections),
            "external_entities_allowed": False,
        },
        warnings=["使用标准库安全 XML 解析；未进行 CDA schema 校验"],
        previews=[_text_preview(rendered, limits)],
    )


def _summarize_aecg(root: Any, limits: ParserLimits) -> ParseOutcome:
    lead_names: list[str] = []
    sequence_count = 0
    sample_rate: float | None = None
    duration: float | None = None
    for index, elem in enumerate(root.iter()):
        if index > 100_000:
            break
        name = _local_name(elem.tag).lower()
        if name == "sequence":
            sequence_count += 1
            for child in elem.iter():
                if _local_name(child.tag).lower() != "code":
                    continue
                lead = child.get("code") or child.get("displayName")
                if lead and ("LEAD" in lead.upper() or "ECG" in lead.upper()):
                    lead_names.append(str(lead)[:100])
                    break
        elif name == "increment" and sample_rate is None:
            sample_rate = _frequency_from_increment(elem.get("value"), elem.get("unit"))
        elif name in {"totallength", "width"} and duration is None:
            duration = _duration_seconds(elem.get("value"), elem.get("unit"))
    lead_names = list(dict.fromkeys(lead_names))
    lead_count = len(lead_names) or sequence_count
    lines = ["aECG XML 心电记录", f"导联数：{lead_count or '未知'}"]
    if lead_names:
        lines.append("导联：" + "、".join(lead_names[:24]))
    if sample_rate:
        lines.append(f"采样率：{sample_rate:g} Hz")
    if duration:
        lines.append(f"时长：{duration:g} 秒")
    rendered = "\n".join(lines)
    return ParseOutcome(
        kind="ecg",
        subtype="aecg_xml",
        status="degraded",
        summary=rendered,
        metadata={
            "parser": "ElementTree",
            "lead_count": lead_count or None,
            "lead_names": lead_names,
            "sampling_rate_hz": sample_rate,
            "duration_seconds": duration,
        },
        warnings=["已解析 aECG 基础元数据；未生成波形预览"],
        previews=[_text_preview(rendered, limits)],
    )


def _parse_pdf(data: bytes, limits: ParserLimits) -> ParseOutcome:
    try:
        import fitz  # type: ignore
    except ImportError:
        return ParseOutcome(
            kind="document",
            subtype="pdf",
            status="degraded",
            included=False,
            summary="PDF 文件；当前环境缺少 PyMuPDF，无法安全提取文本或生成预览。",
            warnings=["dependency_missing:PyMuPDF"],
        )
    warnings: list[str] = []
    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        return ParseOutcome(
            kind="document",
            subtype="pdf_invalid",
            status="degraded",
            included=False,
            summary="PDF 文件读取失败。",
            warnings=[f"pdf_read_failed:{type(exc).__name__}"],
        )
    try:
        page_count = int(document.page_count)
        pages_to_process = min(page_count, limits.max_pages)
        if page_count > limits.max_pages:
            warnings.append(f"PDF 页数超过限制，仅处理前 {limits.max_pages} 页")
        text_parts: list[str] = []
        text_pages = 0
        for index in range(pages_to_process):
            text = _clean_text(document.load_page(index).get_text("text") or "")
            if text:
                text_pages += 1
                text_parts.append(f"[第 {index + 1} 页]\n{_cap(text, 8_000)}")
        full_text = "\n\n".join(text_parts)
        previews: list[dict[str, Any]] = []
        if not full_text:
            for index in range(min(pages_to_process, 3)):
                pixmap = document.load_page(index).get_pixmap(dpi=96, alpha=False)
                if pixmap.width * pixmap.height > limits.max_pixels:
                    warnings.append(f"PDF 第 {index + 1} 页预览超过像素预算，已跳过")
                    continue
                preview = _image_preview(
                    pixmap.tobytes("png"),
                    width=pixmap.width,
                    height=pixmap.height,
                    index=index,
                    limits=limits,
                )
                if preview:
                    previews.append(preview)
        metadata = {
            "page_count": page_count,
            "processed_pages": pages_to_process,
            "text_page_count": text_pages,
            "text_character_count": len(full_text),
            "rendered_preview_pages": len(previews),
        }
        if full_text:
            return ParseOutcome(
                kind="document",
                subtype="pdf_text",
                status="ready",
                summary=f"PDF 文档（共 {page_count} 页，提取 {text_pages} 页文本）\n"
                f"{_cap(full_text, limits.max_text_chars)}",
                metadata=metadata,
                warnings=warnings,
                previews=[_text_preview(full_text, limits)],
            )
        return ParseOutcome(
            kind="document",
            subtype="pdf_scanned",
            status="degraded",
            included=False,
            summary=f"扫描版 PDF（共 {page_count} 页），无可提取文本层。",
            metadata=metadata,
            warnings=warnings + ["未检测到文本层；预览不用于诊断"],
            previews=previews,
        )
    finally:
        document.close()


def _parse_image(data: bytes, fmt: AttachmentFormat, limits: ParserLimits) -> ParseOutcome:
    try:
        from PIL import Image, ImageOps  # type: ignore
    except ImportError:
        dimensions = _basic_image_dimensions(data, fmt.subtype)
        return ParseOutcome(
            kind="image",
            subtype=fmt.subtype,
            status="degraded",
            included=False,
            summary=(
                f"图片：{dimensions[0]}×{dimensions[1]}；缺少 Pillow，未生成受限预览。"
                if dimensions
                else "图片；缺少 Pillow，无法校验尺寸或生成预览。"
            ),
            metadata=(
                {"width": dimensions[0], "height": dimensions[1], "format": fmt.subtype}
                if dimensions
                else {"format": fmt.subtype}
            ),
            warnings=["dependency_missing:Pillow"],
        )
    try:
        with Image.open(BytesIO(data)) as probe:
            image_format = str(probe.format or fmt.subtype)
            width, height = probe.size
            mode = probe.mode
            if width <= 0 or height <= 0 or width * height > limits.max_pixels:
                raise ValueError("image pixel count exceeds the configured budget")
            probe.verify()
        with Image.open(BytesIO(data)) as source:
            image = ImageOps.exif_transpose(source)
            image.thumbnail((limits.max_image_long_side, limits.max_image_long_side))
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGB")
            if image.mode == "RGBA":
                background = Image.new("RGB", image.size, "white")
                background.paste(image, mask=image.getchannel("A"))
                image = background
            output = BytesIO()
            image.save(output, format="PNG", optimize=True)
            preview = _image_preview(
                output.getvalue(),
                width=image.width,
                height=image.height,
                index=0,
                limits=limits,
            )
    except Exception as exc:
        return ParseOutcome(
            kind="image",
            subtype=fmt.subtype,
            status="degraded",
            included=False,
            summary="图片校验或缩放失败。",
            warnings=[f"image_parse_failed:{type(exc).__name__}"],
        )
    return ParseOutcome(
        kind="image",
        subtype=image_format.lower(),
        status="ready",
        summary=f"普通图片：{width}×{height}，格式 {image_format}。",
        metadata={
            "width": width,
            "height": height,
            "mode": mode,
            "format": image_format,
            "preview_width": image.width,
            "preview_height": image.height,
        },
        previews=[preview] if preview else [],
    )


def _parse_dicom(data: bytes, limits: ParserLimits) -> ParseOutcome:
    try:
        import pydicom  # type: ignore
    except ImportError:
        return ParseOutcome(
            kind="dicom",
            subtype="dicom",
            status="degraded",
            included=False,
            summary="DICOM 文件；当前环境缺少 pydicom，未读取 metadata 或像素。",
            metadata={
                "selected_frames": 0,
                "selected_indices": [],
                "direct_identifiers_filtered": False,
                "burned_in_phi_evaluated": False,
            },
            warnings=["dependency_missing:pydicom"],
        )
    try:
        dataset = pydicom.dcmread(BytesIO(data), force=False)
    except Exception as exc:
        return ParseOutcome(
            kind="dicom",
            subtype="dicom_invalid",
            status="degraded",
            included=False,
            summary="DICOM 文件读取失败。",
            metadata={
                "selected_frames": 0,
                "selected_indices": [],
                "direct_identifiers_filtered": False,
                "burned_in_phi_evaluated": False,
            },
            warnings=[f"dicom_read_failed:{type(exc).__name__}"],
        )

    safe_fields = (
        "Modality",
        "BodyPartExamined",
        "Manufacturer",
        "ManufacturerModelName",
        "Rows",
        "Columns",
        "NumberOfFrames",
        "PhotometricInterpretation",
    )
    metadata = {
        name: _jsonable(getattr(dataset, name))
        for name in safe_fields
        if getattr(dataset, name, None) not in (None, "")
    }
    for name in ("StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID"):
        value = getattr(dataset, name, None)
        if value:
            import hashlib

            metadata[f"{name}_sha256"] = hashlib.sha256(str(value).encode("utf-8")).hexdigest()
    metadata.update(
        {
            "direct_identifiers_filtered": True,
            "burned_in_phi_evaluated": False,
            "pixel_data_deidentified": False,
            "removed_fields": [
                "PatientName",
                "PatientID",
                "PatientBirthDate",
                "PatientAddress",
                "AccessionNumber",
                "InstitutionName",
                "StudyDate",
                "SeriesDate",
                "StudyDescription",
                "SeriesDescription",
            ],
        }
    )
    declared_frames = _positive_int(metadata.get("NumberOfFrames")) or 1
    rows = _positive_int(metadata.get("Rows")) or 0
    columns = _positive_int(metadata.get("Columns")) or 0
    if rows and columns and rows * columns * declared_frames > limits.max_pixels:
        return ParseOutcome(
            kind="dicom",
            subtype=f"dicom_{str(metadata.get('Modality') or 'unknown').lower()}",
            status="degraded",
            included=False,
            summary="DICOM 安全 metadata 字段已提取，但像素总量超过预算且未输出预览。",
            metadata={**metadata, "total_frames": declared_frames, "selected_frames": 0},
            warnings=["dicom_pixel_budget_exceeded"],
        )
    burned_in_annotation = str(getattr(dataset, "BurnedInAnnotation", "") or "").upper()
    metadata["burned_in_annotation"] = burned_in_annotation or "UNKNOWN"
    if burned_in_annotation == "NO":
        previews, render_warnings = _render_dicom(dataset, limits)
        render_warnings.append(
            "DICOM tag 声明无 burned-in annotation；仍需人工确认预览不含像素身份信息"
        )
    else:
        previews = []
        render_warnings = [
            "burned_in_phi_not_cleared: 未确认像素去标识，已阻止 DICOM 预览输出"
        ]
    selected_indices = [int(item["index"]) for item in previews]
    metadata.update(
        {
            "total_frames": declared_frames,
            "selected_frames": len(previews),
            "selected_indices": selected_indices,
        }
    )
    modality = str(metadata.get("Modality") or "UNKNOWN")
    return ParseOutcome(
        kind="dicom",
        subtype=f"dicom_{modality.lower()}",
        status="degraded",
        summary=f"DICOM 医学影像：模态 {modality}，总帧数 {declared_frames}；"
        f"已生成 {len(previews)} 张受限非诊断级预览。",
        metadata=metadata,
        warnings=render_warnings + [
            "DICOM metadata 仅返回安全字段白名单；不代表完整去标识",
            "预览非诊断级",
        ],
        previews=previews,
    )


def _render_dicom(dataset: Any, limits: ParserLimits) -> tuple[list[dict[str, Any]], list[str]]:
    try:
        import numpy as np  # type: ignore
        from PIL import Image  # type: ignore
    except ImportError:
        return [], ["dependency_missing:numpy_or_Pillow_for_dicom_frames"]
    try:
        pixels = np.asarray(dataset.pixel_array)
    except Exception as exc:
        return [], [f"dicom_pixel_decode_failed:{type(exc).__name__}"]
    if pixels.ndim == 2:
        frames = [pixels]
    elif pixels.ndim == 3 and int(getattr(dataset, "SamplesPerPixel", 1) or 1) > 1:
        frames = [pixels]
    elif pixels.ndim in {3, 4}:
        frames = [pixels[index] for index in range(pixels.shape[0])]
    else:
        return [], ["dicom_pixel_shape_unsupported"]
    indices = _uniform_indices(len(frames), limits.max_frames)
    previews: list[dict[str, Any]] = []
    warnings: list[str] = []
    for index in indices:
        try:
            array = np.asarray(frames[index])
            if array.ndim == 2:
                finite = array[np.isfinite(array)].astype("float32")
                if finite.size == 0:
                    raise ValueError("no finite pixels")
                low, high = np.percentile(finite, [1, 99])
                if high <= low:
                    high = low + 1
                normalized = np.clip((array - low) / (high - low), 0, 1)
                normalized = (np.nan_to_num(normalized) * 255).astype("uint8")
                if str(getattr(dataset, "PhotometricInterpretation", "")).upper() == "MONOCHROME1":
                    normalized = 255 - normalized
                image = Image.fromarray(normalized).convert("RGB")
            else:
                image = Image.fromarray(array[..., :3].astype("uint8")).convert("RGB")
            image.thumbnail((limits.max_image_long_side, limits.max_image_long_side))
            output = BytesIO()
            image.save(output, format="PNG", optimize=True)
            preview = _image_preview(
                output.getvalue(),
                width=image.width,
                height=image.height,
                index=index,
                limits=limits,
            )
            if preview:
                previews.append(preview)
        except Exception as exc:
            warnings.append(f"dicom_frame_{index}_failed:{type(exc).__name__}")
    return previews, warnings


def _parse_wfdb(
    data: bytes,
    filename: str,
    companions: Mapping[str, bytes],
    limits: ParserLimits,
) -> ParseOutcome:
    suffix = Path(filename).suffix.lower()
    stem = Path(filename).stem
    lower_companions = {name.lower(): content for name, content in companions.items()}
    header_name = f"{stem}.hea".lower()
    data_name = f"{stem}.dat".lower()
    if suffix == ".dat":
        has_header = header_name in lower_companions
        return ParseOutcome(
            kind="ecg",
            subtype="wfdb_data",
            status="degraded",
            included=False,
            summary=(
                "WFDB 二进制波形数据；由同名 .hea 记录统一解析。"
                if has_header
                else "WFDB 二进制波形数据；缺少同名 .hea 头文件。"
            ),
            metadata={"companion_header_present": has_header},
            warnings=[] if has_header else ["wfdb_companion_header_missing"],
        )
    header_text, encoding = _decode_text(data)
    basic = _parse_wfdb_header_line(header_text)
    has_data = data_name in lower_companions
    metadata = {**basic, "encoding": encoding, "companion_data_present": has_data}
    if not has_data:
        return ParseOutcome(
            kind="ecg",
            subtype="wfdb",
            status="degraded",
            summary="WFDB 头文件已读取，但缺少同名 .dat 波形文件。",
            metadata=metadata,
            warnings=["wfdb_companion_data_missing"],
            previews=[_text_preview(header_text, limits)],
        )
    try:
        import wfdb  # type: ignore
    except ImportError:
        return ParseOutcome(
            kind="ecg",
            subtype="wfdb",
            status="degraded",
            summary="WFDB 头文件和配套数据均存在，但当前环境缺少 wfdb。",
            metadata=metadata,
            warnings=["dependency_missing:wfdb"],
            previews=[_text_preview(header_text, limits)],
        )
    try:
        with tempfile.TemporaryDirectory(prefix="medical-wfdb-") as temp:
            root = Path(temp)
            (root / f"{stem}.hea").write_bytes(data)
            (root / f"{stem}.dat").write_bytes(lower_companions[data_name])
            record = wfdb.rdrecord(str(root / stem))
            metadata.update(
                {
                    "signal_count": int(record.n_sig),
                    "sample_rate_hz": float(record.fs),
                    "sample_count": int(record.sig_len),
                    "lead_names": [str(item) for item in (record.sig_name or [])][:24],
                }
            )
    except Exception as exc:
        return ParseOutcome(
            kind="ecg",
            subtype="wfdb",
            status="degraded",
            summary="WFDB 配套文件读取失败。",
            metadata=metadata,
            warnings=[f"wfdb_read_failed:{type(exc).__name__}"],
            previews=[_text_preview(header_text, limits)],
        )
    return ParseOutcome(
        kind="ecg",
        subtype="wfdb",
        status="ready",
        summary=f"WFDB 心电记录：{metadata.get('record_name') or stem}，"
        f"{metadata.get('signal_count', 0)} 个信号。",
        metadata=metadata,
        warnings=["波形 metadata 已读取；当前接口不返回原始波形样本"],
        previews=[_text_preview(header_text, limits)],
    )


def _text_preview(text: str, limits: ParserLimits) -> dict[str, Any]:
    preview = _cap(text, limits.max_preview_text_chars)
    return {
        "kind": "text",
        "media_type": "text/plain; charset=utf-8",
        "text": preview,
        "byte_size": len(preview.encode("utf-8")),
        "index": 0,
    }


def _image_preview(
    data: bytes,
    *,
    width: int,
    height: int,
    index: int,
    limits: ParserLimits,
) -> dict[str, Any] | None:
    if len(data) > limits.max_preview_bytes:
        return None
    return {
        "kind": "image",
        "media_type": "image/png",
        "data": base64.b64encode(data).decode("ascii"),
        "byte_size": len(data),
        "width": width,
        "height": height,
        "index": index,
        "diagnostic_grade": False,
    }


def _basic_image_dimensions(data: bytes, subtype: str) -> tuple[int, int] | None:
    if subtype == "png" and len(data) >= 24 and data.startswith(b"\x89PNG\r\n\x1a\n"):
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if subtype == "bmp" and len(data) >= 26 and data.startswith(b"BM"):
        return abs(int.from_bytes(data[18:22], "little", signed=True)), abs(
            int.from_bytes(data[22:26], "little", signed=True)
        )
    if subtype == "jpeg" and data.startswith(b"\xff\xd8"):
        offset = 2
        while offset + 9 < len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            marker = data[offset + 1]
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                return int.from_bytes(data[offset + 7 : offset + 9], "big"), int.from_bytes(
                    data[offset + 5 : offset + 7], "big"
                )
            if offset + 4 > len(data):
                break
            segment = int.from_bytes(data[offset + 2 : offset + 4], "big")
            if segment < 2:
                break
            offset += 2 + segment
    return None


def _decode_text(content: bytes) -> tuple[str, str]:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return content.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace"), "utf-8-replace"


def _clean_text(text: str) -> str:
    cleaned = text.replace("\x00", "")
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    return re.sub(r"\n{4,}", "\n\n\n", cleaned).strip()


def _cap(text: str, limit: int) -> str:
    if limit <= 0 or len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n…[已截断]"


def _local_name(tag: Any) -> str:
    value = str(tag or "")
    if "}" in value:
        value = value.rsplit("}", 1)[-1]
    if ":" in value:
        value = value.rsplit(":", 1)[-1]
    return value


def _first_element_text(root: Any, names: set[str]) -> str | None:
    wanted = {name.lower() for name in names}
    for elem in root.iter():
        if _local_name(elem.tag).lower() in wanted:
            text = " ".join(part.strip() for part in elem.itertext() if part and part.strip())
            if text:
                return text[:500]
    return None


def _xml_sections(root: Any) -> list[str]:
    sections: list[str] = []
    for elem in root.iter():
        if _local_name(elem.tag).lower() == "section":
            title = _first_element_text(elem, {"title"})
            if title and title not in sections:
                sections.append(title)
        if len(sections) >= 200:
            break
    return sections


def _xml_narrative(root: Any, maximum: int) -> str:
    parts: list[str] = []
    total = 0
    for elem in root.iter():
        if _local_name(elem.tag).lower() not in {"title", "text", "value"}:
            continue
        text = " ".join(part.strip() for part in elem.itertext() if part and part.strip())
        if not text and _local_name(elem.tag).lower() == "value":
            text = str(elem.get("value") or "")
        text = _clean_text(text)
        if text and text not in parts:
            parts.append(text[:4_000])
            total += len(parts[-1])
        if total >= maximum:
            break
    return "\n".join(parts)[:maximum]


def _looks_like_aecg(root: Any) -> bool:
    root_name = _local_name(root.tag).lower()
    if "annotatedecg" in root_name or root_name == "aecg":
        return True
    names: set[str] = set()
    for index, elem in enumerate(root.iter()):
        names.add(_local_name(elem.tag).lower())
        if index >= 5_000:
            break
    return "sequence" in names and ("digits" in names or "increment" in names) and "component" in names


def _frequency_from_increment(value: Any, unit: Any) -> float | None:
    try:
        interval = float(value)
    except (TypeError, ValueError):
        return None
    if interval <= 0:
        return None
    normalized = str(unit or "").lower()
    factors = {"s": 1.0, "sec": 1.0, "second": 1.0, "ms": 1000.0, "us": 1_000_000.0}
    factor = factors.get(normalized)
    return factor / interval if factor else None


def _duration_seconds(value: Any, unit: Any) -> float | None:
    try:
        duration = float(value)
    except (TypeError, ValueError):
        return None
    normalized = str(unit or "s").lower()
    return duration / {"ms": 1000.0, "us": 1_000_000.0}.get(normalized, 1.0)


def _parse_wfdb_header_line(text: str) -> dict[str, Any]:
    first = next(
        (line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")),
        "",
    )
    tokens = first.split()
    result: dict[str, Any] = {}
    if tokens:
        result["record_name"] = tokens[0].split("/", 1)[0]
    for index, key, converter in (
        (1, "signal_count", int),
        (2, "sample_rate_hz", float),
        (3, "sample_count", int),
    ):
        if len(tokens) > index:
            try:
                result[key] = converter(tokens[index].split("/", 1)[0])
            except ValueError:
                pass
    return result


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _uniform_indices(total: int, maximum: int) -> list[int]:
    if total <= 0:
        return []
    count = min(total, max(1, maximum))
    if count == total:
        return list(range(total))
    if count == 1:
        return [0]
    return [round(index * (total - 1) / (count - 1)) for index in range(count)]


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return str(value)

