"""Dialogue 自有的多源附件解析器。

所有第三方解析依赖都在具体分支内延迟导入。缺少依赖或单文件内容异常时，
解析器返回 ``degraded``，由上层继续处理同批其他文件。
"""

from __future__ import annotations

import json
import uuid
import math
import re
import xml.etree.ElementTree as std_etree
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


@dataclass
class ParseOutcome:
    """Single-file parse result for med-tools (absolute preview/image paths)."""

    kind: str
    subtype: str
    status: str
    summary: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    included: bool = True
    preview_kind: Optional[str] = None
    preview_ref: Optional[str] = None
    # Absolute filesystem paths to images injectable into the VLM.
    model_image_refs: List[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.warnings = list(self.warnings)
        self.model_image_refs = [str(p) for p in (self.model_image_refs or []) if p]




SUPPORTED_SUFFIXES = frozenset(
    {
        ".cda",
        ".xml",
        ".json",
        ".xml1",
        ".txt",
        ".md",
        ".markdown",
        ".pdf",
        ".png",
        ".jpg",
        ".jpeg",
        ".bmp",
        ".dcm",
        ".dicom",
        ".ecg",
        ".wfdb",
        ".hea",
        ".dat",
        ".atr",
        ".qrs",
        ".edf",
        ".scp",
    }
)

_TEXT_SUFFIXES = {".txt", ".md", ".markdown"}
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp"}
_DICOM_SUFFIXES = {".dcm", ".dicom"}
_WFDB_SUFFIXES = {".hea", ".dat"}
_OTHER_ECG_SUFFIXES = {".ecg", ".wfdb", ".atr", ".qrs", ".edf", ".scp"}
_PREVIEW_TEXT_CHARS = 50_000


def parse_staged_file(
    source_path: Path,
    *,
    artifact_id: str,
    filename: str,
    derived_dir: Path,
    max_text_chars: int,
    max_dicom_frames_per_file: int = 8,
    max_image_long_side: int = 1600,
) -> ParseOutcome:
    """按后缀解析已安全落盘的单个文件。"""

    suffix = source_path.suffix.lower()
    if suffix in _TEXT_SUFFIXES:
        return _parse_text(source_path, artifact_id, derived_dir, max_text_chars)
    if suffix in {".json", ".xml1"}:
        return _parse_json(source_path, artifact_id, derived_dir, max_text_chars)
    if suffix in {".xml", ".cda"}:
        return _parse_xml(source_path, artifact_id, derived_dir, max_text_chars)
    if suffix == ".pdf":
        return _parse_pdf(source_path, artifact_id, derived_dir, max_text_chars)
    if suffix in _IMAGE_SUFFIXES:
        return _parse_image(
            source_path,
            artifact_id,
            derived_dir,
            max_long_side=max_image_long_side,
        )
    if suffix in _DICOM_SUFFIXES:
        return _parse_dicom(
            source_path,
            artifact_id,
            derived_dir,
            max_frames=max_dicom_frames_per_file,
            max_long_side=max_image_long_side,
        )
    if suffix in _WFDB_SUFFIXES:
        return _parse_wfdb(source_path, artifact_id, derived_dir)
    if suffix in _OTHER_ECG_SUFFIXES:
        return ParseOutcome(
            kind="ecg",
            subtype=f"ecg_{suffix.lstrip('.')}",
            status="degraded",
            included=False,
            summary=f"心电相关文件（{suffix.lstrip('.').upper()}）；当前仅支持 aECG XML 与 WFDB .hea/.dat 深度解析。",
            warnings=["该心电扩展名已安全接收，但当前阶段不注入模型上下文"],
        )
    return ParseOutcome(
        kind="unknown",
        subtype=suffix.lstrip(".") or "unknown",
        status="degraded",
        included=False,
        summary=f"未支持的附件类型：{filename}",
        warnings=[f"扩展名 {suffix or '(无)'} 不在解析器白名单内"],
    )


def _parse_text(path: Path, artifact_id: str, derived_dir: Path, max_chars: int) -> ParseOutcome:
    text, encoding = _decode_text(path.read_bytes())
    cleaned = _clean_text(text)
    subtype = "markdown" if path.suffix.lower() in {".md", ".markdown"} else "plain_text"
    preview_ref = _write_text_preview(derived_dir, artifact_id, cleaned)
    summary_body = _cap(cleaned, max_chars)
    return ParseOutcome(
        kind="document",
        subtype=subtype,
        status="ready",
        summary=f"{'Markdown' if subtype == 'markdown' else '文本'}文档（{len(cleaned)} 字符）\n{summary_body}",
        metadata={"encoding": encoding, "character_count": len(cleaned)},
        preview_kind="text",
        preview_ref=preview_ref,
    )


def _parse_json(path: Path, artifact_id: str, derived_dir: Path, max_chars: int) -> ParseOutcome:
    raw, encoding = _decode_text(path.read_bytes())
    warnings: List[str] = []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        cleaned = _clean_text(raw)
        preview_ref = _write_text_preview(derived_dir, artifact_id, cleaned)
        return ParseOutcome(
            kind="document",
            subtype="json_invalid",
            status="degraded",
            summary=f"JSON 解析失败，按文本降级读取\n{_cap(cleaned, max_chars)}",
            metadata={"encoding": encoding, "character_count": len(cleaned)},
            warnings=[f"JSON 语法错误：{exc.msg}（第 {exc.lineno} 行）"],
            preview_kind="text",
            preview_ref=preview_ref,
        )

    rendered = json.dumps(data, ensure_ascii=False, indent=2)
    preview_ref = _write_text_preview(derived_dir, artifact_id, rendered)
    metadata: Dict[str, Any] = {
        "encoding": encoding,
        "top_level_type": type(data).__name__,
        "character_count": len(rendered),
    }
    if isinstance(data, dict):
        metadata["top_level_keys"] = [_cap(str(key), 200) for key in list(data.keys())[:50]]
        metadata["item_count"] = len(data)
    elif isinstance(data, list):
        metadata["item_count"] = len(data)
    subtype = "json_xml1" if path.suffix.lower() == ".xml1" else "json"
    return ParseOutcome(
        kind="document",
        subtype=subtype,
        status="ready",
        summary=f"JSON 文档（{metadata.get('item_count', 1)} 项）\n{_cap(rendered, max_chars)}",
        metadata=metadata,
        warnings=warnings,
        preview_kind="text",
        preview_ref=preview_ref,
    )


def _parse_xml(path: Path, artifact_id: str, derived_dir: Path, max_chars: int) -> ParseOutcome:
    content = path.read_bytes()
    warnings: List[str] = []
    parser_backend = "lxml"
    try:
        try:
            from lxml import etree  # type: ignore
        except ImportError:
            parser_backend = "ElementTree"
            warnings.append("未安装 lxml，已使用安全 ElementTree 降级解析")
            root = std_etree.fromstring(content)
        else:
            parser = etree.XMLParser(
                resolve_entities=False,
                no_network=True,
                load_dtd=False,
                huge_tree=False,
                recover=False,
                remove_comments=True,
            )
            root = etree.fromstring(content, parser=parser)
    except Exception as exc:
        raw, encoding = _decode_text(content)
        cleaned = _clean_text(raw)
        preview_ref = _write_text_preview(derived_dir, artifact_id, cleaned)
        return ParseOutcome(
            kind="document",
            subtype="xml_invalid",
            status="degraded",
            summary=f"XML 解析失败，按文本降级读取\n{_cap(cleaned, max_chars)}",
            metadata={"encoding": encoding},
            warnings=[f"XML 语法错误：{type(exc).__name__}: {str(exc)[:300]}"],
            preview_kind="text",
            preview_ref=preview_ref,
        )

    if _looks_like_aecg(root):
        return _summarize_aecg(
            root,
            artifact_id=artifact_id,
            derived_dir=derived_dir,
            parser_backend=parser_backend,
            inherited_warnings=warnings,
        )

    title = _first_element_text(root, {"title"}) or path.stem
    root_name = _local_name(getattr(root, "tag", ""))
    is_cda = root_name.lower() == "clinicaldocument"
    sections = _xml_sections(root)
    narrative = _xml_narrative(root)
    lines = [f"标题：{title}", f"根元素：{root_name}"]
    if sections:
        lines.append("章节：" + "、".join(sections[:30]))
    if narrative:
        lines.append(narrative)
    rendered = "\n".join(lines)
    preview_ref = _write_text_preview(derived_dir, artifact_id, rendered)
    status = "degraded" if parser_backend == "ElementTree" else "ready"
    subtype = "cda_xml" if is_cda else "xml"
    return ParseOutcome(
        kind="document",
        subtype=subtype,
        status=status,
        summary=f"{'CDA' if is_cda else 'XML'} 文档\n{_cap(rendered, max_chars)}",
        metadata={
            "parser": parser_backend,
            "root_element": root_name,
            "title": title,
            "section_count": len(sections),
        },
        warnings=warnings,
        preview_kind="text",
        preview_ref=preview_ref,
    )


def _summarize_aecg(
    root: Any,
    *,
    artifact_id: str,
    derived_dir: Path,
    parser_backend: str,
    inherited_warnings: List[str],
) -> ParseOutcome:
    lead_names: List[str] = []
    sample_rate: Optional[float] = None
    duration: Optional[float] = None
    sequence_count = 0

    for elem in root.iter():
        name = _local_name(getattr(elem, "tag", "")).lower()
        if name == "sequence":
            sequence_count += 1
            for child in elem.iter():
                if _local_name(getattr(child, "tag", "")).lower() != "code":
                    continue
                lead = child.get("code") or child.get("displayName")
                if lead and ("LEAD" in lead.upper() or "ECG" in lead.upper()):
                    lead_names.append(_cap(str(lead), 100))
                    break
        elif name == "increment" and sample_rate is None:
            sample_rate = _frequency_from_increment(elem.get("value"), elem.get("unit"))
        elif name in {"totallength", "width"} and duration is None:
            duration = _duration_seconds(elem.get("value"), elem.get("unit"))

    lead_names = list(dict.fromkeys(lead_names))
    lead_count = len(lead_names) or sequence_count
    lines = ["aECG XML 心电记录"]
    lines.append(f"导联数：{lead_count or '未知'}")
    if lead_names:
        lines.append("导联：" + "、".join(lead_names[:24]))
    if sample_rate:
        lines.append(f"采样率：{sample_rate:g} Hz")
    if duration:
        lines.append(f"时长：{duration:g} 秒")
    rendered = "\n".join(lines)
    preview_ref = _write_text_preview(derived_dir, artifact_id, rendered)
    warnings = list(inherited_warnings)
    warnings.append("已完成 aECG 基础元数据解析；当前未生成波形图")
    return ParseOutcome(
        kind="ecg",
        subtype="aecg_xml",
        status="degraded" if parser_backend == "ElementTree" else "ready",
        summary=rendered,
        metadata={
            "parser": parser_backend,
            "lead_count": lead_count or None,
            "lead_names": lead_names,
            "sampling_rate_hz": sample_rate,
            "duration_seconds": duration,
        },
        warnings=warnings,
        preview_kind="text",
        preview_ref=preview_ref,
    )


def _parse_pdf(path: Path, artifact_id: str, derived_dir: Path, max_chars: int) -> ParseOutcome:
    warnings: List[str] = []
    text_parts: List[str] = []
    page_count: Optional[int] = None
    text_pages = 0

    try:
        import pypdf  # type: ignore
    except ImportError:
        warnings.append("未安装 pypdf，将尝试使用 PyMuPDF")
    else:
        try:
            reader = pypdf.PdfReader(str(path))
            page_count = len(reader.pages)
            for index, page in enumerate(reader.pages[:50]):
                try:
                    text = _clean_text(page.extract_text() or "")
                except Exception as exc:
                    warnings.append(f"PDF 第 {index + 1} 页文本提取失败：{str(exc)[:120]}")
                    continue
                if text:
                    text_pages += 1
                    text_parts.append(f"[第 {index + 1} 页]\n{_cap(text, 8_000)}")
        except Exception as exc:
            warnings.append(f"pypdf 读取失败：{type(exc).__name__}: {str(exc)[:200]}")

    fitz_doc = None
    try:
        import fitz  # type: ignore
    except ImportError:
        fitz = None
    if fitz is not None:
        try:
            fitz_doc = fitz.open(str(path))
            page_count = page_count if page_count is not None else fitz_doc.page_count
            if not text_parts:
                for index in range(min(fitz_doc.page_count, 50)):
                    text = _clean_text(fitz_doc.load_page(index).get_text("text") or "")
                    if text:
                        text_pages += 1
                        text_parts.append(f"[第 {index + 1} 页]\n{_cap(text, 8_000)}")
        except Exception as exc:
            warnings.append(f"PyMuPDF 读取失败：{type(exc).__name__}: {str(exc)[:200]}")
            if fitz_doc is not None:
                fitz_doc.close()
            fitz_doc = None

    full_text = "\n\n".join(text_parts).strip()
    rendered_paths: List[Path] = []
    if not full_text and fitz_doc is not None:
        try:
            derived_dir.mkdir(parents=True, exist_ok=True)
            for index in range(min(fitz_doc.page_count, 3)):
                out_path = derived_dir / f"{artifact_id}_page_{index + 1}.png"
                pix = fitz_doc.load_page(index).get_pixmap(dpi=144, alpha=False)
                pix.save(str(out_path))
                rendered_paths.append(out_path)
        except Exception as exc:
            warnings.append(f"扫描版 PDF 预览渲染失败：{type(exc).__name__}: {str(exc)[:200]}")
    if fitz_doc is not None:
        fitz_doc.close()

    metadata = {
        "page_count": page_count,
        "text_page_count": text_pages,
        "text_character_count": len(full_text),
        "rendered_preview_pages": len(rendered_paths),
    }
    if full_text:
        preview_ref = _write_text_preview(derived_dir, artifact_id, full_text)
        return ParseOutcome(
            kind="document",
            subtype="pdf_text",
            status="ready",
            summary=f"PDF 文档（共 {page_count or '?'} 页，提取 {text_pages} 页文本）\n{_cap(full_text, max_chars)}",
            metadata=metadata,
            warnings=warnings,
            preview_kind="text",
            preview_ref=preview_ref,
        )
    if rendered_paths:
        preview_ref = _build_pdf_image_preview(
            rendered_paths,
            artifact_id=artifact_id,
            derived_dir=derived_dir,
        )
        warnings.append("未检测到可提取文本层，已渲染最多前三页作为受控预览")
        return ParseOutcome(
            kind="document",
            subtype="pdf_scanned",
            status="degraded",
            summary=f"扫描版 PDF（共 {page_count or '?'} 页），已渲染 {len(rendered_paths)} 页预览；无可注入文本层。",
            metadata=metadata,
            warnings=warnings,
            preview_kind="image",
            preview_ref=preview_ref,
            model_image_refs=[_derived_ref(derived_dir, p) for p in rendered_paths],
        )

    if fitz is None:
        warnings.append("未安装 PyMuPDF，无法渲染扫描版 PDF")
    return ParseOutcome(
        kind="document",
        subtype="pdf_unreadable",
        status="degraded",
        summary=f"PDF 文档（共 {page_count or '?'} 页），未提取到文本或预览。",
        metadata=metadata,
        warnings=warnings,
    )


def _parse_image(
    path: Path,
    artifact_id: str,
    derived_dir: Path,
    *,
    max_long_side: int = 1600,
) -> ParseOutcome:
    try:
        from PIL import Image, ImageOps  # type: ignore
    except ImportError:
        return ParseOutcome(
            kind="image",
            subtype=path.suffix.lower().lstrip("."),
            status="degraded",
            summary="普通图片；当前环境缺少 Pillow，无法校验或生成预览。",
            warnings=["未安装 Pillow"],
        )

    with Image.open(path) as probe:
        image_format = probe.format
        width, height = probe.size
        mode = probe.mode
        probe.verify()

    side = max(256, int(max_long_side or 1600))
    derived_dir.mkdir(parents=True, exist_ok=True)
    out_path = derived_dir / f"{artifact_id}_thumbnail.png"
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image)
        image.thumbnail((side, side))
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGB")
        if image.mode == "RGBA":
            background = Image.new("RGB", image.size, "white")
            background.paste(image, mask=image.getchannel("A"))
            image = background
        image.save(out_path, format="PNG", optimize=True)

    image_ref = _derived_ref(derived_dir, out_path)
    return ParseOutcome(
        kind="image",
        subtype=(image_format or path.suffix.lstrip(".")).lower(),
        status="ready",
        summary=f"普通图片：{width}×{height}，格式 {image_format or path.suffix.lstrip('.').upper()}。",
        metadata={
            "width": width,
            "height": height,
            "mode": mode,
            "format": image_format,
            "max_image_long_side": side,
        },
        preview_kind="image",
        preview_ref=image_ref,
        model_image_refs=[image_ref],
    )


def _build_pdf_image_preview(
    page_paths: List[Path],
    *,
    artifact_id: str,
    derived_dir: Path,
) -> str:
    """将最多三页扫描件拼成单张受控预览，契合单 artifact 预览 URL。"""

    if len(page_paths) == 1:
        return _derived_ref(derived_dir, page_paths[0])
    try:
        from PIL import Image  # type: ignore

        pages = []
        for page_path in page_paths[:3]:
            with Image.open(page_path) as source:
                image = source.convert("RGB")
                image.thumbnail((1000, 1400))
                pages.append(image.copy())
        width = max(image.width for image in pages)
        height = sum(image.height for image in pages) + 12 * (len(pages) - 1)
        contact = Image.new("RGB", (width, height), "white")
        y = 0
        for image in pages:
            x = (width - image.width) // 2
            contact.paste(image, (x, y))
            y += image.height + 12
        output_path = derived_dir / f"{artifact_id}_pdf_preview.png"
        contact.save(output_path, format="PNG", optimize=True)
        return _derived_ref(derived_dir, output_path)
    except Exception:
        return _derived_ref(derived_dir, page_paths[0])


def _parse_dicom(
    path: Path,
    artifact_id: str,
    derived_dir: Path,
    *,
    max_frames: int,
    max_long_side: int = 1600,
) -> ParseOutcome:
    try:
        import pydicom  # type: ignore
    except ImportError:
        return ParseOutcome(
            kind="dicom",
            subtype="dicom",
            status="degraded",
            summary="DICOM 文件；当前环境缺少 pydicom，未读取元数据和像素。",
            metadata={
                "total_frames": None,
                "selected_frames": 0,
                "selected_indices": [],
            },
            warnings=[
                "未安装 pydicom；total_frames=unknown, selected_frames=0, selected_indices=[]"
            ],
        )

    warnings: List[str] = []
    try:
        dataset = pydicom.dcmread(str(path), force=False)
    except Exception as exc:
        return ParseOutcome(
            kind="dicom",
            subtype="dicom_invalid",
            status="degraded",
            summary="DICOM 文件读取失败。",
            metadata={
                "total_frames": None,
                "selected_frames": 0,
                "selected_indices": [],
            },
            warnings=[
                f"pydicom 读取失败：{type(exc).__name__}: {str(exc)[:250]}；"
                "total_frames=unknown, selected_frames=0, selected_indices=[]"
            ],
        )

    fields = (
        "Modality",
        "StudyDescription",
        "SeriesDescription",
        "BodyPartExamined",
        "StudyDate",
        "SeriesDate",
        "Manufacturer",
        "ManufacturerModelName",
        "Rows",
        "Columns",
        "NumberOfFrames",
        "PhotometricInterpretation",
        "StudyInstanceUID",
        "SeriesInstanceUID",
        "SOPInstanceUID",
    )
    metadata: Dict[str, Any] = {}
    metadata_degraded = False
    for field in fields:
        try:
            value = getattr(dataset, field, None)
            if value not in (None, ""):
                metadata[field] = _jsonable(value)
        except Exception as exc:
            metadata_degraded = True
            warnings.append(
                f"DICOM 元数据字段 {field} 读取失败："
                f"{type(exc).__name__}: {str(exc)[:120]}"
            )

    declared_frames = _positive_int(metadata.get("NumberOfFrames")) or 1
    metadata.update(
        {
            "total_frames": declared_frames,
            "selected_frames": 0,
            "selected_indices": [],
        }
    )
    model_image_refs: List[str] = []
    selected_indices: List[int] = []
    requested_indices: List[int] = []
    render_degraded = False
    try:
        (
            model_image_refs,
            total_frames,
            selected_indices,
            requested_indices,
            render_warnings,
        ) = _render_dicom_frames(
            dataset,
            artifact_id,
            derived_dir,
            max_frames=max_frames,
            max_long_side=max_long_side,
        )
        metadata["total_frames"] = total_frames
        metadata["selected_frames"] = len(selected_indices)
        metadata["selected_indices"] = selected_indices
        metadata["max_image_long_side"] = max(256, int(max_long_side or 1600))
        warnings.extend(render_warnings)
        render_degraded = len(selected_indices) != len(requested_indices)
        if total_frames != declared_frames:
            warnings.append(
                "DICOM 声明帧数与解码数组不一致："
                f"NumberOfFrames={declared_frames}, total_frames={total_frames}"
            )
        if total_frames > max(1, int(max_frames)):
            warnings.append(
                "DICOM 多帧已按每文件预算均匀截断："
                f"total_frames={total_frames}, "
                f"selected_frames={len(selected_indices)}, "
                f"selected_indices={selected_indices}, "
                f"max_frames_per_file={max(1, int(max_frames))}"
            )
    except Exception as exc:
        render_degraded = True
        warnings.append(
            "DICOM 像素解码/渲染失败："
            f"{type(exc).__name__}: {str(exc)[:250]}；"
            f"total_frames={metadata['total_frames']}, "
            "selected_frames=0, selected_indices=[]"
        )

    modality = str(metadata.get("Modality") or "UNKNOWN")
    dimensions = ""
    if metadata.get("Rows") and metadata.get("Columns"):
        dimensions = f"，{metadata['Columns']}×{metadata['Rows']}"
    frames = int(metadata["total_frames"])
    selected_detail = (
        f"已生成 {len(model_image_refs)} 张模型图像"
        f"（0-based 帧索引 {selected_indices}）"
        if model_image_refs
        else "未生成可用模型图像"
    )
    preview_ref = model_image_refs[0] if model_image_refs else None
    return ParseOutcome(
        kind="dicom",
        subtype=f"dicom_{modality.lower()}",
        status=(
            "ready"
            if preview_ref and not render_degraded and not metadata_degraded
            else "degraded"
        ),
        summary=(
            f"DICOM 医学影像：模态 {modality}{dimensions}，总帧数 {frames}；"
            f"{selected_detail}。"
            + (
                f" 序列：{_cap(str(metadata['SeriesDescription']), 500)}。"
                if metadata.get("SeriesDescription")
                else ""
            )
        ),
        metadata=metadata,
        warnings=warnings,
        preview_kind="image" if preview_ref else None,
        preview_ref=preview_ref,
        model_image_refs=model_image_refs,
    )


def _render_dicom_frames(
    dataset: Any,
    artifact_id: str,
    derived_dir: Path,
    *,
    max_frames: int,
    max_long_side: int = 1600,
) -> Tuple[List[str], int, List[int], List[int], List[str]]:
    import numpy as np  # type: ignore

    pixels = np.asarray(dataset.pixel_array)
    frames = _split_dicom_frames(pixels, dataset)
    total_frames = len(frames)
    requested_indices = _uniform_frame_indices(total_frames, max_frames)
    derived_dir.mkdir(parents=True, exist_ok=True)
    refs: List[str] = []
    selected_indices: List[int] = []
    warnings: List[str] = []
    for frame_index in requested_indices:
        try:
            image = _dicom_frame_to_image(
                frames[frame_index],
                dataset,
                max_long_side=max_long_side,
            )
            out_path = derived_dir / f"{artifact_id}_dicom_frame_{frame_index:06d}.png"
            image.save(out_path, format="PNG", optimize=True)
            refs.append(_derived_ref(derived_dir, out_path))
            selected_indices.append(frame_index)
        except Exception as exc:
            warnings.append(
                f"DICOM 第 {frame_index} 帧渲染失败："
                f"{type(exc).__name__}: {str(exc)[:200]}"
            )
    return refs, total_frames, selected_indices, requested_indices, warnings


def _split_dicom_frames(pixels: Any, dataset: Any) -> List[Any]:
    """将 pydicom 的标准单帧/多帧灰度和彩色数组统一成帧列表。"""

    shape = tuple(int(item) for item in getattr(pixels, "shape", ()))
    samples_per_pixel = _positive_int(getattr(dataset, "SamplesPerPixel", None)) or 1
    if pixels.ndim == 2:
        return [pixels]
    if pixels.ndim == 3:
        if samples_per_pixel > 1:
            return [pixels]
        return [pixels[index] for index in range(shape[0])]
    if pixels.ndim == 4:
        if shape[-1] not in {3, 4} and shape[1] not in {3, 4}:
            raise ValueError(f"不支持的多帧彩色像素维度：{shape}")
        return [pixels[index] for index in range(shape[0])]
    raise ValueError(f"不支持的 DICOM 像素维度：{shape}")


def _uniform_frame_indices(total_frames: int, max_frames: int) -> List[int]:
    if total_frames <= 0:
        raise ValueError("DICOM 解码后没有像素帧")
    count = min(total_frames, max(1, int(max_frames)))
    if count == total_frames:
        return list(range(total_frames))
    if count == 1:
        return [0]
    denominator = count - 1
    return [
        (index * (total_frames - 1) + denominator // 2) // denominator
        for index in range(count)
    ]


def _dicom_frame_to_image(
    frame: Any,
    dataset: Any,
    *,
    max_long_side: int = 1600,
) -> Any:
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    array = np.asarray(frame)
    if array.ndim == 2:
        normalized = _percentile_uint8(array)
        if str(getattr(dataset, "PhotometricInterpretation", "")).upper() == "MONOCHROME1":
            normalized = 255 - normalized
        image = Image.fromarray(normalized).convert("RGB")
    elif array.ndim == 3:
        if array.shape[-1] in {3, 4}:
            color = array[..., :3]
        elif array.shape[0] in {3, 4}:
            color = np.moveaxis(array[:3], 0, -1)
        else:
            raise ValueError(f"不支持的彩色帧维度：{tuple(array.shape)}")
        if color.dtype == np.uint8 and np.isfinite(color).all():
            normalized = color
        else:
            normalized = _percentile_uint8(color)
        image = Image.fromarray(normalized)
    else:
        raise ValueError(f"不支持的单帧像素维度：{tuple(array.shape)}")

    side = max(256, int(max_long_side or 1600))
    image.thumbnail((side, side), Image.Resampling.LANCZOS)
    return image


def _percentile_uint8(array: Any) -> Any:
    import numpy as np  # type: ignore

    values = np.asarray(array).astype("float32")
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        raise ValueError("像素全部为非有限值")
    low, high = np.percentile(finite, [1, 99])
    low = float(low)
    high = float(high)
    if not math.isfinite(low) or not math.isfinite(high) or high <= low:
        low, high = float(finite.min()), float(finite.max())
    if high <= low:
        high = low + 1.0
    normalized = np.clip((values - low) / (high - low), 0.0, 1.0)
    normalized = np.nan_to_num(normalized, nan=0.0, posinf=1.0, neginf=0.0)
    return (normalized * 255).astype("uint8")


def _positive_int(value: Any) -> Optional[int]:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _parse_wfdb(path: Path, artifact_id: str, derived_dir: Path) -> ParseOutcome:
    if path.suffix.lower() == ".dat":
        has_header = path.with_suffix(".hea").is_file()
        try:
            import wfdb  # type: ignore  # noqa: F401
        except ImportError:
            wfdb_available = False
        else:
            wfdb_available = True
        return ParseOutcome(
            kind="ecg",
            subtype="wfdb_data",
            status="ready" if has_header and wfdb_available else "degraded",
            included=False,
            summary=(
                "WFDB 二进制波形数据；由同名 .hea 记录统一解析。"
                if has_header
                else "WFDB 二进制波形数据；未找到同名 .hea 头文件。"
            ),
            metadata={
                "companion_header_present": has_header,
                "wfdb_available": wfdb_available,
            },
            warnings=(
                []
                if has_header and wfdb_available
                else [
                    "缺少同名 .hea 文件，无法解释二进制波形"
                    if not has_header
                    else "未安装 wfdb，二进制波形仅作为配套文件保存"
                ]
            ),
        )

    raw = path.read_bytes()
    header_text, encoding = _decode_text(raw)
    preview_ref = _write_text_preview(derived_dir, artifact_id, header_text)
    basic = _parse_wfdb_header_line(header_text)
    warnings: List[str] = []
    status = "degraded"
    preview_image: Optional[str] = None
    lead_names: List[str] = []
    lead_stats: List[Dict[str, Any]] = []

    try:
        import wfdb  # type: ignore
    except ImportError:
        warnings.append("未安装 wfdb，仅按标准头文件提取基础元数据")
    else:
        try:
            record = wfdb.rdrecord(str(path.with_suffix("")))
            status = "ready"
            lead_names = [str(item) for item in (getattr(record, "sig_name", None) or [])]
            signals = getattr(record, "p_signal", None)
            if signals is not None:
                import numpy as np  # type: ignore

                array = np.asarray(signals)
                for index in range(min(array.shape[1], 12)):
                    column = array[:, index]
                    finite = column[np.isfinite(column)]
                    if finite.size:
                        lead_stats.append(
                            {
                                "lead": lead_names[index] if index < len(lead_names) else f"lead_{index + 1}",
                                "min": round(float(finite.min()), 5),
                                "max": round(float(finite.max()), 5),
                                "mean": round(float(finite.mean()), 5),
                            }
                        )
                preview_image = _render_wfdb_signals(
                    array,
                    lead_names=lead_names,
                    artifact_id=artifact_id,
                    derived_dir=derived_dir,
                )
            basic.update(
                {
                    "signal_count": int(getattr(record, "n_sig", 0) or basic.get("signal_count") or 0),
                    "sample_rate_hz": float(getattr(record, "fs", 0) or basic.get("sample_rate_hz") or 0),
                    "sample_count": int(getattr(record, "sig_len", 0) or basic.get("sample_count") or 0),
                }
            )
        except Exception as exc:
            warnings.append(f"wfdb 波形读取失败：{type(exc).__name__}: {str(exc)[:250]}")

    signal_count = basic.get("signal_count")
    sample_rate = basic.get("sample_rate_hz")
    sample_count = basic.get("sample_count")
    duration = None
    if sample_rate and sample_count:
        duration = float(sample_count) / float(sample_rate)
    metadata = {
        **basic,
        "encoding": encoding,
        "lead_names": lead_names,
        "lead_stats": lead_stats,
        "duration_seconds": duration,
        "companion_data_present": path.with_suffix(".dat").is_file(),
    }
    lines = [f"WFDB 心电记录：{basic.get('record_name') or path.stem}"]
    if signal_count:
        lines.append(f"导联/信号数：{signal_count}")
    if sample_rate:
        lines.append(f"采样率：{sample_rate:g} Hz")
    if duration:
        lines.append(f"时长：{duration:.2f} 秒")
    return ParseOutcome(
        kind="ecg",
        subtype="wfdb",
        status=status,
        summary="\n".join(lines),
        metadata=metadata,
        warnings=warnings,
        preview_kind="image" if preview_image else "text",
        preview_ref=preview_image or preview_ref,
        model_image_refs=[preview_image] if preview_image else [],
    )


def _render_wfdb_signals(
    signals: Any,
    *,
    lead_names: List[str],
    artifact_id: str,
    derived_dir: Path,
) -> Optional[str]:
    try:
        import numpy as np  # type: ignore
        from PIL import Image, ImageDraw  # type: ignore

        array = np.asarray(signals)
        if array.ndim != 2 or array.shape[0] < 2 or array.shape[1] < 1:
            return None
        lead_count = min(array.shape[1], 12)
        width = 1400
        row_height = 130
        image = Image.new("RGB", (width, row_height * lead_count + 20), "white")
        draw = ImageDraw.Draw(image)
        for row in range(lead_count):
            top = row * row_height + 10
            middle = top + row_height // 2
            draw.line((100, middle, width - 10, middle), fill=(230, 180, 180), width=1)
            name = lead_names[row] if row < len(lead_names) else f"lead_{row + 1}"
            draw.text((10, top + 5), name, fill="black")
            column = array[:, row].astype("float64")
            finite = column[np.isfinite(column)]
            if finite.size < 2:
                continue
            center = float(np.median(finite))
            spread = float(np.percentile(finite, 99) - np.percentile(finite, 1))
            spread = spread if spread > 1e-9 else 1.0
            count = min(len(column), width - 120)
            indexes = np.linspace(0, len(column) - 1, count).astype(int)
            values = np.nan_to_num(column[indexes], nan=center)
            points = [
                (
                    100 + index,
                    int(middle - max(-1.0, min(1.0, (float(value) - center) / spread)) * 50),
                )
                for index, value in enumerate(values)
            ]
            draw.line(points, fill=(20, 60, 120), width=1)
        derived_dir.mkdir(parents=True, exist_ok=True)
        out_path = derived_dir / f"{artifact_id}_wfdb.png"
        image.save(out_path, format="PNG", optimize=True)
        return _derived_ref(derived_dir, out_path)
    except Exception:
        return None


def _decode_text(content: bytes) -> Tuple[str, str]:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return content.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace"), "utf-8-replace"


def _clean_text(text: str) -> str:
    text = text.replace("\x00", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip()


def _cap(text: str, limit: int) -> str:
    if limit <= 0 or len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n…[已截断]"


def _write_text_preview(derived_dir: Path, artifact_id: str, text: str) -> str:
    derived_dir.mkdir(parents=True, exist_ok=True)
    out_path = derived_dir / f"{artifact_id}.txt"
    out_path.write_text(_cap(text, _PREVIEW_TEXT_CHARS), encoding="utf-8")
    return _derived_ref(derived_dir, out_path)


def _derived_ref(derived_dir: Path, path: Path) -> str:
    """Return absolute path string (PilotDeck VLM needs real files)."""
    return str(Path(path).resolve())


def _local_name(tag: Any) -> str:
    value = str(tag or "")
    if "}" in value:
        value = value.rsplit("}", 1)[-1]
    if ":" in value:
        value = value.rsplit(":", 1)[-1]
    return value


def _first_element_text(root: Any, names: Iterable[str]) -> Optional[str]:
    wanted = {name.lower() for name in names}
    for elem in root.iter():
        if _local_name(getattr(elem, "tag", "")).lower() not in wanted:
            continue
        text = " ".join(part.strip() for part in elem.itertext() if part and part.strip())
        if text:
            return _cap(text, 500)
    return None


def _xml_sections(root: Any) -> List[str]:
    sections: List[str] = []
    for elem in root.iter():
        if _local_name(getattr(elem, "tag", "")).lower() != "section":
            continue
        title = _first_element_text(elem, {"title"})
        if title:
            sections.append(title)
        if len(sections) >= 200:
            break
    return list(dict.fromkeys(sections))


def _xml_narrative(root: Any) -> str:
    parts: List[str] = []
    for elem in root.iter():
        name = _local_name(getattr(elem, "tag", "")).lower()
        if name not in {"title", "text", "value"}:
            continue
        text = " ".join(part.strip() for part in elem.itertext() if part and part.strip())
        if not text and name == "value":
            text = str(elem.get("value") or "")
        text = _clean_text(text)
        if text and text not in parts:
            parts.append(_cap(text, 4_000))
        if sum(len(item) for item in parts) >= _PREVIEW_TEXT_CHARS:
            break
    return "\n".join(parts)


def _looks_like_aecg(root: Any) -> bool:
    root_name = _local_name(getattr(root, "tag", "")).lower()
    if "annotatedecg" in root_name or root_name == "aecg":
        return True
    names = set()
    for index, elem in enumerate(root.iter()):
        names.add(_local_name(getattr(elem, "tag", "")).lower())
        if index >= 5_000:
            break
    return "sequence" in names and ("digits" in names or "increment" in names) and "component" in names


def _frequency_from_increment(value: Any, unit: Any) -> Optional[float]:
    try:
        interval = float(value)
    except (TypeError, ValueError):
        return None
    if interval <= 0:
        return None
    normalized = str(unit or "").lower()
    if normalized in {"s", "sec", "second"}:
        return 1.0 / interval
    if normalized in {"ms", "millisecond"}:
        return 1000.0 / interval
    if normalized in {"us", "microsecond"}:
        return 1_000_000.0 / interval
    return None


def _duration_seconds(value: Any, unit: Any) -> Optional[float]:
    try:
        duration = float(value)
    except (TypeError, ValueError):
        return None
    normalized = str(unit or "s").lower()
    if normalized in {"ms", "millisecond"}:
        return duration / 1000.0
    if normalized in {"us", "microsecond"}:
        return duration / 1_000_000.0
    return duration


def _parse_wfdb_header_line(text: str) -> Dict[str, Any]:
    first_line = next(
        (line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")),
        "",
    )
    tokens = first_line.split()
    result: Dict[str, Any] = {}
    if tokens:
        result["record_name"] = tokens[0].split("/", 1)[0]
    if len(tokens) > 1:
        try:
            result["signal_count"] = int(tokens[1])
        except ValueError:
            pass
    if len(tokens) > 2:
        try:
            result["sample_rate_hz"] = float(tokens[2].split("/", 1)[0])
        except ValueError:
            pass
    if len(tokens) > 3:
        try:
            result["sample_count"] = int(tokens[3])
        except ValueError:
            pass
    return result


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return str(value)


def collect_medical_files(path: Path, *, max_files: int = 64) -> List[Path]:
    """Collect supported medical files from a file or directory."""
    path = path.expanduser().resolve()
    found: List[Path] = []
    if path.is_file():
        return [path]
    if not path.is_dir():
        return []
    for child in sorted(path.rglob("*")):
        if not child.is_file():
            continue
        if child.name.startswith("."):
            continue
        if ".med-tools-derived" in child.parts or child.name == "derived":
            continue
        if child.suffix.lower() in SUPPORTED_SUFFIXES:
            found.append(child)
        if len(found) >= max_files:
            break
    return found


def parse_medical_file(
    path: Path,
    *,
    derived_dir: Path,
    max_text_chars: int = 6_000,
    max_dicom_frames: int = 8,
    max_image_long_side: int = 1600,
) -> ParseOutcome:
    path = path.expanduser().resolve()
    artifact_id = f"art_{uuid.uuid4().hex[:12]}"
    return parse_staged_file(
        path,
        artifact_id=artifact_id,
        filename=path.name,
        derived_dir=derived_dir,
        max_text_chars=max_text_chars,
        max_dicom_frames_per_file=max_dicom_frames,
        max_image_long_side=max_image_long_side,
    )
