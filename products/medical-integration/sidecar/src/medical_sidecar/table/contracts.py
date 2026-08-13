"""Table normalization and CSV export with formula-injection protection."""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from html.parser import HTMLParser
import io
import json
import re
from typing import Any, Iterable, Sequence


@dataclass(frozen=True)
class TableBudget:
    max_columns: int = 256
    max_rows: int = 10_000
    max_cell_chars: int = 32_768
    max_input_chars: int = 4_000_000


@dataclass
class TableDocument:
    title: str
    columns: list[str]
    rows: list[list[str]]
    source_format: str
    warnings: list[str] = field(default_factory=list)
    raw_text: str = ""
    schema_version: int = 1

    def to_dict(self, *, include_raw: bool = True) -> dict[str, Any]:
        body: dict[str, Any] = {
            "schema_version": self.schema_version,
            "title": self.title,
            "columns": list(self.columns),
            "rows": [list(row) for row in self.rows],
            "format": self.source_format,
            "warnings": list(self.warnings),
        }
        if include_raw:
            body["raw_text"] = self.raw_text
        return body


def parse_table_output(text: str, *, budget: TableBudget = TableBudget()) -> TableDocument:
    """Parse model output as JSON, Markdown, or HTML and normalize its width."""

    raw = text or ""
    if len(raw) > budget.max_input_chars:
        raise ValueError("table input exceeds configured character budget")
    cleaned = _strip_think(raw)
    if not cleaned:
        return TableDocument("", [], [], "empty", ["model returned no table content"], raw)

    for candidate in _json_candidates(cleaned):
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        coerced = _coerce_json_table(parsed)
        if coerced is not None:
            title, columns, rows = coerced
            columns, rows = normalize_table(columns, rows, budget=budget)
            if columns or rows:
                return TableDocument(title, columns, rows, "json", raw_text=raw)

    markdown = _parse_markdown(cleaned)
    if markdown is not None:
        columns, rows = normalize_table(*markdown, budget=budget)
        return TableDocument(
            "",
            columns,
            rows,
            "markdown",
            ["JSON parse failed; used Markdown table fallback"],
            raw,
        )

    html = _parse_html(cleaned)
    if html is not None:
        columns, rows = normalize_table(*html, budget=budget)
        return TableDocument(
            "",
            columns,
            rows,
            "html",
            ["JSON parse failed; used HTML table fallback"],
            raw,
        )

    fallback_columns, fallback_rows = normalize_table(
        ["原始输出"],
        [[cleaned]],
        budget=budget,
    )
    return TableDocument(
        "",
        fallback_columns,
        fallback_rows,
        "raw",
        ["could not parse a table; manual review is required"],
        raw,
    )


def normalize_table(
    columns: Sequence[Any],
    rows: Iterable[Sequence[Any]],
    *,
    budget: TableBudget = TableBudget(),
) -> tuple[list[str], list[list[str]]]:
    raw_rows = [list(row) for row in rows]
    if len(raw_rows) > budget.max_rows:
        raise ValueError(f"table exceeds {budget.max_rows} rows")
    width = max([len(columns), *(len(row) for row in raw_rows)], default=0)
    if width > budget.max_columns:
        raise ValueError(f"table exceeds {budget.max_columns} columns")

    normalized_columns = [_cell(value, budget) for value in columns]
    while len(normalized_columns) < width:
        normalized_columns.append(f"列{len(normalized_columns) + 1}")
    normalized_rows: list[list[str]] = []
    for row in raw_rows:
        normalized = [_cell(value, budget) for value in row]
        normalized.extend("" for _ in range(width - len(normalized)))
        normalized_rows.append(normalized[:width])
    return normalized_columns, normalized_rows


def safe_csv_cell(value: Any) -> str:
    """Neutralize spreadsheet formulas while preserving the displayed text."""

    cell = "" if value is None else str(value)
    candidate = cell.lstrip(" ")
    if candidate.startswith(("=", "+", "-", "@", "\t", "\r", "\n")):
        return "'" + cell
    return cell


def table_to_safe_csv(
    columns: Sequence[Any],
    rows: Iterable[Sequence[Any]],
    *,
    include_utf8_bom: bool = False,
) -> str:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\r\n")
    if columns:
        writer.writerow([safe_csv_cell(value) for value in columns])
    for row in rows:
        writer.writerow([safe_csv_cell(value) for value in row])
    result = buffer.getvalue()
    return ("\ufeff" + result) if include_utf8_bom else result


def _strip_think(text: str) -> str:
    cleaned = re.sub(
        r"<\s*think\s*>[\s\S]*?<\s*/\s*think\s*>",
        "",
        text,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"<\s*think\s*>[\s\S]*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"<\s*/?\s*think\s*>", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def _json_candidates(text: str) -> list[str]:
    candidates = [text]
    candidates.extend(
        match.group(1).strip()
        for match in re.finditer(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
        if match.group(1).strip()
    )
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        end = text.rfind(closer)
        if 0 <= start < end:
            candidates.append(text[start : end + 1])
    # Preserve order while avoiding repeated large parse attempts.
    return list(dict.fromkeys(candidates))


def _coerce_json_table(obj: Any) -> tuple[str, list[str], list[list[str]]] | None:
    title = ""
    columns: list[str] = []
    data: Any = obj
    if isinstance(obj, dict):
        title = str(obj.get("title") or "").strip()
        header = obj.get("columns", obj.get("headers", obj.get("header", [])))
        if isinstance(header, list):
            columns = [str(value) for value in header]
        data = obj.get("rows", obj.get("data"))
        if data is None:
            return (title, columns, []) if columns else None
    if not isinstance(data, list):
        return None
    if data and all(isinstance(row, dict) for row in data):
        if not columns:
            for row in data:
                for key in row:
                    name = str(key)
                    if name not in columns:
                        columns.append(name)
        rows = [[row.get(column, "") for column in columns] for row in data]
        return title, columns, rows
    rows = [list(row) if isinstance(row, list) else [row] for row in data]
    return title, columns, rows


def _parse_markdown(text: str) -> tuple[list[str], list[list[str]]] | None:
    lines = [line.strip() for line in text.splitlines() if line.count("|") >= 2]
    if len(lines) < 2:
        return None

    def split(line: str) -> list[str]:
        value = line.strip().strip("|")
        return [part.strip() for part in value.split("|")]

    separator = -1
    for index, line in enumerate(lines):
        cells = split(line)
        if cells and all(re.fullmatch(r":?-{2,}:?", cell.replace(" ", "")) for cell in cells):
            separator = index
            break
    if separator <= 0:
        return None
    return split(lines[separator - 1]), [split(line) for line in lines[separator + 1 :]]


class _FirstTableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_table = False
        self.finished = False
        self.in_cell = False
        self.cell_is_header = False
        self.cell_parts: list[str] = []
        self.current_row: list[str] = []
        self.current_headers: list[bool] = []
        self.rows: list[tuple[list[str], list[bool]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "table" and not self.in_table and not self.finished:
            self.in_table = True
        elif self.in_table and tag in {"td", "th"}:
            self.in_cell = True
            self.cell_is_header = tag == "th"
            self.cell_parts = []
        elif self.in_cell and tag == "br":
            self.cell_parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.in_cell:
            self.cell_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.in_table and tag in {"td", "th"} and self.in_cell:
            self.current_row.append("".join(self.cell_parts).strip())
            self.current_headers.append(self.cell_is_header)
            self.in_cell = False
        elif self.in_table and tag == "tr":
            if self.current_row:
                self.rows.append((self.current_row, self.current_headers))
            self.current_row = []
            self.current_headers = []
        elif self.in_table and tag == "table":
            self.in_table = False
            self.finished = True


def _parse_html(text: str) -> tuple[list[str], list[list[str]]] | None:
    if "<table" not in text.lower():
        return None
    parser = _FirstTableParser()
    parser.feed(text)
    if not parser.rows:
        return None
    first, header_flags = parser.rows[0]
    if any(header_flags):
        return first, [row for row, _ in parser.rows[1:]]
    return first, [row for row, _ in parser.rows[1:]]


def _cell(value: Any, budget: TableBudget) -> str:
    if value is None:
        result = ""
    elif isinstance(value, (dict, list)):
        result = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    else:
        result = str(value)
    if len(result) > budget.max_cell_chars:
        raise ValueError(f"table cell exceeds {budget.max_cell_chars} characters")
    return result

