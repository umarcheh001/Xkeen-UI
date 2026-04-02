"""Restart-log helpers.

Keeps read/clear operations out of app.py. The log file path is passed in explicitly.
"""
from __future__ import annotations

import os
import time
from typing import List


def append_restart_log(log_file: str, ok: bool, source: str = "api") -> None:
    """Append a single line about restart result to the restart log."""
    line = "[{ts}] source={src} result={res}\n".format(
        ts=time.strftime("%Y-%m-%d %H:%M:%S"),
        src=source,
        res="OK" if ok else "FAIL",
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
