"""Deterministic HL7 CDA / WS445 clinical-document extractor for med-tools.

Works with stdlib ``xml.etree.ElementTree`` roots (and lxml roots that expose
the same find / findall / attrib / itertext API). Does not invent lab names
from hospital internal codes: prefer the CD ``code`` on 检验结果代码 when
present; otherwise keep the internal id and mark the name as unavailable.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Tuple

HL7_V3_NS = "urn:hl7-org:v3"
XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"
_NS_PREFIX = "{" + HL7_V3_NS + "}"
_XSI_TYPE = "{" + XSI_NS + "}type"

_LAB_ITEM_CODE_DISPLAY = "检验项目代码"
_LAB_VALUE_DISPLAY = "检验定量结果"
_LAB_RESULT_CODE_DISPLAY = "检验结果代码"
_LAB_SPECIMEN_DISPLAY = "标本类别"
_LAB_STATUS_DISPLAY = "标本状态"
_LAB_UNIT_DISPLAY = "检查定量结果计量单位"
_NOISE_DISPLAYS = frozenset({"", "z", "-", "无", "无备注信息", "***"})
_META_OBS_DISPLAYS = frozenset({"检验方法名称", "检验类别", "操作次数"})


def _local_name(tag: Any) -> str:
    value = str(tag or "")
    if "}" in value:
        value = value.rsplit("}", 1)[-1]
    if ":" in value:
        value = value.rsplit(":", 1)[-1]
    return value


def _apply_ns(path: str, *, with_ns: bool) -> str:
    if not with_ns:
        return path
    parts = path.split("/")
    out: List[str] = []
    for seg in parts:
        if not seg or seg == "." or seg.startswith("@") or "{" in seg:
            out.append(seg)
            continue
        if "[" in seg:
            head, rest = seg.split("[", 1)
            if head:
                head = _NS_PREFIX + head
            out.append(head + "[" + rest)
        else:
            out.append(_NS_PREFIX + seg)
    return "/".join(out)


def _find(elem: Any, path: str) -> Any:
    node = elem.find(_apply_ns(path, with_ns=True))
    if node is not None:
        return node
    return elem.find(_apply_ns(path, with_ns=False))


def _findall(elem: Any, path: str) -> List[Any]:
    nodes = list(elem.findall(_apply_ns(path, with_ns=True)))
    if nodes:
        return nodes
    return list(elem.findall(_apply_ns(path, with_ns=False)))


def _stringify(node: Any) -> Optional[str]:
    if node is None:
        return None
    text = " ".join(part.strip() for part in node.itertext() if part and part.strip())
    return text or None


def _clean(text: Optional[str]) -> Optional[str]:
    if text is None:
        return None
    value = " ".join(str(text).split())
    return value or None


def _xsi_type(value_elem: Any) -> str:
    raw = value_elem.get(_XSI_TYPE) or value_elem.get("type") or ""
    return raw.split(":")[-1].upper() if raw else ""


def _extract_value(value_elem: Any) -> Dict[str, Any]:
    if value_elem is None:
        return {"value_type": None, "value": None, "unit": None}
    vt = _xsi_type(value_elem)
    if vt == "ST":
        return {"value_type": "ST", "value": _stringify(value_elem), "unit": None}
    if vt == "PQ":
        return {
            "value_type": "PQ",
            "value": value_elem.get("value"),
            "unit": value_elem.get("unit"),
        }
    if vt in {"REAL", "INT"}:
        return {
            "value_type": vt,
            "value": value_elem.get("value"),
            "unit": value_elem.get("unit"),
        }
    if vt == "BL":
        raw = value_elem.get("value")
        parsed = None if raw is None else str(raw).strip().lower() == "true"
        return {"value_type": "BL", "value": parsed, "unit": None}
    if vt == "CD":
        return {
            "value_type": "CD",
            "value": value_elem.get("code"),
            "code": value_elem.get("code"),
            "cd_display": value_elem.get("displayName"),
            "unit": None,
        }
    if vt == "TS":
        return {"value_type": "TS", "value": value_elem.get("value"), "unit": None}
    if vt == "IVL_TS":
        low = _find(value_elem, "./low")
        high = _find(value_elem, "./high")
        low_v = low.get("value") if low is not None else None
        high_v = high.get("value") if high is not None else None
        summary = None
        if low_v or high_v:
            summary = f"{low_v or '?'}~{high_v or '?'}"
        return {
            "value_type": "IVL_TS",
            "value": summary,
            "low": low_v,
            "high": high_v,
            "unit": None,
        }
    return {
        "value_type": vt or "UNKNOWN",
        "value": value_elem.get("value") or _stringify(value_elem),
        "unit": value_elem.get("unit"),
    }


def _extract_code(code_elem: Any) -> Dict[str, Optional[str]]:
    if code_elem is None:
        return {
            "code": None,
            "code_display": None,
            "code_system": None,
            "code_system_name": None,
        }
    return {
        "code": code_elem.get("code"),
        "code_display": code_elem.get("displayName"),
        "code_system": code_elem.get("codeSystem"),
        "code_system_name": code_elem.get("codeSystemName"),
    }


def _extract_effective_time(node: Any) -> Optional[str]:
    if node is None:
        return None
    direct = node.get("value")
    if direct:
        return direct
    low = _find(node, "./low")
    high = _find(node, "./high")
    low_v = low.get("value") if low is not None else None
    high_v = high.get("value") if high is not None else None
    if low_v or high_v:
        return f"{low_v or '?'}~{high_v or '?'}"
    return None


def _stringify_value(entry: Dict[str, Any]) -> Optional[str]:
    value = entry.get("value")
    if value is None:
        return None
    if isinstance(value, bool):
        return "是" if value else "否"
    text = _clean(str(value))
    return text


def _is_noise(text: Optional[str]) -> bool:
    return text is None or text.strip() in _NOISE_DISPLAYS


def _parse_observation(obs_elem: Any) -> Dict[str, Any]:
    code_info = _extract_code(_find(obs_elem, "./code"))
    value_info = _extract_value(_find(obs_elem, "./value"))
    related: List[Dict[str, Any]] = []
    for er in _findall(obs_elem, "./entryRelationship"):
        for child in er:
            local = _local_name(child.tag)
            if local == "observation":
                related.append(_parse_observation(child))
            elif local == "organizer":
                related.append(_parse_organizer(child))
    result = {
        "kind": "observation",
        **code_info,
        **value_info,
        "effective_time": _extract_effective_time(_find(obs_elem, "./effectiveTime")),
        "related": related,
    }
    return result


def _flatten_battery(components: List[Dict[str, Any]]) -> Dict[str, Any]:
    numeric_parts: List[str] = []
    unit: Optional[str] = None
    named_values: Dict[str, str] = {}
    for item in components:
        if item.get("kind") != "observation":
            continue
        value = _stringify_value(item)
        item_unit = item.get("unit")
        display = item.get("code_display") or ""
        if value is not None:
            numeric_parts.append(value)
            if item_unit:
                unit = item_unit
            if display and not _is_noise(display):
                named_values[display] = f"{value}{' ' + item_unit if item_unit else ''}".strip()
    cardinal = None
    if len(numeric_parts) >= 2:
        cardinal = "/".join(numeric_parts)
        if unit:
            cardinal = f"{cardinal} {unit}"
    return {"cardinal_value": cardinal, "named_values": named_values or None}


def _flatten_cluster(components: List[Dict[str, Any]]) -> Dict[str, Any]:
    item_code_id: Optional[str] = None
    specimen: Optional[str] = None
    specimen_time: Optional[str] = None
    status: Optional[str] = None
    value: Optional[str] = None
    unit: Optional[str] = None
    result_code: Optional[str] = None
    result_code_display: Optional[str] = None
    effective_time: Optional[str] = None
    name_unavailable = False

    for item in components:
        if item.get("kind") != "observation":
            continue
        display = item.get("code_display") or ""
        if display == _LAB_ITEM_CODE_DISPLAY:
            item_code_id = _stringify_value(item)
            effective_time = item.get("effective_time") or effective_time
            for related in item.get("related") or []:
                related_display = related.get("code_display") or ""
                if related_display == _LAB_SPECIMEN_DISPLAY:
                    specimen = _stringify_value(related)
                    specimen_time = related.get("effective_time") or specimen_time
                elif related_display == _LAB_STATUS_DISPLAY:
                    status = _stringify_value(related)
        elif display == _LAB_VALUE_DISPLAY:
            value = _stringify_value(item)
            unit = item.get("unit") or unit
            for related in item.get("related") or []:
                related_display = related.get("code_display") or ""
                if related_display == _LAB_UNIT_DISPLAY:
                    unit = _stringify_value(related) or unit
        elif display == _LAB_RESULT_CODE_DISPLAY:
            result_code = item.get("code") or item.get("value")
            result_code_display = item.get("cd_display")
            if _is_noise(result_code_display):
                result_code_display = None
            if _is_noise(result_code):
                result_code = None

    item_label = None
    if result_code and not str(result_code).isdigit():
        item_label = str(result_code)
    elif result_code_display and not _is_noise(result_code_display):
        item_label = result_code_display
    elif item_code_id:
        item_label = f"院内项目代码 {item_code_id}"
        name_unavailable = True
    else:
        item_label = "化验项"
        name_unavailable = True

    return {
        "flattened": {
            "item_code_id": item_code_id,
            "item_code": result_code,
            "item_code_display": result_code_display,
            "item_label": item_label,
            "name_unavailable": name_unavailable,
            "value": value,
            "unit": unit,
            "specimen": specimen,
            "specimen_time": specimen_time,
            "status": status,
            "effective_time": effective_time,
        }
    }


def _parse_organizer(org_elem: Any) -> Dict[str, Any]:
    class_code = org_elem.get("classCode") or ""
    code_info = _extract_code(_find(org_elem, "./code"))
    components: List[Dict[str, Any]] = []
    for comp in _findall(org_elem, "./component"):
        for child in comp:
            local = _local_name(child.tag)
            if local == "observation":
                components.append(_parse_observation(child))
            elif local == "organizer":
                components.append(_parse_organizer(child))
    result: Dict[str, Any] = {
        "kind": "organizer",
        "class_code": class_code,
        **code_info,
        "effective_time": _extract_effective_time(_find(org_elem, "./effectiveTime")),
        "components": components,
    }
    if class_code == "BATTERY":
        result.update(_flatten_battery(components))
    elif class_code == "CLUSTER":
        result.update(_flatten_cluster(components))
    return result


def _parse_entry(entry_elem: Any) -> Optional[Dict[str, Any]]:
    for child in entry_elem:
        local = _local_name(child.tag)
        if local == "observation":
            return _parse_observation(child)
        if local == "organizer":
            return _parse_organizer(child)
        if local == "procedure":
            code_info = _extract_code(_find(child, "./code"))
            return {
                "kind": "procedure",
                **code_info,
                "effective_time": _extract_effective_time(_find(child, "./effectiveTime")),
                "related": [],
            }
    return None


def _parse_section(section_elem: Any) -> Dict[str, Any]:
    code_info = _extract_code(_find(section_elem, "./code"))
    title = _stringify(_find(section_elem, "./title"))
    text_node = _find(section_elem, "./text")
    narrative = _stringify(text_node) if text_node is not None else ""
    entries: List[Dict[str, Any]] = []
    for entry in _findall(section_elem, "./entry"):
        parsed = _parse_entry(entry)
        if parsed:
            entries.append(parsed)
    return {
        "code": code_info.get("code"),
        "code_display": code_info.get("code_display"),
        "title": title,
        "text": narrative or "",
        "entries": entries,
    }


def _parse_patient(root: Any) -> Dict[str, Any]:
    patient: Dict[str, Any] = {}
    name = _stringify(_find(root, ".//patient/name"))
    if name:
        patient["name"] = name
    gender = _find(root, ".//patient/administrativeGenderCode")
    if gender is not None:
        patient["gender"] = gender.get("displayName") or gender.get("code")
    birth = _find(root, ".//patient/birthTime")
    if birth is not None and birth.get("value"):
        patient["birth_time"] = birth.get("value")
    return patient


def _parse_document_meta(root: Any) -> Dict[str, Any]:
    title = _stringify(_find(root, "./title"))
    code = _extract_code(_find(root, "./code"))
    effective = _extract_effective_time(_find(root, "./effectiveTime"))
    return {
        "title": title,
        "doc_code": code.get("code"),
        "doc_code_display": code.get("code_display"),
        "effective_time": effective,
    }


def parse_cda_root(root: Any) -> Dict[str, Any]:
    """Parse a ClinicalDocument root into structured dict + renderable fields."""
    meta = _parse_document_meta(root)
    patient = _parse_patient(root)
    sections = [_parse_section(sec) for sec in _findall(root, ".//component/section")]
    lab_count = 0
    pair_count = 0
    for section in sections:
        for entry in section.get("entries") or []:
            if entry.get("kind") == "organizer" and entry.get("class_code") == "CLUSTER":
                lab_count += 1
            elif entry.get("kind") == "observation":
                display = entry.get("code_display") or ""
                if display and display not in _META_OBS_DISPLAYS and _stringify_value(entry):
                    pair_count += 1
    return {
        "title": meta.get("title"),
        "doc_code": meta.get("doc_code"),
        "doc_code_display": meta.get("doc_code_display"),
        "effective_time": meta.get("effective_time"),
        "patient": patient,
        "sections": sections,
        "stats": {
            "section_count": len(sections),
            "lab_item_count": lab_count,
            "observation_pair_count": pair_count,
        },
    }


def _render_lab_lines(entries: Iterable[Dict[str, Any]]) -> List[str]:
    lines: List[str] = []
    method: Optional[str] = None
    category: Optional[str] = None
    labs: List[Dict[str, Any]] = []
    other: List[str] = []
    for entry in entries:
        kind = entry.get("kind")
        if kind == "observation":
            display = entry.get("code_display") or ""
            if display == "检验方法名称":
                method = _stringify_value(entry)
            elif display == "检验类别":
                category = _stringify_value(entry)
            elif display not in _META_OBS_DISPLAYS:
                rendered = _render_observation_line(entry)
                if rendered:
                    other.append(rendered)
        elif kind == "organizer" and entry.get("class_code") == "CLUSTER":
            labs.append(entry.get("flattened") or {})
        elif kind == "organizer" and entry.get("class_code") == "BATTERY":
            display = entry.get("code_display") or "复合值"
            cardinal = entry.get("cardinal_value")
            if cardinal:
                other.append(f"{display} = {cardinal}")
    if method:
        header = f"检验方法: {method}"
        if category and category not in ("无", None, ""):
            header += f" ({category})"
        lines.append(header)
    if labs:
        lines.append("化验结果:")
        for lab in labs:
            label = lab.get("item_label") or lab.get("item_code") or lab.get("item_code_id") or "?"
            value = lab.get("value") if lab.get("value") is not None else "?"
            unit = lab.get("unit") or ""
            extras: List[str] = []
            if lab.get("specimen"):
                extras.append(str(lab["specimen"]))
            if lab.get("status"):
                extras.append(str(lab["status"]))
            if lab.get("name_unavailable"):
                extras.append("项目名称未提供")
            extra = f" ({', '.join(extras)})" if extras else ""
            lines.append(
                f"  · {label} = {value}{' ' + unit if unit else ''}{extra}".rstrip()
            )
    lines.extend(other)
    return lines


def _render_observation_line(entry: Dict[str, Any]) -> Optional[str]:
    display = entry.get("code_display") or entry.get("code")
    if not display or display in _META_OBS_DISPLAYS:
        return None
    value = _stringify_value(entry)
    if value is None and entry.get("value_type") == "CD":
        value = entry.get("cd_display") or entry.get("code")
    if value is None or _is_noise(value):
        # Keep narrative-like observations that only have related children.
        related_bits = [
            _render_observation_line(related)
            for related in entry.get("related") or []
            if related.get("kind") == "observation"
        ]
        related_bits = [bit for bit in related_bits if bit]
        if related_bits:
            return f"{display}: " + "；".join(related_bits)
        return None
    unit = entry.get("unit") or ""
    line = f"{display} = {value}{' ' + unit if unit else ''}".strip()
    related_bits = []
    for related in entry.get("related") or []:
        if related.get("kind") != "observation":
            continue
        rendered = _render_observation_line(related)
        if rendered:
            related_bits.append(rendered)
    if related_bits:
        line += "；" + "；".join(related_bits)
    return line


def _section_has_labs(section: Dict[str, Any]) -> bool:
    return any(
        entry.get("kind") == "organizer" and entry.get("class_code") == "CLUSTER"
        for entry in section.get("entries") or []
    )


def render_cda_text(parsed: Dict[str, Any], *, max_chars: int) -> str:
    lines: List[str] = []
    title = parsed.get("title") or parsed.get("doc_code_display") or "CDA 文档"
    lines.append(f"─── 【{title}】 ───")
    patient = parsed.get("patient") or {}
    demo: List[str] = []
    if patient.get("name"):
        demo.append(f"姓名: {patient['name']}")
    if patient.get("gender"):
        demo.append(str(patient["gender"]))
    if patient.get("birth_time"):
        demo.append(f"出生: {patient['birth_time']}")
    if demo:
        lines.append("患者信息: " + "  ".join(demo))
    if parsed.get("effective_time"):
        lines.append(f"文档时间: {parsed['effective_time']}")

    for section in parsed.get("sections") or []:
        title_text = section.get("title") or section.get("code_display") or section.get("code") or "章节"
        if _section_has_labs(section):
            content = _render_lab_lines(section.get("entries") or [])
        else:
            content = []
            for entry in section.get("entries") or []:
                if entry.get("kind") == "observation":
                    rendered = _render_observation_line(entry)
                    if rendered:
                        content.append(rendered)
                elif entry.get("kind") == "organizer" and entry.get("class_code") == "BATTERY":
                    display = entry.get("code_display") or "复合值"
                    cardinal = entry.get("cardinal_value")
                    if cardinal:
                        content.append(f"{display} = {cardinal}")
                elif entry.get("kind") == "procedure":
                    display = entry.get("code_display") or entry.get("code") or "手术"
                    content.append(f"手术/操作: {display}")
            narrative = _clean(section.get("text") or "")
            if narrative and narrative not in content:
                content.append(narrative)
        real = [line for line in content if line and str(line).strip()]
        if not real:
            continue
        lines.append(f"## {title_text}")
        lines.extend(f"  {line}" for line in real)

    out = "\n".join(lines).strip()
    if len(out) > max_chars:
        out = out[:max_chars] + f"\n\n… [已截断，超 {max_chars} 字符]"
    return out


def summarize_cda_root(root: Any, *, max_chars: int) -> Tuple[str, Dict[str, Any], List[str]]:
    """Return (summary_text, metadata, warnings) for a ClinicalDocument root."""
    parsed = parse_cda_root(root)
    summary = render_cda_text(parsed, max_chars=max_chars)
    stats = parsed.get("stats") or {}
    warnings: List[str] = []
    unavailable = 0
    for section in parsed.get("sections") or []:
        for entry in section.get("entries") or []:
            flat = entry.get("flattened") or {}
            if flat.get("name_unavailable"):
                unavailable += 1
    if unavailable:
        warnings.append(
            f"有 {unavailable} 项化验仅有院内项目代码，未提供可读项目名称；"
            "已按代码原样输出，未猜测项目名。"
        )
    metadata = {
        "cda_structured": True,
        "title": parsed.get("title"),
        "doc_code": parsed.get("doc_code"),
        "doc_code_display": parsed.get("doc_code_display"),
        "section_count": stats.get("section_count", 0),
        "lab_item_count": stats.get("lab_item_count", 0),
        "observation_pair_count": stats.get("observation_pair_count", 0),
        "name_unavailable_count": unavailable,
        "patient": parsed.get("patient") or {},
    }
    return summary, metadata, warnings
