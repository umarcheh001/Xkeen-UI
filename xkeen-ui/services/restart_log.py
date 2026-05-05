"""Restart-log helpers.

Keeps read/clear operations out of app.py. The log file path is passed in explicitly.
"""
from __future__ import annotations

import os
import re
import time
from urllib.parse import quote
from typing import List


_META_KEY_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def _format_meta_key(key: object) -> str:
    raw = str(key or "").strip().lower()
    raw = _META_KEY_RE.sub("_", raw).strip("_.-")
    return raw[:48]


def _format_meta_value(value: object) -> str:
    raw = str(value if value is not None else "").strip()
    if len(raw) > 160:
        raw = raw[:157] + "..."
    return quote(raw, safe="-._:/")


def _format_restart_meta(meta: dict[str, object]) -> str:
    parts: list[str] = []
    for key, value in (meta or {}).items():
        meta_key = _format_meta_key(key)
        if not meta_key or value is None:
            continue
        meta_value = _format_meta_value(value)
        if not meta_value:
            continue
        parts.append(f"{meta_key}={meta_value}")
    return (" " + " ".join(parts)) if parts else ""


def append_restart_log(log_file: str, ok: bool, source: str = "api", **meta: object) -> None:
    """Append a single line about restart result to the restart log."""
    line = "[{ts}] source={src} result={res}{meta}\n".format(
        ts=time.strftime("%Y-%m-%d %H:%M:%S"),
        src=_format_meta_value(source or "api") or "api",
        res="OK" if ok else "FAIL",
        meta=_format_restart_meta(meta),
    )
    log_dir = os.path.dirname(log_file)
    if log_dir and not os.path.isdir(log_dir):
        os.makedirs(log_dir, exist_ok=True)
    try:
        with open(log_file, "a") as f:
            f.write(line)
    except Exception:
        # Logging errors are non-critical
        pass

    try:
        from services.events import broadcast_event

        broadcast_event({
            "event": "restart_log_appended",
            "source": str(source or ""),
            "ok": bool(ok),
        })
    except Exception:
        pass


def append_restart_log_text(log_file: str, raw_text: str) -> None:
    """Append raw runtime output to the restart log."""
    text = str(raw_text or "")
    if not text:
        return
    if not text.endswith("\n"):
        text += "\n"
    log_dir = os.path.dirname(log_file)
    if log_dir and not os.path.isdir(log_dir):
        os.makedirs(log_dir, exist_ok=True)
    try:
        with open(log_file, "a", encoding="utf-8", errors="replace") as f:
            f.write(text)
    except Exception:
        pass


def write_restart_log(log_file: str, raw_text: str) -> None:
    """Overwrite restart log with full raw output."""
    log_dir = os.path.dirname(log_file)
    if log_dir and not os.path.isdir(log_dir):
        os.makedirs(log_dir, exist_ok=True)
    with open(log_file, "w", encoding="utf-8") as f:
        f.write(str(raw_text or ""))


def read_restart_log(log_file: str, limit: int = 100) -> List[str]:
    """Read last ``limit`` lines from restart log file, if it exists."""
    if not os.path.isfile(log_file):
        return []
    try:
        with open(log_file, "r") as f:
            lines = f.readlines()
        return lines[-limit:]
    except Exception:
        return []


def clear_restart_log(log_file: str) -> None:
    """Truncate restart log file (create directories if needed)."""
    log_dir = os.path.dirname(log_file)
    if log_dir and not os.path.isdir(log_dir):
        os.makedirs(log_dir, exist_ok=True)
    # If file doesn't exist, treat as success.
    try:
        with open(log_file, "w") as f:
            f.write("")
    except Exception:
        # Surface as exception for API to handle.
        raise
