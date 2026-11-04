"""Approximate retained bytes for caches of built-in Python DTOs."""

from __future__ import annotations

import sys
from typing import Any


def cache_value_size(value: Any, limit: int) -> int:
    """Stop counting after limit; reject object types we cannot inspect."""

    size = 0
    seen: set[int] = set()
    pending = [value]
    while pending:
        item = pending.pop()
        identity = id(item)
        if identity in seen:
            continue
        seen.add(identity)
        kind = type(item)
        if kind not in (dict, list, tuple, set, frozenset, str, bytes, bytearray, int, float, bool, type(None)):
            return limit + 1
        size += sys.getsizeof(item)
        if size > limit:
            return size
        if kind is dict:
            for key, member in item.items():
                pending.append(key)
                pending.append(member)
        elif kind in (list, tuple, set, frozenset):
            pending.extend(item)
    return size
