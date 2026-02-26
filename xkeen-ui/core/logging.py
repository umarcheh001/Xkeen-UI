"""Thin wrapper for UI logging setup.

PR1: moved from app.py so app.py stays focused on composition.

Commit C: add controlled logging helpers so "silent" best-effort failures
leave a trace without spamming logs.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Dict, Optional, Tuple

from services.logging_setup import (
    setup_logging,
    get_log_dir,
    get_paths,
    core_logger,
)

_CORE_LOGGER = None  # type: ignore

# Process-lifetime guards to avoid log spam from hot paths / repeated failures.
_LOG_ONCE: set[str] = set()
_LOG_BUDGET: Dict[str, int] = {}


def _boot_dbg(msg: str) -> None:
    """Optional early debug output (stderr).

    Enable with env `XKEEN_BOOT_DEBUG=1`.
    We avoid raising from logging code at all costs.
    """
    if os.environ.get("XKEEN_BOOT_DEBUG") in ("1", "true", "yes", "on"):
        try:
            print(f"[xkeen-ui][boot] {msg}", file=sys.stderr)
        except Exception:
            return


def _fallback_log(level: str, msg: str, *, exc_info: bool = False) -> None:
    """Fallback logger used when file loggers are not ready."""
    try:
        lg = logging.getLogger("xkeenui.bootstrap")
        fn = getattr(lg, str(level or "info").lower(), None)
        if not callable(fn):
            fn = lg.info
        fn(msg, exc_info=exc_info)
    except Exception:
        _boot_dbg(f"{level}: {msg}")


def init_logging(base_var_dir: str) -> Tuple[str, str, str, str]:
    """Initialize logging and return (log_dir, core_path, access_path, ws_path).

    Logging is best-effort: failures must never block UI startup.
    """
    global _CORE_LOGGER
    default_dir = os.path.join(str(base_var_dir), "log", "xkeen-ui")
    log_dir = get_log_dir(default_dir)

    try:
        setup_logging(log_dir)
    except Exception:
        # Keep going without file handlers; leave a trace for support.
        _fallback_log("warning", "logging setup failed; continuing without file logs", exc_info=True)

    try:
        core_path, access_path, ws_path = get_paths(log_dir)
    except Exception:
        # Extremely conservative fallback.
        core_path = os.path.join(log_dir, "core.log")
        access_path = os.path.join(log_dir, "access.log")
        ws_path = os.path.join(log_dir, "ws.log")

    try:
        _CORE_LOGGER = core_logger()
    except Exception:
        _CORE_LOGGER = None
        _fallback_log("warning", "core logger init failed; core_log disabled", exc_info=True)

    return log_dir, core_path, access_path, ws_path


def core_log(level: str, msg: str, **extra) -> None:
    """Write structured-ish messages into core.log (never raises)."""
    if _CORE_LOGGER is None:
        return
    try:
        if extra:
            try:
                tail = ", ".join(f"{k}={v}" for k, v in extra.items())
            except Exception:
                tail = repr(extra)
            full = f"{msg} | {tail}"
        else:
            full = msg
        fn = getattr(_CORE_LOGGER, str(level or "info").lower(), None)
        if callable(fn):
            fn(full)
        else:
            _CORE_LOGGER.info(full)
    except Exception:
        # Never recurse into core_log; only best-effort fallback.
        _fallback_log("debug", "core_log failed (suppressed)", exc_info=True)


def core_log_once(level: str, key: str, msg: str, **extra) -> None:
    """Log a message once per process (keyed)."""
    k = str(key or msg)
    if k in _LOG_ONCE:
        return
    _LOG_ONCE.add(k)

    if _CORE_LOGGER is not None:
        core_log(level, msg, **extra)
        return

    # If file logger is not ready, use stderr/standard logger fallback.
    tail = ""
    if extra:
        try:
            tail = " | " + ", ".join(f"{kk}={vv}" for kk, vv in extra.items())
        except Exception:
            tail = " | " + repr(extra)
    _fallback_log(level, f"{msg}{tail}")


def core_warn_budget(key: str, msg: str, *, limit: int = 5, **extra) -> None:
    """Log warnings/errors up to N times per process for a given key."""
    k = str(key or msg)
    n = _LOG_BUDGET.get(k, 0)
    if n >= int(limit or 0):
        return
    _LOG_BUDGET[k] = n + 1
    core_log_once("warning", f"{k}:{n}", msg, **extra)
