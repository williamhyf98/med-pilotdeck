#!/usr/bin/env python3
"""Offline declarative diagram renderer for PilotDeck."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import re
import tempfile
import xml.etree.ElementTree as ET

import design_theme
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
    # Design theme is a separate axis from `theme` (clean/architecture):
    # it only supplies colours and font roles, never geometry.
    design_theme: dict[str, Any] | None = None
    # True when the caller asked for a direction (Mermaid header, spec
    # `direction`, or `--direction`). Only the default LR may be rotated
    # automatically to keep the diagram inside the report column.
    direction_explicit: bool = False


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
            diagram.direction_explicit = True
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


def parse_body(body: str, *, title: str = "", theme: str = "clean", direction: str | None = None) -> Diagram:
    labels = [clean_text(value) for value in re.split(r"\s*(?:→|->|=>|＞)\s*", body) if clean_text(value)]
    if len(labels) < 2:
        raise DiagramError("--body 至少需要两个用 → 或 -> 连接的节点")
    nodes = [Node(f"n{index + 1}", label, "input" if index == 0 else "process") for index, label in enumerate(labels)]
    edges = [Edge(nodes[index].id, nodes[index + 1].id) for index in range(len(nodes) - 1)]
    diagram = Diagram(
        title=title,
        direction="TB" if direction in {"TD", "TB"} else (direction or "LR"),
        theme=theme,
        nodes=nodes,
        edges=edges,
        direction_explicit=direction is not None,
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

    raw_direction = payload.get("direction") or payload.get("layout")
    direction = clean_text(raw_direction or "LR").upper()
    diagram = Diagram(
        title=title or clean_text(payload.get("title")),
        direction="TB" if direction in {"TD", "TB"} else direction,
        theme=theme or clean_text(payload.get("theme") or "clean"),
        nodes=nodes,
        edges=edges,
        groups=groups,
        direction_explicit=bool(clean_text(raw_direction)),
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


NODE_W = 184.0
BASE_H = 72.0
PRIMARY_GAP = 110.0
SECONDARY_GAP = 48.0
NODE_FONT_SIZE = 14.0
DECISION_PAD = 14.0
# Keep below the report column so an embedded diagram is not silently shrunk.
REPORT_WIDTH_BUDGET = 1200.0


def node_width(node: Node) -> float:
    """Width a node needs before its label touches the shape outline.

    A rhombus is only full width at its waist, so a two-line decision label
    used to spill over the slanted edges at the fixed 184px box. Grow the box
    until the widest line fits inside the band the text actually occupies.
    """
    if node.kind != "decision":
        return NODE_W
    lines = node_lines(node)
    text_px = max(text_width(line) for line in lines) * NODE_FONT_SIZE
    height = node_box_height(node, BASE_H)
    band = (len(lines) - 1) * 9 + 7  # half the rendered height of the text block
    slim = max(1.0 - band / (height / 2), 0.35)
    return max(NODE_W, math.ceil((text_px + 2 * DECISION_PAD) / slim))


def layout(diagram: Diagram) -> tuple[dict[str, tuple[float, float, float, float]], float, float]:
    ranks = ranks_for(diagram)
    buckets: dict[int, list[Node]] = {}
    for node in diagram.nodes:
        buckets.setdefault(ranks[node.id], []).append(node)
    margin_x, margin_y = 64.0, 92.0 if diagram.title else 58.0
    positions: dict[str, tuple[float, float, float, float]] = {}
    ordered = sorted(buckets)
    maximum_secondary = max((len(items) for items in buckets.values()), default=1)

    if diagram.direction in {"LR", "RL"}:
        # A column is as wide as its widest node so ranks stay aligned.
        columns: dict[int, float] = {
            rank_index: max(node_width(node) for node in buckets[rank_index])
            for rank_index in ordered
        }
        offsets: dict[int, float] = {}
        cursor = margin_x
        for rank_index in ordered:
            offsets[rank_index] = cursor
            cursor += columns[rank_index] + PRIMARY_GAP
        for rank_index in ordered:
            for item_index, node in enumerate(buckets[rank_index]):
                width_value = node_width(node)
                x = offsets[rank_index] + (columns[rank_index] - width_value) / 2
                y = margin_y + item_index * (BASE_H + SECONDARY_GAP)
                positions[node.id] = (x, y, width_value, node_box_height(node, BASE_H))
    else:
        # Rows follow the tallest node so a decision never overlaps the next row.
        rows: dict[int, float] = {}
        cursor = margin_y
        for rank_index in ordered:
            rows[rank_index] = cursor
            cursor += max(node_box_height(node, BASE_H) for node in buckets[rank_index]) + PRIMARY_GAP
        for rank_index in ordered:
            cursor_x = margin_x
            for node in buckets[rank_index]:
                width_value = node_width(node)
                positions[node.id] = (
                    cursor_x, rows[rank_index], width_value, node_box_height(node, BASE_H))
                cursor_x += width_value + SECONDARY_GAP

    max_x = max((x + w for x, _, w, _ in positions.values()), default=600) + margin_x
    max_y = max((y + h for _, y, _, h in positions.values()), default=300) + 64
    if diagram.direction in {"LR", "RL"}:
        max_y = max(max_y, margin_y + maximum_secondary * (BASE_H + SECONDARY_GAP))
    return positions, max(480.0, max_x), max(280.0, max_y)


def rotate_if_too_wide(diagram: Diagram) -> str | None:
    """Rotate a plain LR chain that would not fit the report column.

    Only the implicit default is rotated: an explicit `direction`, `--direction`
    or Mermaid header is always honoured, and branched graphs stay as asked
    (they would only get wide in the other axis too).
    """
    if diagram.direction_explicit or diagram.direction not in {"LR", "RL"}:
        return None
    ranks = ranks_for(diagram)
    per_rank: dict[int, int] = {}
    for rank_index in ranks.values():
        per_rank[rank_index] = per_rank.get(rank_index, 0) + 1
    if max(per_rank.values(), default=1) > 1:
        return None
    _, width, _ = layout(diagram)
    if width <= REPORT_WIDTH_BUDGET:
        return None
    diagram.direction = "TB"
    return (
        f"横向排布需要 {math.ceil(width)}px，超过报告正文 {int(REPORT_WIDTH_BUDGET)}px 预算，"
        "已自动改为纵向（TB）；要强制横排请显式传 --direction LR。"
    )


# Palette used when no `--design-theme` is given. These are the historical
# literals; keeping them here means the default SVG stays byte identical.
DEFAULT_PALETTE: dict[str, Any] = {
    "id": None,
    "label": None,
    "background": "#f8fafc",
    "title": "#172033",
    "node_text": "#172033",
    "node_stroke": "#64748b",
    "edge": "#64748b",
    "arrow": "#64748b",
    "group_stroke": "#94a3b8",
    "group_label": "#5b6475",
    "edge_label": "#5b6475",
    "halo": "#f8fafc",
    "body_font": "ui-sans-serif,system-ui,sans-serif",
    "heading_font": "ui-sans-serif,system-ui,sans-serif",
    "fill": dict(COLORS),
}


def palette_for(diagram: Diagram) -> dict[str, Any]:
    return diagram.design_theme or DEFAULT_PALETTE


def node_fill(node: Node, palette: dict[str, Any] | None = None) -> str:
    kind = node.kind
    if kind in {"service"}:
        kind = "process"
    elif kind in {"database", "queue"}:
        kind = "storage"
    fills = (palette or DEFAULT_PALETTE)["fill"]
    return fills.get(kind, fills["process"])


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


EDGE_LABEL_SIZE = 12.0


def _overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float], pad: float = 0.0) -> bool:
    return not (a[2] + pad <= b[0] or b[2] + pad <= a[0]
                or a[3] + pad <= b[1] or b[3] + pad <= a[1])


def edge_label_box(
    x: float, y: float, anchor: str, text: str
) -> tuple[float, float, float, float]:
    width_value = text_width(text) * EDGE_LABEL_SIZE
    left = x - width_value / 2 if anchor == "middle" else (x - width_value if anchor == "end" else x)
    return (left, y - EDGE_LABEL_SIZE, left + width_value, y + 3.0)


def edge_label_placement(
    source: tuple[float, float, float, float],
    target: tuple[float, float, float, float],
    direction: str,
    text: str,
    occupied: list[tuple[float, float, float, float]],
) -> tuple[float, float, str, tuple[float, float, float, float]]:
    """Keep an edge label off the connector and off every node.

    An orthogonal connector runs along a vertical (LR) or horizontal (TB)
    middle segment; centring the text on that segment draws it straight over
    the stroke, which reads as a broken line. Try beside the segment first,
    then fall back to the knee above it.
    """
    sx, sy, sw, sh = source
    tx, ty, tw, th = target
    start_y, end_y = sy + sh / 2, ty + th / 2
    forward = tx >= sx
    start_x = sx + sw if forward else sx
    end_x = tx if forward else tx + tw
    if direction in {"LR", "RL"}:
        if abs(start_y - end_y) < 0.5:
            candidates = [((start_x + end_x) / 2, start_y - 8, "middle")]
        else:
            middle = (start_x + end_x) / 2
            mid_y = (start_y + end_y) / 2 + 4
            candidates = [
                (middle - 8, mid_y, "end"),
                (middle + 8, mid_y, "start"),
                ((start_x + end_x) / 2, min(start_y, end_y) - 8, "middle"),
            ]
    else:
        start_x = sx + sw / 2
        end_x = tx + tw / 2
        top, bottom = sy + sh, ty
        middle_y = (top + bottom) / 2
        if abs(start_x - end_x) < 0.5:
            candidates = [(start_x, middle_y - 6, "middle")]
        else:
            candidates = [
                ((start_x + end_x) / 2, middle_y - 6, "middle"),
                ((start_x + end_x) / 2, middle_y + 15, "middle"),
            ]
    for x, y, anchor in candidates:
        box = edge_label_box(x, y, anchor, text)
        if not any(_overlaps(box, other, 2.0) for other in occupied):
            return x, y, anchor, box
    x, y, anchor = candidates[0]
    return x, y, anchor, edge_label_box(x, y, anchor, text)


def render_svg(diagram: Diagram) -> str:
    positions, width, height = layout(diagram)
    p = palette_for(diagram)
    body_font = p["body_font"]
    heading_font = p["heading_font"]
    pieces = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{math.ceil(width)}" height="{math.ceil(height)}" '
        f'viewBox="0 0 {math.ceil(width)} {math.ceil(height)}" role="img" aria-labelledby="diagram-title diagram-desc">',
        f'<title id="diagram-title">{html.escape(diagram.title or "Diagram")}</title>',
        '<desc id="diagram-desc">PilotDeck offline declarative diagram</desc>',
        "<defs>",
        '<marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">',
        f'<path d="M0,0 L0,6 L9,3 z" fill="{p["arrow"]}"/></marker>',
        "</defs>",
        f'<rect width="100%" height="100%" fill="{p["background"]}"/>',
    ]
    if diagram.title:
        pieces.append(
            f'<text x="64" y="44" font-family="{heading_font}" font-size="22" '
            f'font-weight="700" fill="{p["title"]}">{html.escape(diagram.title)}</text>'
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
            f'rx="12" fill="none" stroke="{p["group_stroke"]}" stroke-width="1.5" stroke-dasharray="7 5"/>'
        )
        pieces.append(
            f'<text x="{min_x+12:.1f}" y="{min_y+20:.1f}" font-family="{heading_font}" '
            f'font-size="12" font-weight="600" fill="{p["group_label"]}">{html.escape(group.label)}</text>'
        )

    occupied: list[tuple[float, float, float, float]] = [
        (x - 4, y - 4, x + w + 4, y + h + 4) for x, y, w, h in positions.values()
    ]

    for edge in diagram.edges:
        source = positions[edge.source]
        target = positions[edge.target]
        dash = ' stroke-dasharray="6 4"' if edge.style == "dashed" else ""
        pieces.append(
            f'<path d="{edge_path(source, target, diagram.direction)}" fill="none" stroke="{p["edge"]}" '
            f'stroke-width="1.8" marker-end="url(#arrow)"{dash}/>'
        )
        if edge.label:
            label_x, label_y, label_anchor, label_box = edge_label_placement(
                source, target, diagram.direction, edge.label, occupied)
            occupied.append(label_box)
            pieces.append(
                f'<text x="{label_x:.1f}" y="{label_y:.1f}" text-anchor="{label_anchor}" '
                f'font-family="{body_font}" font-size="12" fill="{p["edge_label"]}" '
                f'stroke="{p["halo"]}" stroke-width="3" paint-order="stroke">'
                f'{html.escape(edge.label)}</text>'
            )

    for node in diagram.nodes:
        x, y, width_value, height_value = positions[node.id]
        fill = node_fill(node, p)
        if diagram.theme == "architecture" and node.kind == "database":
            pieces.append(
                f'<path d="M {x:.1f} {y+12:.1f} C {x:.1f} {y-4:.1f} {x+width_value:.1f} {y-4:.1f} '
                f'{x+width_value:.1f} {y+12:.1f} V {y+height_value-12:.1f} C {x+width_value:.1f} '
                f'{y+height_value+4:.1f} {x:.1f} {y+height_value+4:.1f} {x:.1f} {y+height_value-12:.1f} Z" '
                f'fill="{fill}" stroke="{p["node_stroke"]}" stroke-width="1.5"/>'
            )
            pieces.append(
                f'<ellipse cx="{x+width_value/2:.1f}" cy="{y+12:.1f}" rx="{width_value/2:.1f}" ry="12" '
                f'fill="none" stroke="{p["node_stroke"]}" stroke-width="1.5"/>'
            )
        elif node.kind == "decision":
            center_x = x + width_value / 2
            center_y = y + height_value / 2
            pieces.append(
                f'<path d="M {center_x:.1f} {y:.1f} L {x+width_value:.1f} {center_y:.1f} '
                f'L {center_x:.1f} {y+height_value:.1f} L {x:.1f} {center_y:.1f} Z" '
                f'fill="{fill}" stroke="{p["node_stroke"]}" stroke-width="1.5"/>'
            )
        else:
            dash = ' stroke-dasharray="6 4"' if diagram.theme == "architecture" and node.kind == "external" else ""
            pieces.append(
                f'<rect x="{x:.1f}" y="{y:.1f}" width="{width_value:.1f}" height="{height_value:.1f}" '
                f'rx="12" fill="{fill}" stroke="{p["node_stroke"]}" stroke-width="1.5"{dash}/>'
            )
        lines = node_lines(node)
        first_y = y + height_value / 2 - (len(lines) - 1) * 9 + 5
        for index, line in enumerate(lines):
            pieces.append(
                f'<text x="{x+width_value/2:.1f}" y="{first_y+index*18:.1f}" text-anchor="middle" '
                f'font-family="{body_font}" font-size="14" font-weight="600" '
                f'fill="{p["node_text"]}">{html.escape(line)}</text>'
            )
    pieces.append("</svg>")
    return "\n".join(pieces) + "\n"


def render_html(svg: str, title: str, background: str = "#f8fafc") -> str:
    return (
        "<!doctype html>\n"
        '<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" '
        'content="width=device-width,initial-scale=1"/><title>'
        + html.escape(title or "Diagram")
        + f"</title><style>body{{margin:0;background:{background}}}main{{max-width:1200px;margin:24px auto;padding:0 20px}}"
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


DEFAULT_REPORT_WIDTH = 1200.0
PERCENT_RE = re.compile(r"^\s*\d+(\.\d+)?\s*%\s*$")
SVG_BLOCK_RE = re.compile(r"<svg\b[\s\S]*?</svg>", re.IGNORECASE)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _as_number(value: str | None) -> float | None:
    if value is None:
        return None
    text = value.strip()
    if PERCENT_RE.match(text):
        return None
    if text.lower().endswith("px"):
        text = text[:-2].strip()
    try:
        return float(text)
    except ValueError:
        return None


def truncated_labels(diagram: "Diagram") -> list[dict[str, Any]]:
    """Labels longer than the three-line cap silently lose text in the SVG."""
    result: list[dict[str, Any]] = []
    for node in diagram.nodes:
        width_limit = 9 if node.kind == "decision" else 11
        lines = node_lines(node)
        rendered = text_width("".join(lines))
        if rendered + 1e-9 < text_width(node.label):
            result.append({
                "node": node.id,
                "label": node.label,
                "lines": lines,
                "lineWidth": width_limit,
            })
    return result


def _text_extent(text: str, font_size: float, anchor: str, x: float) -> tuple[float, float]:
    width = text_width(text) * font_size
    if anchor == "middle":
        return x - width / 2, x + width / 2
    if anchor == "end":
        return x - width, x
    return x, x + width


def audit_geometry(svg: str, *, max_width: float = DEFAULT_REPORT_WIDTH) -> dict[str, Any]:
    """Deterministic geometry checks: no browser, no rendering, no pixel comparison."""
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise DiagramError(f"待检查的 SVG 无效：{exc}") from exc
    if _local_name(root.tag) != "svg":
        raise DiagramError("待检查的文件不是 SVG")

    issues: list[dict[str, Any]] = []
    viewbox: list[float] | None = None
    raw_viewbox = root.get("viewBox")
    if raw_viewbox:
        parts = [part for part in re.split(r"[\s,]+", raw_viewbox.strip()) if part]
        if len(parts) == 4:
            try:
                viewbox = [float(part) for part in parts]
            except ValueError:
                viewbox = None
    declared_width = _as_number(root.get("width"))
    declared_height = _as_number(root.get("height"))
    if viewbox is None:
        issues.append({
            "severity": "error",
            "code": "missing-viewbox",
            "message": "SVG 缺少可解析的 viewBox；缩放插入文档时会错位。",
            "detail": {"viewBox": raw_viewbox},
        })
        viewbox = [0.0, 0.0, declared_width or 0.0, declared_height or 0.0]
    origin_x, origin_y, box_width, box_height = viewbox

    nodes: list[dict[str, float]] = []
    texts: list[dict[str, Any]] = []
    for element in root.iter():
        name = _local_name(element.tag)
        if name == "rect":
            x = _as_number(element.get("x")) or 0.0
            y = _as_number(element.get("y")) or 0.0
            width = _as_number(element.get("width"))
            height = _as_number(element.get("height"))
            if width is None or height is None:
                # Background rects use width="100%" and are intentionally skipped.
                continue
            nodes.append({"x": x, "y": y, "width": width, "height": height,
                          "right": x + width, "bottom": y + height})
        elif name == "text":
            content = "".join(element.itertext())
            if not content.strip():
                continue
            x = _as_number(element.get("x"))
            y = _as_number(element.get("y"))
            if x is None or y is None:
                continue
            font_size = _as_number(element.get("font-size")) or 14.0
            left, right = _text_extent(content.strip(), font_size, element.get("text-anchor", ""), x)
            texts.append({"text": content.strip(), "x": x, "y": y,
                          "left": left, "right": right})

    tolerance = 1.0
    right_edge = origin_x + box_width
    bottom_edge = origin_y + box_height
    max_right = max((item["right"] for item in nodes), default=origin_x)
    max_bottom = max((item["bottom"] for item in nodes), default=origin_y)
    for item in nodes:
        if item["x"] < origin_x - tolerance or item["y"] < origin_y - tolerance:
            issues.append({
                "severity": "error",
                "code": "node-outside-viewbox",
                "message": f"节点起点超出画布：({item['x']:.0f}, {item['y']:.0f})。",
                "detail": item,
            })
        elif item["right"] > right_edge + tolerance or item["bottom"] > bottom_edge + tolerance:
            issues.append({
                "severity": "error",
                "code": "node-outside-viewbox",
                "message": (
                    f"节点超出画布：右 {item['right']:.0f}px / 下 {item['bottom']:.0f}px，"
                    f"画布 {right_edge:.0f}×{bottom_edge:.0f}px。"
                ),
                "detail": item,
            })
    for item in texts:
        if (item["left"] < origin_x - tolerance or item["right"] > right_edge + tolerance
                or item["y"] > bottom_edge + tolerance):
            issues.append({
                "severity": "warning",
                "code": "text-outside-viewbox",
                "message": (
                    f"文字可能被裁切：{item['text'][:24]!r} 估算横向范围 "
                    f"{item['left']:.0f}–{item['right']:.0f}px，画布宽 {box_width:.0f}px。"
                ),
                "detail": {"text": item["text"][:80]},
            })

    if box_width > max_width + 0.5:
        issues.append({
            "severity": "warning",
            "code": "too-wide-for-report-width",
            "message": (
                f"图示宽 {box_width:.0f}px，超过报告常用内容宽度 {max_width:.0f}px；"
                "嵌入 Word/HTML 时会被整体缩小，正文可能变得难读。"
            ),
            "detail": {"width": box_width, "maxWidth": max_width},
        })

    errors = sum(1 for item in issues if item["severity"] == "error")
    warnings = sum(1 for item in issues if item["severity"] == "warning")
    return {
        "status": "error" if errors else ("warning" if warnings else "ok"),
        "format": "svg",
        "viewBox": {"x": origin_x, "y": origin_y, "width": box_width, "height": box_height},
        "declared": {"width": declared_width, "height": declared_height},
        "counts": {
            "nodes": len(nodes),
            "texts": len(texts),
            "errors": errors,
            "warnings": warnings,
        },
        "geometry": {"maxRight": max_right, "maxBottom": max_bottom},
        "budget": {"maxWidth": max_width, "width": box_width,
                   "exceeded": box_width > max_width + 0.5},
        "issues": issues,
        "visual_acceptance": "not_performed",
    }


def load_svg(path: Path) -> str:
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix.lower() in {".html", ".htm"}:
        match = SVG_BLOCK_RE.search(text)
        if not match:
            raise DiagramError(f"HTML 中没有内嵌 SVG：{path}")
        return match.group(0)
    return text


def svg_texts(svg: str) -> list[str]:
    """Every non-empty <text> payload, used to compare an artifact with its source."""
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise DiagramError(f"待检查的 SVG 无效：{exc}") from exc
    contents: list[str] = []
    for element in root.iter():
        if _local_name(element.tag) != "text":
            continue
        content = "".join(element.itertext()).strip()
        if content:
            contents.append(content)
    return contents


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


def build_diagram(args: argparse.Namespace) -> "Diagram":
    sources = sum(bool(value) for value in (args.body, args.markdown, args.spec))
    if sources != 1:
        raise DiagramError("请且只提供一种输入：--body、--markdown 或 --spec")
    payload: dict[str, Any] | None = None
    if args.markdown:
        source = Path(args.markdown).read_text(encoding="utf-8")
        diagram = parse_mermaid(source, title=args.title or "", theme=args.theme)
    elif args.spec:
        payload = json.loads(Path(args.spec).read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise DiagramError("spec 顶层必须是 JSON 对象")
        diagram = parse_spec(
            payload,
            title=args.title or "",
            theme=args.theme if args.theme_explicit else "",
        )
    else:
        diagram = parse_body(
            args.body, title=args.title or "", theme=args.theme, direction=args.direction)
    if getattr(args, "direction", None):
        diagram.direction = "TB" if args.direction in {"TD", "TB"} else args.direction
        diagram.direction_explicit = True
    attach_design_theme(diagram, getattr(args, "design_theme", None), payload)
    return diagram


def attach_design_theme(
    diagram: "Diagram",
    cli_name: str | None,
    payload: dict[str, Any] | None,
) -> None:
    """Resolve `--design-theme` (CLI wins) or a spec-level `designTheme`."""
    name = (cli_name or "").strip() or None
    if name is None and payload is not None:
        raw = payload.get("designTheme") or payload.get("design_theme")
        if raw is not None:
            name = str(raw).strip() or None
    if not name:
        return
    try:
        diagram.design_theme = design_theme.palette(name)
    except design_theme.DesignThemeError as exc:
        available = "、".join(design_theme.available_names()) or "（未找到主题数据）"
        raise DiagramError(
            f"未知的设计主题：{name}；可选：{available}。细节：{exc}"
        ) from exc


def make_command(args: argparse.Namespace) -> dict[str, Any]:
    diagram = build_diagram(args)
    direction_note = rotate_if_too_wide(diagram)
    svg = render_svg(diagram)
    audit_svg(svg)
    output = Path(args.out).resolve()
    output_format = args.format or ("html" if output.suffix.lower() in {".html", ".htm"} else "svg")
    expected_suffixes = {".svg"} if output_format == "svg" else {".html", ".htm"}
    if output.suffix.lower() not in expected_suffixes:
        raise DiagramError(f"--format {output_format} 与输出扩展名不一致：{output.name}")
    content = svg if output_format == "svg" else render_html(
        svg, diagram.title, palette_for(diagram)["background"])
    atomic_write(output, content, force=args.force)
    warnings = [
        {
            "severity": "error",
            "code": "label-truncated",
            "message": (
                f"节点 {item['node']} 的文案超过三行上限，渲染时会丢字："
                f"{item['label'][:40]!r}；请缩短文案或拆成两个节点。"
            ),
        }
        for item in truncated_labels(diagram)
    ]
    return {
        "status": "ok",
        "output": str(output),
        "format": output_format,
        "nodes": len(diagram.nodes),
        "edges": len(diagram.edges),
        "direction": diagram.direction,
        "theme": diagram.theme,
        **({"directionNote": direction_note} if direction_note else {}),
        **(
            {
                "designTheme": {
                    "id": diagram.design_theme["id"],
                    "label": diagram.design_theme["label"],
                }
            }
            if diagram.design_theme
            else {}
        ),
        "warnings": warnings,
        "visual_acceptance": "not_performed",
    }


def audit_command(args: argparse.Namespace) -> dict[str, Any]:
    """Audit an existing SVG/HTML diagram, or the diagram described by a source."""
    diagram: Diagram | None = None
    svg: str
    if args.input:
        input_path = Path(args.input).expanduser().resolve()
        if not input_path.is_file():
            raise DiagramError(f"待检查文件不存在：{input_path}")
        svg = load_svg(input_path)
        source = str(input_path)
    else:
        source = "rendered-from-source"
    if args.input is None or any((args.body, args.markdown, args.spec)):
        diagram = build_diagram(args)
        rotate_if_too_wide(diagram)
        if args.input is None:
            svg = render_svg(diagram)

    report = audit_geometry(svg, max_width=args.max_width)
    report["input"] = source
    if diagram is not None:
        report["direction"] = diagram.direction
    if args.input:
        report["sha256"] = hashlib.sha256(
            Path(args.input).expanduser().resolve().read_bytes()
        ).hexdigest()
    labels: list[str] = []
    truncated: list[dict[str, Any]] = []
    if diagram is not None:
        labels = [node.label for node in diagram.nodes if node.label.strip()]
        truncated = truncated_labels(diagram)
        for item in truncated:
            report["issues"].append({
                "severity": "error",
                "code": "label-truncated",
                "message": (
                    f"节点 {item['node']} 的文案超过三行上限，渲染时会丢字："
                    f"{item['label'][:40]!r}；请缩短文案或拆成两个节点。"
                ),
                "detail": {"node": item["node"], "label": item["label"]},
            })
        if args.input is not None:
            rendered_texts = set(svg_texts(svg))
            missing = [
                line
                for node in diagram.nodes
                for line in node_lines(node)
                if line not in rendered_texts
            ]
            if missing:
                report["issues"].append({
                    "severity": "error",
                    "code": "label-not-rendered",
                    "message": (
                        f"成品里找不到来源中的 {len(missing)} 行文案，SVG 很可能是在改稿前生成的："
                        f"{missing[0][:30]!r}"
                    ),
                    "detail": {"missing": missing[:10]},
                })
    report["content"] = {"labels": labels, "truncated": truncated}
    errors = sum(1 for item in report["issues"] if item["severity"] == "error")
    warnings = sum(1 for item in report["issues"] if item["severity"] == "warning")
    report["counts"]["errors"] = errors
    report["counts"]["warnings"] = warnings
    report["status"] = "error" if errors else ("warning" if warnings else "ok")
    report["timing_ms"] = {}
    return report


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
    make.add_argument(
        "--design-theme",
        help="配色主题（ID / 中文名 / 别名）；与 --theme 的布局选择互不影响",
    )
    make.add_argument("--direction", choices=["LR", "RL", "TB", "TD"],
                      help="排布方向；不传时横向，超宽的单链会自动转成 TB")
    make.add_argument("--format", choices=["svg", "html"])
    make.add_argument("--out", required=True)
    make.add_argument("--force", action="store_true")
    make.set_defaults(theme_explicit="--theme" in os.sys.argv)
    audit = subcommands.add_parser(
        "audit", help="Deterministic geometry check for an SVG/HTML diagram")
    audit.add_argument("--input", help="Existing .svg or .html file to check")
    audit.add_argument("--title")
    audit.add_argument("--body")
    audit.add_argument("--markdown")
    audit.add_argument("--spec")
    audit.add_argument("--theme", choices=["clean", "architecture"], default="clean")
    audit.add_argument(
        "--design-theme",
        help="配色主题（ID / 中文名 / 别名）；与 --theme 的布局选择互不影响",
    )
    audit.add_argument("--direction", choices=["LR", "RL", "TB", "TD"],
                       help="排布方向；与 make 的默认一致（超宽单链自动转 TB）")
    audit.add_argument("--max-width", type=float, default=DEFAULT_REPORT_WIDTH,
                       help="Report content width budget in px (default: 1200)")
    audit.add_argument("--report", help="Write the JSON report here instead of stdout")
    audit.set_defaults(theme_explicit="--theme" in os.sys.argv)
    subcommands.add_parser("self-test", help="Run a dependency-free smoke test")
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "self-test":
            result = self_test_command()
        elif args.command == "audit":
            result = audit_command(args)
        else:
            result = make_command(args)
    except (DiagramError, OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "error", "code": "invalid-diagram-input", "error": str(exc)}, ensure_ascii=False))
        return 2
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    report_path = getattr(args, "report", None)
    if report_path:
        Path(report_path).expanduser().write_text(text, encoding="utf-8")
        print(json.dumps({"status": result["status"], "report": report_path}, ensure_ascii=False))
    else:
        print(json.dumps(result, ensure_ascii=False))
    return 1 if result.get("status") == "error" else 0


if __name__ == "__main__":
    raise SystemExit(main())
