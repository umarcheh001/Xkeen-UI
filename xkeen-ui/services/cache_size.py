"""Approximate retained bytes for caches of built-in Python DTOs."""

from __future__ import annotations

import sys
from typing import Any

# Subclasses count as their base (04.11.2026): OrderedDict, defaultdict, a
# namedtuple or a str-Enum are measured like a dict, a tuple or a str. A strict
# type check refused them and their cache went silent.
_MAPPINGS = (dict,)
_SEQUENCES = (list, tuple, set, frozenset)
_SCALARS = (str, bytes, bytearray, int, float)


def _report_unmeasurable(kind: type) -> None:
    # Such a value is returned but never cached: say so once per type, else the
    # cache stops working without a trace and only the speed tells.
    try:
        from core.logging import core_log_once

        name = f"{kind.__module__}.{kind.__qualname__}"
        core_log_once(
            "warning",
            f"cache.unmeasurable_value:{name}",
            "cache.unmeasurable_value",
            type=name,
            hint="значение отдаётся, но не кэшируется: в кэш класть только dict, list, tuple, str и числа",
        )
    except Exception:
        pass


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
        if item is not None and not isinstance(item, _MAPPINGS + _SEQUENCES + _SCALARS):
            _report_unmeasurable(type(item))
            return limit + 1
        size += sys.getsizeof(item)
        if size > limit:
            return size
        if isinstance(item, _MAPPINGS):
            for key, member in item.items():
                pending.append(key)
                pending.append(member)
        elif isinstance(item, _SEQUENCES):
            pending.extend(item)
    return size
