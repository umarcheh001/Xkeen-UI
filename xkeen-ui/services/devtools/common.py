"""Small shared helpers for services.devtools.* modules.

This module contains tiny, dependency-light utilities that are used by multiple
DevTools subsystems. Keep it minimal to avoid circular imports.

NOTE: This refactor series intentionally avoids functional changes.
"""

from __future__ import annotations

import re
from typing import Any


# Same validator as previously used by DevTools theme editors:
# - #RGB
# - #RRGGBB
# - #RRGGBBAA
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$")


def _expand_short_hex(c: str) -> str:
    c = (c or "").strip()
    if len(c) == 4 and c.startswith("#"):
        # #RGB -> #RRGGBB
        r, g, b = c[1], c[2], c[3]
        return f"#{r}{r}{g}{g}{b}{b}".lower()
    return c.lower()


def _sanitize_color(v: Any, fallback: str) -> str:
    s = str(v or "").strip()
    if not s:
        return fallback
    if not s.startswith("#"):
        return fallback
    if not _COLOR_RE.match(s):
        return fallback
    s = _expand_short_hex(s)
    # Normalize #RRGGBB or #RRGGBBAA
    if len(s) in (7, 9):
        return s
    return fallback


def _file_has_marker(path: str, marker: str) -> bool:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            head = f.read(4096)
        return str(marker or "") in head
    except Exception:
        return False
