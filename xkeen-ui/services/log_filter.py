"""Small helpers for server-side log filtering.

The UI already supports client-side filtering for Xray logs, but on low-powered
routers it can be useful to reduce the amount of data transferred/processed.

We intentionally keep the filtering syntax simple and safe:

  - Whitespace separates *AND* terms.
  - The pipe character ("|") separates *OR* groups.

Examples:
  - "error tls"        -> line must contain both "error" AND "tls"
  - "tls|grpc"         -> line must contain "tls" OR "grpc"
  - "tls error|grpc"   -> (tls AND error) OR grpc

Filtering is case-insensitive.
"""

from __future__ import annotations

import re
from typing import Callable, Iterable, List


def build_line_matcher(expr: str | None) -> Callable[[str], bool]:
    """Build a predicate for log lines.

    Returns a function `match(line)->bool`. Empty/None returns a predicate that
    always returns True.
    """

    raw = (expr or "").strip()
    if not raw:
        return lambda _line: True

    # Split to OR groups first.
    groups_raw = [g.strip() for g in raw.split("|") if g.strip()]
    if not groups_raw:
        return lambda _line: True

    groups: List[List[str]] = []
    for g in groups_raw:
        terms = [t for t in re.split(r"\s+", g.lower()) if t]
        if terms:
            groups.append(terms)

    if not groups:
        return lambda _line: True

    def _match(line: str) -> bool:
        s = (line or "").lower()
        for terms in groups:
            ok = True
            for t in terms:
                if t not in s:
                    ok = False
                    break
            if ok:
                return True
        return False

    return _match


def filter_lines(lines: Iterable[str], matcher: Callable[[str], bool]) -> List[str]:
    """Filter `lines` with `matcher` and return a list."""
    if matcher is None:
        return list(lines)
    return [ln for ln in lines if matcher(ln)]
