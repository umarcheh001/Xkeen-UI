"""Safe deep-merge helper for JSON-like dicts.

Rules:
- dict + dict -> recursive merge
- anything else -> replace
- lists are replaced as a whole (no element-wise merge)

This helper is intentionally small and dependency-free.
"""

from __future__ import annotations

from typing import Any, Dict


def deep_merge(base: Any, patch: Any, *, _depth: int = 0, _max_depth: int = 32) -> Any:
    """Return a new object which is ``base`` deep-merged with ``patch``.

    Both inputs should be JSON-like structures (dict/list/scalars).

    If both are dicts, merge keys recursively; otherwise return ``patch``.
    """
    if _depth > _max_depth:
        # Avoid pathological recursion; prefer patch as the newest value.
        return patch

    if isinstance(base, dict) and isinstance(patch, dict):
        out: Dict[str, Any] = {}
        # Copy base first.
        for k, v in base.items():
            out[str(k)] = v
        # Merge/override from patch.
        for k, v in patch.items():
            kk = str(k)
            if kk in out:
                out[kk] = deep_merge(out[kk], v, _depth=_depth + 1, _max_depth=_max_depth)
            else:
                out[kk] = v
        return out

    # For lists/scalars/mismatched types we replace.
    return patch
