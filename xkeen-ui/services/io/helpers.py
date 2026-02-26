"""High-level IO helpers used across services.

Goals:
- keep behavior defensive (best-effort, never crash callers)
- reduce duplicated open/json boilerplate
- centralize atomic write policy (same-dir tmp + os.replace)
"""

from __future__ import annotations

import json
import os
from typing import Any, TypeVar, Union

from .atomic import _atomic_write_text


T = TypeVar("T")


def read_json(path: str, default: T = None) -> Union[Any, T]:
    """Best-effort JSON loader.

    - If the file is missing/unreadable/invalid JSON -> returns *default*.
    - Uses UTF-8 with errors="ignore" (same spirit as existing code).
    """
    try:
        with open(os.fspath(path), "r", encoding="utf-8", errors="ignore") as f:
            return json.load(f)
    except Exception:
        return default


def safe_write_text(
    path: str,
    text: str,
    *,
    mode: int = 0o644,
    newline: str = "\n",
) -> None:
    """Write text to *path* atomically (best-effort).

    Creates parent dirs if needed.
    """
    _atomic_write_text(os.fspath(path), text, mode=mode, newline=newline)
