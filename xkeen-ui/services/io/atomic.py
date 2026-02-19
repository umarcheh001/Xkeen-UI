"""Atomic file writes.

Write to a temporary file in the same directory and then `os.replace()`.
This keeps updates crash-safe and avoids partial writes.
"""

from __future__ import annotations

import json
import os
from typing import Any


def _atomic_write_text(path: str, text: str, mode: int = 0o644, *, newline: str = "\n") -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    # Use a fixed newline to keep diffs predictable across platforms.
    with open(tmp, "w", encoding="utf-8", errors="ignore", newline=newline) as f:
        f.write(text)
    try:
        os.chmod(tmp, mode)
    except Exception:
        pass
    os.replace(tmp, path)


def _atomic_write_json(
    path: str,
    obj: Any,
    mode: int = 0o644,
    *,
    ensure_ascii: bool = False,
    indent: int = 2,
    newline: str = "\n",
) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", errors="ignore", newline=newline) as f:
        json.dump(obj, f, ensure_ascii=ensure_ascii, indent=indent)
        f.write("\n")
    try:
        os.chmod(tmp, mode)
    except Exception:
        pass
    os.replace(tmp, path)
