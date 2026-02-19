"""Thin wrapper for UI logging setup.

PR1: moved from app.py so app.py stays focused on composition.
"""

from __future__ import annotations

import os
from typing import Optional, Tuple

from services.logging_setup import (
    setup_logging,
    get_log_dir,
    get_paths,
    core_logger,
)

_CORE_LOGGER = None  # type: ignore


def init_logging(base_var_dir: str) -> Tuple[str, str, str, str]:
    """Initialize logging and return (log_dir, core_path, access_path, ws_path)."""
    global _CORE_LOGGER
    default_dir = os.path.join(str(base_var_dir), "log", "xkeen-ui")
    log_dir = get_log_dir(default_dir)
    setup_logging(log_dir)
    core_path, access_path, ws_path = get_paths(log_dir)

    try:
        _CORE_LOGGER = core_logger()
    except Exception:
        _CORE_LOGGER = None

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
        pass
