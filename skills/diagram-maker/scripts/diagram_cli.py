#!/usr/bin/env python3
"""Offline declarative diagram renderer for PilotDeck."""

from __future__ import annotations

import argparse
import html
import json
import math
import os
import re
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


COLORS = {
    "neutral": "#e2e8f0",
    "input": "#bfdbfe",
    "process": "#c7d2fe",
    "decision": "#fde68a",
    "storage": "#99f6e4",
    "external": "#fde68a",
    "risk": "#fecaca",
}
ARCHITECTURE_KINDS = {"service", "database", "queue", "external", "risk"}
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
NODE_TOKEN = re.compile(
    r'(?P<id>[A-Za-z_][A-Za-z0-9_-]*)\s*(?:'
    r'\["(?P<quoted>[^"]+)"\]|\[(?P<square>[^\]]+)\]|\((?P<round>[^)]+)\)|\{\{(?P<database>[^}]+)\}\}'
    r'|\{(?P<decision>[^}]+)\}'
    r")?"
)
# Accepts both Mermaid edge-label spellings: `A -->|text| B` and `A -- text --> B`.
EDGE_LINE = re.compile(
    r"^\s*(?P<left>.+?)\s*"
    r"(?:(?:--|-\.|==)\s*(?P<midlabel>[^\[\]|>]+?)\s*)?"
    r"(?P<arrow>-->|---|-\.->|\.->|==>)\s*"
    r"(?:\|(?P<label>[^|]+)\|\s*)?"
    r"(?P<right>.+?)\s*$"
)
SUBGRAPH_LINE = re.compile(r"^\s*subgraph\s+(?P<id>\S+)(?:\s+\[(?P<label>[^\]]+)\])?\s*$", re.I)
FLOW_HEADER = re.compile(r"^\s*(?:flowchart|graph)\s+(?P<direction>TD|TB|LR|RL)\s*$", re.I)


class DiagramError(ValueError):
    """A user-facing declarative diagram error."""


@dataclass
class Node:
    id: str
    label: str
    kind: str = "process"
    group: str | None = None


@dataclass
class Edge:
    source: str
    target: str
    label: str = ""
    style: str = "solid"


@dataclass
class Group:
    id: str
    label: str
    node_ids: list[str] = field(default_factory=list)


@dataclass
class Diagram:
    title: str = ""
    direction: str = "LR"
    theme: str = "clean"
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    groups: list[Group] = field(default_factory=list)


def clean_text(value: Any, *, limit: int = 240) -> str:
    text = re.sub(r"<br\s*/?>", " ", str(value or ""), flags=re.I)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def parse_node_token(token: str) -> tuple[str, str, str]:
    match = NODE_TOKEN.fullmatch(token.strip())
    if not match:
        raise DiagramError(f"不支持的节点语法：{token.strip()}")
    node_id = match.group("id")
    shapes = ("quoted", "square", "round", "database", "decision")
    label = next((match.group(name) for name in shapes if match.group(name)), node_id)
    if match.group("database"):
        kind = "database"
    elif match.group("decision"):
        kind = "decision"
    else:
        kind = "process"
    return node_id, clean_text(label), kind


def has_unclosed_bracket(text: str) -> bool:
    return any(text.count(opener) > text.count(closer) for opener, closer in (("[", "]"), ("(", ")"), ("{", "}")))


def logical_mermaid_lines(text: str) -> list[str]:
    """Rejoins labels that authors wrapped across physical lines inside brackets."""
    lines: list[str] = []
    buffer = ""
    joined = 0
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if buffer:
            buffer = f"{buffer} {line}".strip()
            joined += 1
        elif line:
            buffer = line
            joined = 0
        else:
            continue
        if has_unclosed_bracket(buffer) and joined < 4:
            continue
        lines.append(buffer)
        buffer = ""
    if buffer:
        lines.append(buffer)
    return lines


def parse_mermaid(text: str, *, title: str = "", theme: str = "clean") -> Diagram:
    diagram = Diagram(title=title, theme=theme)
    nodes: dict[str, Node] = {}
    groups: dict[str, Group] = {}
    current_group: str | None = None
    saw_header = False

    def remember(token: str) -> Node:
        node_id, label, kind = parse_node_token(token)
        if node_id not in nodes:
            nodes[node_id] = Node(node_id, label, kind, current_group)
        else:
            if label != node_id:
                nodes[node_id].label = label
            if kind != "process":
                nodes[node_id].kind = kind
        if current_group:
            group = groups[current_group]
            if node_id not in group.node_ids:
                group.node_ids.append(node_id)
            nodes[node_id].group = current_group
        return nodes[node_id]

    for line in logical_mermaid_lines(text):
        if line.startswith("%%"):
            continue
        header = FLOW_HEADER.fullmatch(line)
        if header:
            if saw_header:
                raise DiagramError("一个文件只能包含一张 flowchart")
            saw_header = True
            direction = header.group("direction").upper()
            diagram.direction = "TB" if direction in {"TD", "TB"} else direction
            continue
        if not saw_header and re.fullmatch(r"[A-Za-z]+Diagram", line, re.I):
            raise DiagramError("只支持 Mermaid flowchart / graph，不支持其它图类型")
        subgraph = SUBGRAPH_LINE.fullmatch(line)
        if subgraph:
            group_id = subgraph.group("id")
            if not IDENTIFIER.fullmatch(group_id):
                raise DiagramError(f"无效的分组标识：{group_id}")
            groups[group_id] = Group(group_id, clean_text(subgraph.group("label") or group_id))
            current_group = group_id
            continue
        if line.lower() == "end":
            current_group = None
            continue
        edge = EDGE_LINE.fullmatch(line)
        if edge:
            source = remember(edge.group("left"))
            target = remember(edge.group("right"))
            diagram.edges.append(
                Edge(
                    source.id,
                    target.id,
                    clean_text(edge.group("label") or edge.group("midlabel")),
                    "dashed" if "." in edge.group("arrow") else "solid",
                )
            )
            continue
        remember(line)

    if not saw_header:
        raise DiagramError("Mermaid 输入必须以 flowchart TD/TB/LR/RL 开头")
    diagram.nodes = list(nodes.values())
    diagram.groups = list(groups.values())
    validate_diagram(diagram)
    return diagram


def parse_body(body: str, *, title: str = "", theme: str = "clean", direction: str = "LR") -> Diagram:
    labels = [clean_text(value) for value in re.split(r"\s*(?:→|->|=>|＞)\s*", body) if clean_text(value)]
    if len(labels) < 2:
        raise DiagramError("--body 至少需要两个用 → 或 -> 连接的节点")
    nodes = [Node(f"n{index + 1}", label, "input" if index == 0 else "process") for index, label in enumerate(labels)]
    edges = [Edge(nodes[index].id, nodes[index + 1].id) for index in range(len(nodes) - 1)]
    diagram = Diagram(
        title=title,
        direction="TB" if direction in {"TD", "TB"} else direction,
        theme=theme,
        nodes=nodes,
        edges=edges,
    )
    validate_diagram(diagram)
    return diagram


def parse_spec(payload: dict[str, Any], *, title: str = "", theme: str = "") -> Diagram:
    raw_nodes = payload.get("nodes")
    raw_edges = payload.get("edges", [])
    raw_groups = payload.get("groups", [])
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise DiagramError("spec.nodes 必须是非空数组")
    if not isinstance(raw_edges, list) or not isinstance(raw_groups, list):
        raise DiagramError("spec.edges 和 spec.groups 必须是数组")

    nodes: list[Node] = []
    for item in raw_nodes:
        if not isinstance(item, dict):
            raise DiagramError("spec.nodes 的每一项必须是对象")
        node_id = clean_text(item.get("id"))
        if not IDENTIFIER.fullmatch(node_id):
            raise DiagramError(f"无效的节点标识：{node_id or '<empty>'}")
        kind = clean_text(item.get("kind") or "process").lower()
        if kind not in {"neutral", "input", "process", "decision", "storage", *ARCHITECTURE_KINDS}:
            raise DiagramError(f"不支持的节点 kind：{kind}")
        nodes.append(Node(node_id, clean_text(item.get("label") or node_id), kind, clean_text(item.get("group")) or None))

    edges: list[Edge] = []
    for item in raw_edges:
        if not isinstance(item, dict):
            raise DiagramError("spec.edges 的每一项必须是对象")
        edges.append(
            Edge(
                clean_text(item.get("from") or item.get("source")),
                clean_text(item.get("to") or item.get("target")),
                clean_text(item.get("label")),
                "dashed" if item.get("style") == "dashed" else "solid",
            )
        )

    groups: list[Group] = []
    for item in raw_groups:
        if not isinstance(item, dict):
            raise DiagramError("spec.groups 的每一项必须是对象")
        group_id = clean_text(item.get("id"))
        if not IDENTIFIER.fullmatch(group_id):
            raise DiagramError(f"无效的分组标识：{group_id or '<empty>'}")
        listed = item.get("nodes", [])
        if not isinstance(listed, list):
            raise DiagramError(f"分组 {group_id} 的 nodes 必须是数组")
        groups.append(Group(group_id, clean_text(item.get("label") or group_id), [clean_text(value) for value in listed]))

    direction = clean_text(payload.get("direction") or payload.get("layout") or "LR").upper()
    diagram = Diagram(
        title=title or clean_text(payload.get("title")),
        direction="TB" if direction in {"TD", "TB"} else direction,
        theme=theme or clean_text(payload.get("theme") or "clean"),
        nodes=nodes,
        edges=edges,
        groups=groups,
    )
    validate_diagram(diagram)
    return diagram


def validate_diagram(diagram: Diagram) -> None:
    if diagram.direction not in {"LR", "RL", "TB"}:
        raise DiagramError("direction 只支持 LR、RL、TB/TD")
    if diagram.theme not in {"clean", "architecture"}:
        raise DiagramError("theme 只支持 clean 或 architecture")
    if not diagram.nodes:
        raise DiagramError("图中至少需要一个节点")
    if len(diagram.nodes) > 80 or len(diagram.edges) > 160:
        raise DiagramError("图示过密：最多 80 个节点和 160 条边")
    ids = [node.id for node in diagram.nodes]
    if len(ids) != len(set(ids)):
        raise DiagramError("节点 id 不能重复")
    known = set(ids)
    for edge in diagram.edges:
        if edge.source not in known or edge.target not in known:
            raise DiagramError(f"边引用了不存在的节点：{edge.source} -> {edge.target}")
    known_groups = {group.id for group in diagram.groups}
    for node in diagram.nodes:
        if node.group and node.group not in known_groups:
            raise DiagramError(f"节点 {node.id} 引用了不存在的分组 {node.group}")
    for group in diagram.groups:
        for node_id in group.node_ids:
            if node_id not in known:
                raise DiagramError(f"分组 {group.id} 引用了不存在的节点 {node_id}")


def ranks_for(diagram: Diagram) -> dict[str, int]:
    incoming: dict[str, int] = {node.id: 0 for node in diagram.nodes}
    outgoing: dict[str, list[str]] = {node.id: [] for node in diagram.nodes}
    for edge in diagram.edges:
        if edge.source == edge.target:
            continue
        incoming[edge.target] += 1
        outgoing[edge.source].append(edge.target)
    queue = [node.id for node in diagram.nodes if incoming[node.id] == 0]
    rank = {node.id: 0 for node in diagram.nodes}
    visited = 0
    while queue:
        current = queue.pop(0)
        visited += 1
        for target in outgoing[current]:
            rank[target] = max(rank[target], rank[current] + 1)
            incoming[target] -= 1
            if incoming[target] == 0:
                queue.append(target)
    if visited < len(diagram.nodes):
        # Cycles remain readable by placing unresolved nodes after their declaration predecessor.
        max_rank = max(rank.values(), default=0)
        for node in diagram.nodes:
            if incoming[node.id] > 0:
                max_rank += 1
                rank[node.id] = max_rank
    if diagram.direction == "RL":
        maximum = max(rank.values(), default=0)
        rank = {node_id: maximum - value for node_id, value in rank.items()}
    return rank


def text_width(text: str) -> float:
    """Approximate label width in CJK glyph units, which drive the 184px node box."""
    return sum(1 if ord(char) > 127 else 0.55 for char in text)


def wrapped_lines(label: str, maximum: int = 11) -> list[str]:
    if text_width(label) <= maximum:
        return [label]
    lines: list[str] = []
    current = ""
    for char in label:
        current += char
        width = text_width(current)
        if width >= maximum:
            lines.append(current)
            current = ""
    if current:
        lines.append(current)
    return lines[:3]


def node_lines(node: Node) -> list[str]:
    """A rhombus is narrowest near its vertices, so decisions wrap tighter than boxes."""
    return wrapped_lines(node.label, 9 if node.kind == "decision" else 11)


def node_box_height(node: Node, base_height: float) -> float:
    height = base_height + max(0, len(node_lines(node)) - 2) * 18
    return height + 32 if node.kind == "decision" else height


def layout(diagram: Diagram) -> tuple[dict[str, tuple[float, float, float, float]], float, float]:
    ranks = ranks_for(diagram)
    buckets: dict[int, list[Node]] = {}
    for node in diagram.nodes:
        buckets.setdefault(ranks[node.id], []).append(node)
    node_w, base_h = 184.0, 72.0
    primary_gap, secondary_gap = 110.0, 48.0
    margin_x, margin_y = 64.0, 92.0 if diagram.title else 58.0
    positions: dict[str, tuple[float, float, float, float]] = {}
    maximum_secondary = max((len(items) for items in buckets.values()), default=1)

    for rank_index in sorted(buckets):
        items = buckets[rank_index]
        for item_index, node in enumerate(items):
            node_h = node_box_height(node, base_h)
            if diagram.direction in {"LR", "RL"}:
                x = margin_x + rank_index * (node_w + primary_gap)
                y = margin_y + item_index * (base_h + secondary_gap)
            else:
                x = margin_x + item_index * (node_w + secondary_gap)
                y = margin_y + rank_index * (base_h + primary_gap)
            positions[node.id] = (x, y, node_w, node_h)

    max_x = max((x + w for x, _, w, _ in positions.values()), default=600) + margin_x
    max_y = max((y + h for _, y, _, h in positions.values()), default=300) + 64
    if diagram.direction in {"LR", "RL"}:
        max_y = max(max_y, margin_y + maximum_secondary * (base_h + secondary_gap))
    return positions, max(480.0, max_x), max(280.0, max_y)


def node_fill(node: Node) -> str:
    kind = node.kind
    if kind in {"service"}:
        kind = "process"
    elif kind in {"database", "queue"}:
        kind = "storage"
    return COLORS.get(kind, COLORS["process"])


def edge_path(source: tuple[float, float, float, float], target: tuple[float, float, float, float], direction: str) -> str:
    sx, sy, sw, sh = source
    tx, ty, tw, th = target
    if direction in {"LR", "RL"}:
        forward = tx >= sx
        start_x = sx + sw if forward else sx
        end_x = tx if forward else tx + tw
        start_y = sy + sh / 2
        end_y = ty + th / 2
        middle = (start_x + end_x) / 2
        return f"M {start_x:.1f} {start_y:.1f} L {middle:.1f} {start_y:.1f} L {middle:.1f} {end_y:.1f} L {end_x:.1f} {end_y:.1f}"
    start_x = sx + sw / 2
    end_x = tx + tw / 2
    start_y = sy + sh
    end_y = ty
    middle = (start_y + end_y) / 2
    return f"M {start_x:.1f} {start_y:.1f} L {start_x:.1f} {middle:.1f} L {end_x:.1f} {middle:.1f} L {end_x:.1f} {end_y:.1f}"


def render_svg(diagram: Diagram) -> str:
    positions, width, height = layout(diagram)
    pieces = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{math.ceil(width)}" height="{math.ceil(height)}" '
        f'viewBox="0 0 {math.ceil(width)} {math.ceil(height)}" role="img" aria-labelledby="diagram-title diagram-desc">',
        f'<title id="diagram-title">{html.escape(diagram.title or "Diagram")}</title>',
        '<desc id="diagram-desc">PilotDeck offline declarative diagram</desc>',
        "<defs>",
        '<marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">',
        '<path d="M0,0 L0,6 L9,3 z" fill="#64748b"/></marker>',
        "</defs>",
        '<rect width="100%" height="100%" fill="#f8fafc"/>',
    ]
    if diagram.title:
        pieces.append(
            f'<text x="64" y="44" font-family="ui-sans-serif,system-ui,sans-serif" font-size="22" '
            f'font-weight="700" fill="#172033">{html.escape(diagram.title)}</text>'
        )

    for group in diagram.groups:
        node_ids = set(group.node_ids)
        node_ids.update(node.id for node in diagram.nodes if node.group == group.id)
        boxes = [positions[node_id] for node_id in node_ids if node_id in positions]
        if not boxes:
            continue
        min_x = min(box[0] for box in boxes) - 20
        min_y = min(box[1] for box in boxes) - 30
        max_x = max(box[0] + box[2] for box in boxes) + 20
        max_y = max(box[1] + box[3] for box in boxes) + 20
        pieces.append(
            f'<rect x="{min_x:.1f}" y="{min_y:.1f}" width="{max_x-min_x:.1f}" height="{max_y-min_y:.1f}" '
            'rx="12" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="7 5"/>'
        )
        pieces.append(
            f'<text x="{min_x+12:.1f}" y="{min_y+20:.1f}" font-family="ui-sans-serif,system-ui,sans-serif" '
            f'font-size="12" font-weight="600" fill="#5b6475">{html.escape(group.label)}</text>'
        )

    for edge in diagram.edges:
        source = positions[edge.source]
        target = positions[edge.target]
        dash = ' stroke-dasharray="6 4"' if edge.style == "dashed" else ""
        pieces.append(
            f'<path d="{edge_path(source, target, diagram.direction)}" fill="none" stroke="#64748b" '
            f'stroke-width="1.8" marker-end="url(#arrow)"{dash}/>'
        )
        if edge.label:
            sx, sy, sw, sh = source
            tx, ty, tw, th = target
            label_x = (sx + sw / 2 + tx + tw / 2) / 2
            label_y = (sy + sh / 2 + ty + th / 2) / 2 - 7
            pieces.append(
                f'<text x="{label_x:.1f}" y="{label_y:.1f}" text-anchor="middle" '
                'font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" fill="#5b6475" '
                'stroke="#f8fafc" stroke-width="3" paint-order="stroke">'
                f'{html.escape(edge.label)}</text>'
            )

    for node in diagram.nodes:
        x, y, width_value, height_value = positions[node.id]
        if diagram.theme == "architecture" and node.kind == "database":
            pieces.append(
                f'<path d="M {x:.1f} {y+12:.1f} C {x:.1f} {y-4:.1f} {x+width_value:.1f} {y-4:.1f} '
                f'{x+width_value:.1f} {y+12:.1f} V {y+height_value-12:.1f} C {x+width_value:.1f} '
                f'{y+height_value+4:.1f} {x:.1f} {y+height_value+4:.1f} {x:.1f} {y+height_value-12:.1f} Z" '
                f'fill="{node_fill(node)}" stroke="#64748b" stroke-width="1.5"/>'
            )
            pieces.append(
                f'<ellipse cx="{x+width_value/2:.1f}" cy="{y+12:.1f}" rx="{width_value/2:.1f}" ry="12" '
                'fill="none" stroke="#64748b" stroke-width="1.5"/>'
            )
        elif node.kind == "decision":
            center_x = x + width_value / 2
            center_y = y + height_value / 2
            pieces.append(
                f'<path d="M {center_x:.1f} {y:.1f} L {x+width_value:.1f} {center_y:.1f} '
                f'L {center_x:.1f} {y+height_value:.1f} L {x:.1f} {center_y:.1f} Z" '
                f'fill="{node_fill(node)}" stroke="#64748b" stroke-width="1.5"/>'
            )
        else:
            dash = ' stroke-dasharray="6 4"' if diagram.theme == "architecture" and node.kind == "external" else ""
            pieces.append(
                f'<rect x="{x:.1f}" y="{y:.1f}" width="{width_value:.1f}" height="{height_value:.1f}" '
                f'rx="12" fill="{node_fill(node)}" stroke="#64748b" stroke-width="1.5"{dash}/>'
            )
        lines = node_lines(node)
        first_y = y + height_value / 2 - (len(lines) - 1) * 9 + 5
        for index, line in enumerate(lines):
            pieces.append(
                f'<text x="{x+width_value/2:.1f}" y="{first_y+index*18:.1f}" text-anchor="middle" '
                'font-family="ui-sans-serif,system-ui,sans-serif" font-size="14" font-weight="600" '
                f'fill="#172033">{html.escape(line)}</text>'
            )
    pieces.append("</svg>")
    return "\n".join(pieces) + "\n"


def render_html(svg: str, title: str) -> str:
    return (
        "<!doctype html>\n"
        '<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" '
        'content="width=device-width,initial-scale=1"/><title>'
        + html.escape(title or "Diagram")
        + "</title><style>body{margin:0;background:#f8fafc}main{max-width:1200px;margin:24px auto;padding:0 20px}"
        "svg{display:block;width:100%;height:auto}</style></head><body><main>\n"
        + svg
        + "</main></body></html>\n"
    )


def audit_svg(svg: str) -> None:
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise DiagramError(f"生成的 SVG 无效：{exc}") from exc
    if not root.tag.endswith("svg"):
        raise DiagramError("生成结果不是 SVG")
    lowered = svg.lower()
    if (
        "<script" in lowered
        or "javascript:" in lowered
        or re.search(r"(?:href|src)\s*=\s*[\"']https?://", lowered)
    ):
        raise DiagramError("SVG 包含脚本或外部资源")


def atomic_write(path: Path, content: str, *, force: bool) -> None:
    path = path.resolve()
    if path.exists() and not force:
        raise DiagramError(f"输出已存在；如需覆盖请加 --force：{path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
        os.replace(temporary_name, path)
    except BaseException:
        Path(temporary_name).unlink(missing_ok=True)
        raise


def make_command(args: argparse.Namespace) -> dict[str, Any]:
    sources = sum(bool(value) for value in (args.body, args.markdown, args.spec))
    if sources != 1:
        raise DiagramError("请且只提供一种输入：--body、--markdown 或 --spec")
    if args.markdown:
        source = Path(args.markdown).read_text(encoding="utf-8")
        diagram = parse_mermaid(source, title=args.title or "", theme=args.theme)
    elif args.spec:
        payload = json.loads(Path(args.spec).read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise DiagramError("spec 顶层必须是 JSON 对象")
        diagram = parse_spec(payload, title=args.title or "", theme=args.theme if args.theme_explicit else "")
    else:
        diagram = parse_body(args.body, title=args.title or "", theme=args.theme, direction=args.direction)

    svg = render_svg(diagram)
    audit_svg(svg)
    output = Path(args.out).resolve()
    output_format = args.format or ("html" if output.suffix.lower() in {".html", ".htm"} else "svg")
    expected_suffixes = {".svg"} if output_format == "svg" else {".html", ".htm"}
    if output.suffix.lower() not in expected_suffixes:
        raise DiagramError(f"--format {output_format} 与输出扩展名不一致：{output.name}")
    content = svg if output_format == "svg" else render_html(svg, diagram.title)
    atomic_write(output, content, force=args.force)
    return {
        "status": "ok",
        "output": str(output),
        "format": output_format,
        "nodes": len(diagram.nodes),
        "edges": len(diagram.edges),
        "direction": diagram.direction,
        "theme": diagram.theme,
    }


def self_test_command() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="pilotdeck-diagram-self-test-") as temporary:
        out = Path(temporary) / "flow.svg"
        diagram = parse_body("输入 → 处理 → 输出", title="自检")
        svg = render_svg(diagram)
        audit_svg(svg)
        atomic_write(out, svg, force=False)
        return {"status": "ok", "self_test": True, "nodes": 3, "edges": 2}


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="diagram.sh")
    subcommands = root.add_subparsers(dest="command", required=True)
    make = subcommands.add_parser("make", help="Create an offline SVG diagram")
    make.add_argument("--title")
    make.add_argument("--body")
    make.add_argument("--markdown")
    make.add_argument("--spec")
    make.add_argument("--theme", choices=["clean", "architecture"], default="clean")
    make.add_argument("--direction", choices=["LR", "RL", "TB", "TD"], default="LR")
    make.add_argument("--format", choices=["svg", "html"])
    make.add_argument("--out", required=True)
    make.add_argument("--force", action="store_true")
    make.set_defaults(theme_explicit="--theme" in os.sys.argv)
    subcommands.add_parser("self-test", help="Run a dependency-free smoke test")
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        result = self_test_command() if args.command == "self-test" else make_command(args)
    except (DiagramError, OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "error", "code": "invalid-diagram-input", "error": str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
