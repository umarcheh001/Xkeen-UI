"""Runtime helpers for visualizing the Xray outbound selected by routing.

Xray balancers choose an outbound per connection, so there is no stable
"global current server" value in the config files.  These helpers infer the
last observed selected outbound from recent Xray access/error log lines.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable, Mapping
from typing import Any, Dict, List, Tuple


_TS_RE = re.compile(r"(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})")
_CONTEXT_RE = re.compile(
    r"\b(?:accepted|balanc\w*|detour|leastping|observatory|outbound|picked|proxy)\b",
    re.IGNORECASE,
)


def read_xray_outbound_runtime_log_sources(max_lines: int = 1200) -> Dict[str, List[str]]:
    """Read recent Xray log lines that can mention selected outbound tags."""

    out: Dict[str, List[str]] = {}
    try:
        from services.xray_log_api import resolve_xray_log_path_for_ws
        from services.xray_logs import tail_lines_fast
    except Exception:
        return out

    for name in ("access", "error"):
        try:
            path = resolve_xray_log_path_for_ws(name)
        except Exception:
            path = None
        if not path:
            continue
        try:
            if not os.path.isfile(path):
                continue
        except Exception:
            continue
        lines = tail_lines_fast(path, max_lines=max_lines, max_bytes=512 * 1024)
        if lines:
            out[name] = lines
    return out


def infer_active_xray_outbound(
    nodes: Iterable[Mapping[str, Any]],
    log_sources: Mapping[str, Iterable[str]] | None,
) -> Dict[str, Any]:
    """Infer the latest outbound node mentioned by Xray logs.

    Returns a small JSON-serializable structure:
      - active: matched node with source/last_seen/confidence, or None
      - reason: observed | no_nodes | logs_unavailable | no_match
      - available: whether an active node was detected
    """

    clean_nodes = _normalize_nodes(nodes)
    if not clean_nodes:
        return {
            "available": False,
            "active": None,
            "reason": "no_nodes",
            "message": "В текущем outbounds-фрагменте нет proxy-узлов.",
        }

    sources = _normalize_sources(log_sources)
    if not sources:
        return {
            "available": False,
            "active": None,
            "reason": "logs_unavailable",
            "message": "Свежие access/error логи Xray недоступны.",
        }

    observations: List[Dict[str, Any]] = []
    order = 0
    tagged_nodes = [node for node in clean_nodes if node.get("tag")]
    tagged_nodes.sort(key=lambda item: len(str(item.get("tag") or "")), reverse=True)

    for source, lines in sources:
        for line in lines:
            order += 1
            text = str(line or "")
            if not text:
                continue
            ts = _line_timestamp(text)
            for node in tagged_nodes:
                tag = str(node.get("tag") or "")
                score = _line_match_score(text, tag)
                if score <= 0:
                    continue
                observations.append(
                    {
                        "node": node,
                        "source": source,
                        "last_seen": ts,
                        "order": order,
                        "score": score,
                    }
                )

    if not observations:
        return {
            "available": False,
            "active": None,
            "reason": "no_match",
            "message": "В последних логах Xray не найден выбранный outbound из этого фрагмента.",
        }

    observations.sort(
        key=lambda item: (
            str(item.get("last_seen") or ""),
            int(item.get("order") or 0),
            int(item.get("score") or 0),
        )
    )
    best = observations[-1]
    node = dict(best.get("node") or {})
    active = {
        "key": str(node.get("key") or ""),
        "tag": str(node.get("tag") or ""),
        "name": str(node.get("name") or node.get("tag") or ""),
        "fragment": str(node.get("fragment") or node.get("file") or ""),
        "file": str(node.get("file") or node.get("fragment") or ""),
        "protocol": str(node.get("protocol") or ""),
        "transport": str(node.get("transport") or ""),
        "security": str(node.get("security") or ""),
        "host": str(node.get("host") or ""),
        "port": node.get("port") if node.get("port") is not None else "",
        "source": str(best.get("source") or ""),
        "last_seen": str(best.get("last_seen") or ""),
        "confidence": "observed",
    }
    return {
        "available": True,
        "active": active,
        "reason": "observed",
        "message": "Найден последний выбранный Xray outbound по логам.",
    }


def _normalize_nodes(nodes: Iterable[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for item in nodes if isinstance(nodes, Iterable) else []:
        if not isinstance(item, Mapping):
            continue
        tag = str(item.get("tag") or "").strip()
        key = str(item.get("key") or tag or "").strip()
        if not tag or not key or key in seen:
            continue
        seen.add(key)
        clean = {str(k): v for k, v in dict(item).items() if v is not None}
        clean["tag"] = tag
        clean["key"] = key
        clean["name"] = str(clean.get("name") or tag).strip() or tag
        out.append(clean)
    return out


def _normalize_sources(log_sources: Mapping[str, Iterable[str]] | None) -> List[Tuple[str, List[str]]]:
    if not isinstance(log_sources, Mapping):
        return []
    out: List[Tuple[str, List[str]]] = []
    for source_name in ("access", "error"):
        raw = log_sources.get(source_name)
        lines = [str(line or "") for line in raw] if isinstance(raw, Iterable) and not isinstance(raw, (str, bytes)) else []
        if lines:
            out.append((source_name, lines))
    for source_name, raw in log_sources.items():
        name = str(source_name or "").strip()
        if not name or name in {"access", "error"}:
            continue
        lines = [str(line or "") for line in raw] if isinstance(raw, Iterable) and not isinstance(raw, (str, bytes)) else []
        if lines:
            out.append((name, lines))
    return out


def _line_timestamp(line: str) -> str:
    match = _TS_RE.search(str(line or ""))
    return match.group(1) if match else ""


def _tag_token_re(tag: str) -> re.Pattern[str]:
    escaped = re.escape(str(tag or ""))
    return re.compile(rf"(?<![A-Za-z0-9_.:-]){escaped}(?![A-Za-z0-9_.:-])")


def _line_match_score(line: str, tag: str) -> int:
    text = str(line or "")
    clean_tag = str(tag or "").strip()
    if not text or not clean_tag:
        return 0

    escaped = re.escape(clean_tag)
    if re.search(rf"\[{escaped}\]", text):
        return 100

    if not _CONTEXT_RE.search(text):
        return 0

    if not _tag_token_re(clean_tag).search(text):
        return 0

    lowered = text.lower()
    if "balanc" in lowered or "leastping" in lowered:
        return 90
    if "outbound" in lowered or "detour" in lowered or "picked" in lowered or "select" in lowered:
        return 80
    return 60
