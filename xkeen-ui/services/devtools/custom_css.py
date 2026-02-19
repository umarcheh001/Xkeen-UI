"""Custom CSS editor (DevTools).

Split out from `services.devtools` to keep the facade smaller and make the
refactor mechanical.

Important: this module intentionally keeps the same behavior / data formats as
before the split.
"""

from __future__ import annotations

import os
import re
from typing import Any, Dict

from services.io.atomic import _atomic_write_text


def _custom_css_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, "custom.css")


def _custom_css_disabled_flag(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, "custom_css.disabled")


_CUSTOM_CSS_MAX_CHARS = 250_000


def _sanitize_custom_css(text: Any) -> str:
    """Best-effort safety: accept only CSS, reject obvious JS vectors.

    Notes:
      - This is an admin-only feature, so the goal is to prevent accidental
        injection like pasting a <script> block or javascript: URLs.
      - CSS can still do a lot visually; safe-mode is the recovery mechanism.
    """
    s = "" if text is None else str(text)
    if len(s) > _CUSTOM_CSS_MAX_CHARS:
        raise ValueError("too_large")

    # Normalize line endings and strip BOM.
    try:
        s = s.replace("\r\n", "\n").replace("\r", "\n")
        if s.startswith("\ufeff"):
            s = s.lstrip("\ufeff")
    except Exception:
        pass

    # Reject common non-CSS pastes.
    lowered = s.lower()
    if "<script" in lowered or "</script" in lowered:
        raise ValueError("unsafe_css")

    # Reject javascript: URLs (including inside url(...)).
    if re.search(r"javascript\s*:", lowered, re.IGNORECASE):
        raise ValueError("unsafe_css")

    # Legacy IE-only JS execution inside CSS.
    if re.search(r"expression\s*\(", lowered, re.IGNORECASE):
        raise ValueError("unsafe_css")

    return s


def custom_css_get(ui_state_dir: str) -> Dict[str, Any]:
    """Load current custom.css content + meta (enabled/exists/version)."""
    css_path = _custom_css_path(ui_state_dir)
    disabled_flag = _custom_css_disabled_flag(ui_state_dir)

    enabled = False
    exists = False
    version = 0
    size = 0
    content = ""
    truncated = False

    try:
        if os.path.isfile(css_path):
            exists = True
            try:
                version = int(os.path.getmtime(css_path) or 0)
            except Exception:
                version = 0

            try:
                size = int(os.path.getsize(css_path) or 0)
            except Exception:
                size = 0

            # Read with a hard cap to avoid huge payloads.
            try:
                with open(css_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read(_CUSTOM_CSS_MAX_CHARS + 1)
                if len(content) > _CUSTOM_CSS_MAX_CHARS:
                    content = content[:_CUSTOM_CSS_MAX_CHARS]
                    truncated = True
            except Exception:
                content = ""

        enabled = exists and (not os.path.isfile(disabled_flag))
    except Exception:
        enabled = False
        exists = False

    return {
        "enabled": bool(enabled),
        "exists": bool(exists),
        "version": int(version or 0),
        "size": int(size or 0),
        "truncated": bool(truncated),
        "css": content,
        "css_file": css_path,
        "disabled_flag": disabled_flag,
        "max_chars": int(_CUSTOM_CSS_MAX_CHARS),
    }


def custom_css_set(ui_state_dir: str, css_text: Any) -> Dict[str, Any]:
    """Persist custom.css and enable it."""
    css_path = _custom_css_path(ui_state_dir)
    disabled_flag = _custom_css_disabled_flag(ui_state_dir)

    css = _sanitize_custom_css(css_text)
    _atomic_write_text(css_path, css if css.endswith("\n") else (css + "\n"), mode=0o644)

    # Enable by removing disable flag.
    try:
        if os.path.exists(disabled_flag):
            os.remove(disabled_flag)
    except Exception:
        pass

    return custom_css_get(ui_state_dir)


def custom_css_disable(ui_state_dir: str) -> Dict[str, Any]:
    """Disable custom CSS without deleting the file."""
    disabled_flag = _custom_css_disabled_flag(ui_state_dir)
    try:
        _atomic_write_text(disabled_flag, "disabled\n", mode=0o644)
    except Exception:
        pass
    return custom_css_get(ui_state_dir)


def custom_css_reset(ui_state_dir: str) -> Dict[str, Any]:
    """Delete custom.css and disable flag."""
    css_path = _custom_css_path(ui_state_dir)
    disabled_flag = _custom_css_disabled_flag(ui_state_dir)

    for fp in (css_path, disabled_flag):
        try:
            if os.path.exists(fp):
                os.remove(fp)
        except Exception:
            pass

    return custom_css_get(ui_state_dir)
