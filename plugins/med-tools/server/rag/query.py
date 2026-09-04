"""Query helpers: vector search with lexical fallback."""

from __future__ import annotations

import hashlib
import time
from collections import Counter
from typing import Any

from .embedding_client import EmbeddingError, embed_texts, get_embedding_config
from .store import RagStore, get_default_store
from .presentation import attach_display_assets, build_interleave_context, summarize_image_match

_IMAGE_TOPIC_FILTER_WARNING = (
    "image topic filter removed generic image results; no strong topic-matched "
    "image evidence remained"
)


def rag_status(*, validate: bool = False, store: RagStore | None = None) -> dict[str, Any]:
    store = store or get_default_store()
    status = store.status(validate=validate)
    emb = get_embedding_config()
    status["embedding_service"] = {
        "api_base": emb["api_base"],
        "endpoint": emb["endpoint"],
        "model": emb["model"],
        "expected_dim": emb["expected_dim"],
    }
    status["plugin_data_root"] = str(store.manifest.root)
    return status


def query_rag(
    *,
    query: str,
    top_k: int | None = None,
    min_score: float | None = None,
    prefer_lexical: bool = False,
    store: RagStore | None = None,
) -> dict[str, Any]:
    """Return evidence chunks. Generation stays with the PilotDeck main model."""

    started = time.perf_counter()
    store = store or get_default_store()
    manifest = store.manifest
    q = (query or "").strip()
    if not q:
        return {
            "status": "error",
            "mode": "none",
            "error": "query is empty",
            "chunks": [],
            "warnings": [],
            "generation_owner": "pilotdeck",
        }
    if len(q) > 50_000:
        return {
            "status": "error",
            "mode": "none",
            "error": "query exceeds 50000 characters",
            "chunks": [],
            "warnings": [],
            "generation_owner": "pilotdeck",
        }

    k = int(top_k if top_k is not None else manifest.default_top_k)
    k = max(1, min(k, manifest.max_top_k))
    score_floor = float(
        min_score if min_score is not None else manifest.default_min_score
    )

    status = store.status(validate=True)
    if not status.get("ready"):
        return {
            "status": "unavailable",
            "mode": "none",
            "error": status.get("reason") or "rag_artifacts_unavailable",
            "chunks": [],
            "warnings": [],
            "corpus": status,
            "generation_owner": "pilotdeck",
        }

    warnings: list[str] = []
    mode = "vector"
    items: list[dict[str, Any]] = []
    intent = _query_intent(q)
    image_requested = _looks_like_image_query(q)
    preferred_source = _preferred_source_for_query(q)
    search_k = max(manifest.max_top_k, 32) if preferred_source else k

    if prefer_lexical:
        mode = "lexical"
        items = store.search_lexical(query=q, top_k=search_k)
        items = _merge_source_routing_candidates(
            store,
            items,
            query=q,
            preferred_source=preferred_source,
            top_k=search_k,
        )
        if image_requested:
            before_topic_filter = len(items)
            items = _filter_image_topic_items(items, query=q, intent=intent)
            if before_topic_filter and not items:
                warnings.append(_IMAGE_TOPIC_FILTER_WARNING)
        items = _prefer_single_source(
            items,
            intent=intent,
            preferred_source=preferred_source,
        )
        items = _rerank_operational_wmd_items(items, query=q, preferred_source=preferred_source)[:k]
    else:
        try:
            vectors = embed_texts([q])
            items = store.search_vector(
                query_vector=vectors[0],
                top_k=search_k,
                min_score=score_floor,
            )
            items = _merge_source_routing_candidates(
                store,
                items,
                query=q,
                preferred_source=preferred_source,
                top_k=search_k,
            )
            mode = "vector"
            if image_requested:
                items = _merge_caption_matches(
                    items,
                    _search_image_captions(store, query=q, top_k=manifest.max_top_k),
                    query=q,
                    top_k=k,
                )
                before_topic_filter = len(items)
                items = _filter_image_topic_items(items, query=q, intent=intent)
                if before_topic_filter and not items:
                    warnings.append(_IMAGE_TOPIC_FILTER_WARNING)
            items = _prefer_single_source(
                items,
                intent=intent,
                preferred_source=preferred_source,
            )
            items = _rerank_operational_wmd_items(items, query=q, preferred_source=preferred_source)[:k]
            if not items:
                warnings.append(
                    f"no chunk met min_score={score_floor}; consider lowering min_score"
                )
        except (EmbeddingError, OSError, ValueError) as exc:
            mode = "lexical-fallback"
            items = store.search_lexical(query=q, top_k=search_k)
            items = _merge_source_routing_candidates(
                store,
                items,
                query=q,
                preferred_source=preferred_source,
                top_k=search_k,
            )
            if image_requested:
                before_topic_filter = len(items)
                items = _filter_image_topic_items(items, query=q, intent=intent)
                if before_topic_filter and not items:
                    warnings.append(_IMAGE_TOPIC_FILTER_WARNING)
            items = _prefer_single_source(
                items,
                intent=intent,
                preferred_source=preferred_source,
            )
            items = _rerank_operational_wmd_items(items, query=q, preferred_source=preferred_source)[:k]
            warnings.append(
                f"embedding unavailable ({type(exc).__name__}: {str(exc)[:200]}); "
                "used lexical-fallback"
            )

    for rank, item in enumerate(items, start=1):
        item["rank"] = rank
    attach_display_assets(items, q if image_requested else None)

    dominant_source = _dominant_source(items)
    context_chunks = _collect_context_chunks(
        store,
        items,
        intent=intent,
        dominant_source=dominant_source,
        limit=max(2, min(4, k)),
    )

    query_id = hashlib.sha256(
        f"{manifest.corpus_id}\0{manifest.version}\0{mode}\0{q}".encode("utf-8")
    ).hexdigest()[:24]

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return {
        "status": "ready",
        "mode": mode,
        "query": q,
        "query_id": query_id,
        "corpus_id": manifest.corpus_id,
        "corpus_version": manifest.version,
        "embedding_model": (
            f"lexical-fallback:{manifest.embedding_model}"
            if mode.startswith("lexical")
            else get_embedding_config()["model"]
        ),
        "top_k": k,
        "min_score": score_floor if mode == "vector" else None,
        "chunk_count": len(items),
        "chunks": items,
        "context_chunks": context_chunks,
        "retrieval_intent": intent,
        "source_routing": _source_routing_summary(
            preferred_source=preferred_source,
            items=items,
        ),
        "image_match": summarize_image_match(items, q),
        "dominant_source_corpus_id": dominant_source,
        "interleave_context": build_interleave_context(
            items,
            max_image_rank=min(3, k) if image_requested else 1,
            image_query=q if image_requested else None,
        ),
        "warnings": warnings,
        "elapsed_ms": elapsed_ms,
        "generation_owner": "pilotdeck",
        "presentation": (
            "工具只返回检索证据。请由主模型基于 chunks 撰写回答；"
            "若返回了 context_chunks，它们只是同一来源的相邻上下文，不要与不相干书目混写。"
            "对于流程/步骤/图示类问题，优先围绕 dominant_source_corpus_id 所示的单一来源组织答案，"
            "先用一句话给出顺序结论，再合并相邻 chunk 概括关键步骤；涉及化学暴露转运时，"
            "必须区分污染区急救稳定、洗消区净化验证、清洁区治疗/后送，"
            "不要简单写成「先治疗后洗消」或「先洗消后治疗」。若 image_match.exact_figure_match=false，"
            "必须说明未命中标题完全对应的原图，只展示相关教材图。"
            "图片只能使用 chunks[].assets 或 interleave_context 中 available=true 且 url 非空的资产，"
            "不要自行拼 URL、不要查询本地磁盘。若 evidence 仍明显分散，请明确说明检索到的是局部片段。"
            "区分「所见/用户陈述」与「检索文献」，并注明来源；不得编造未检索到的条文。"
            "面向用户的参考来源只写书名、章节、页码，不要展示 chunk_id、context_chunks、"
            "dominant_source_corpus_id、source_routing、mode 或「上下文」等内部调试字段。"
            "输出仅供辅助，须医务人员复核。"
        ),
    }


def _looks_like_image_query(query: str) -> bool:
    lowered = query.lower()
    return any(marker in lowered for marker in ("图", "图片", "图示", "图注", "figure", "fig."))


def _merge_caption_matches(
    vector_items: list[dict[str, Any]],
    lexical_items: list[dict[str, Any]],
    *,
    query: str,
    top_k: int,
) -> list[dict[str, Any]]:
    promoted = lexical_items
    if not promoted:
        return vector_items
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in [*promoted, *vector_items]:
        key = str(item.get("chunk_id") or item.get("index") or "")
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
        if len(result) >= top_k:
            break
    return result


def _search_image_captions(store: RagStore, *, query: str, top_k: int) -> list[dict[str, Any]]:
    search = getattr(store, "search_image_captions", None)
    if callable(search):
        return search(query=query, top_k=top_k)
    return store.search_lexical(query=query, top_k=top_k)


def _merge_source_routing_candidates(
    store: RagStore,
    items: list[dict[str, Any]],
    *,
    query: str,
    preferred_source: str,
    top_k: int,
) -> list[dict[str, Any]]:
    if preferred_source != "wmd-terror-response-v2-caption-cpu8":
        return items
    expanded_query = _wmd_operational_expansion(query)
    if not expanded_query:
        return items
    try:
        expanded = store.search_lexical(query=expanded_query, top_k=top_k)
    except (OSError, ValueError):
        return items
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in [*items, *expanded]:
        key = str(item.get("chunk_id") or item.get("index") or "")
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def _wmd_operational_expansion(query: str) -> str:
    lowered = query.lower()
    if not any(marker in lowered for marker in ("初始", "处置", "优先", "顺序", "先后", "转运", "现场")):
        return ""
    return (
        f"{query} 自我防护 首要任务 净化 洗消 转运 现场 急救人员 "
        "救护人员 伤员 污染 清洁区 救护车 个人防护 PPE 分流"
    )


def _filter_image_topic_items(
    items: list[dict[str, Any]],
    *,
    query: str,
    intent: str,
) -> list[dict[str, Any]]:
    if intent not in {"image", "image_process"} or not items:
        return items
    terms = _image_topic_terms(query)
    if not terms:
        return items
    matched = [item for item in items if _item_contains_any(item, terms)]
    if intent == "image_process":
        return matched
    return matched or items


def _image_topic_terms(query: str) -> tuple[str, ...]:
    lowered = query.lower()
    terms: list[str] = []
    if "防化服" in lowered:
        terms.extend(["防化服", "防护服", "防护套衣", "外罩衣", "jslist"])
    if "防护服" in lowered:
        terms.extend(["防护服", "防化服", "防护套衣", "外罩衣", "jslist"])
    if "防护" in lowered:
        terms.extend(["防护", "防护服", "防护套衣", "外罩衣", "jslist"])
    if "洗消" in lowered:
        terms.extend(["洗消", "除毒", "消毒", "染毒"])
    if "污染" in lowered or "染毒" in lowered:
        terms.extend(["污染", "染毒", "洗消", "除毒", "消毒"])
    return tuple(dict.fromkeys(term for term in terms if term))


def _item_contains_any(item: dict[str, Any], terms: tuple[str, ...]) -> bool:
    values = [
        str(item.get("title") or ""),
        str(item.get("section") or ""),
        str(item.get("text") or ""),
    ]
    for ref in item.get("image_refs") or []:
        if isinstance(ref, dict):
            values.append(str(ref.get("caption") or ""))
    haystack = "".join(values).lower()
    return any(term.lower() in haystack for term in terms)


def _query_intent(query: str) -> str:
    lowered = query.lower()
    image = any(marker in lowered for marker in ("流程图", "示意图", "图示", "图片", "图注", "figure", "fig.", "图"))
    process = any(
        marker in lowered
        for marker in (
            "步骤",
            "流程",
            "程序",
            "顺序",
            "先后",
            "方法",
            "如何",
            "怎么",
            "处置",
            "洗消",
            "穿脱",
            "过程",
        )
    )
    compare = any(marker in lowered for marker in ("区别", "对比", "比较", "分别", "vs"))
    if compare:
        return "compare"
    if image and process:
        return "image_process"
    if image:
        return "image"
    if process:
        return "process"
    return "general"


def _preferred_source_for_query(query: str) -> str:
    lowered = query.lower()
    explicit_phtls = any(
        marker in lowered
        for marker in (
            "院前创伤生命支持",
            "phtls",
            "prehospital trauma life support",
        )
    )
    if explicit_phtls:
        return "prehospital-trauma-life-support-7th-v1-cpu32"
    explicit_wmd = any(
        marker in lowered
        for marker in (
            "大规模杀伤性武器",
            "恐怖袭击",
            "wmd",
            "cbrne",
            "大规模杀伤",
        )
    )
    hazard_markers = (
        "生物",
        "化学",
        "放射",
        "核",
        "爆炸",
    )
    hazard_count = sum(1 for marker in hazard_markers if marker in lowered)
    attack_context = any(marker in lowered for marker in ("袭击", "恐怖", "事件", "处置"))
    if explicit_wmd or (hazard_count >= 3 and attack_context):
        return "wmd-terror-response-v2-caption-cpu8"
    return ""


def _prefer_single_source(
    items: list[dict[str, Any]],
    *,
    intent: str,
    preferred_source: str = "",
) -> list[dict[str, Any]]:
    if len(items) <= 1:
        return items
    if intent == "compare":
        return items
    if preferred_source:
        preferred = [item for item in items if _source_key(item) == preferred_source]
        if preferred:
            return preferred
    dominant = _dominant_source(items)
    if not dominant:
        return items
    same_source = [item for item in items if _source_key(item) == dominant]
    return same_source or items


def _source_routing_summary(
    *,
    preferred_source: str,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    if not preferred_source:
        return {
            "preferred_source_corpus_id": "",
            "applied": False,
            "reason": "",
        }
    return {
        "preferred_source_corpus_id": preferred_source,
        "applied": any(_source_key(item) == preferred_source for item in items),
        "reason": "wmd_multihazard_or_terror_attack_query",
    }


def _rerank_operational_wmd_items(
    items: list[dict[str, Any]],
    *,
    query: str,
    preferred_source: str,
) -> list[dict[str, Any]]:
    if preferred_source != "wmd-terror-response-v2-caption-cpu8" or len(items) <= 1:
        return items
    lowered = query.lower()
    process_query = any(
        marker in lowered
        for marker in ("初始", "处置", "优先", "顺序", "先后", "转运", "现场")
    )
    if not process_query:
        return items
    return sorted(
        items,
        key=lambda item: (
            -_wmd_operational_score(item),
            -_safe_float(item.get("score")),
            int(item.get("index") or 0),
        ),
    )


def _wmd_operational_score(item: dict[str, Any]) -> int:
    text = " ".join(
        str(item.get(key) or "")
        for key in ("title", "section", "text")
    )
    positive_terms = (
        "自我防护",
        "首要任务",
        "净化",
        "洗消",
        "现场",
        "救护人员",
        "急救人员",
        "个人防护",
        "ppe",
        "转运",
        "救护车",
        "伤员",
        "分流",
        "污染",
        "清洁",
    )
    negative_terms = (
        "合成",
        "生产",
        "制造",
        "简介",
        "威胁",
        "历史",
        "总结",
    )
    score = sum(3 for term in positive_terms if term in text)
    score -= sum(2 for term in negative_terms if term in text)
    page = item.get("page_start")
    try:
        page_number = int(page)
    except (TypeError, ValueError):
        page_number = 0
    if 254 <= page_number <= 259:
        score += 8
    if page_number == 46:
        score += 10
    elif 44 <= page_number <= 48:
        score += 4
    return score


def _safe_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _is_wmd_operational_context(item: dict[str, Any]) -> bool:
    section = str(item.get("section") or "")
    if any(term in section for term in ("隔离霜", "参考文献", "简介", "总结", "威胁")):
        return False
    text = " ".join(
        str(item.get(key) or "")
        for key in ("section", "text")
    )
    if not any(
        term in text
        for term in (
            "自我防护",
            "首要任务",
            "净化",
            "洗消",
            "转运",
            "救护车",
            "接受区",
            "清洁",
            "污染",
        )
    ):
        return False
    return _wmd_operational_score(item) >= 6


def _collect_context_chunks(
    store: RagStore,
    items: list[dict[str, Any]],
    *,
    intent: str,
    dominant_source: str,
    limit: int,
) -> list[dict[str, Any]]:
    if intent not in {"process", "image_process"} or not items:
        return []
    if not dominant_source:
        return []
    context: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items[: max(1, min(2, len(items)) )]:
        index = item.get("index")
        try:
            neighbor_index = int(index)
        except (TypeError, ValueError):
            continue
        for neighbor in store.neighbor_chunks(index=neighbor_index, window=1, same_source=True, same_doc=False):
            if _source_key(neighbor) != dominant_source:
                continue
            if (
                dominant_source == "wmd-terror-response-v2-caption-cpu8"
                and intent == "process"
                and not _is_wmd_operational_context(neighbor)
            ):
                continue
            chunk_id = str(neighbor.get("chunk_id") or "")
            if not chunk_id or chunk_id in seen:
                continue
            seen.add(chunk_id)
            context.append(neighbor)
            if len(context) >= limit:
                return context
    return context


def _dominant_source(items: list[dict[str, Any]]) -> str:
    if not items:
        return ""
    scores: Counter[str] = Counter()
    counts: Counter[str] = Counter()
    for item in items:
        key = _source_key(item)
        if not key:
            continue
        score = item.get("score")
        try:
            score_value = float(score)
        except (TypeError, ValueError):
            score_value = 0.0
        scores[key] += max(score_value, 0.001)
        counts[key] += 1
    if not scores:
        return ""
    return max(scores.keys(), key=lambda key: (scores[key], counts[key], -len(key)))


def _source_key(item: dict[str, Any]) -> str:
    return (
        str(item.get("source_corpus_id") or "")
        or str(item.get("source_bundle_corpus_path") or "")
        or str(item.get("doc_id") or "")
        or str(item.get("title") or "")
    )
