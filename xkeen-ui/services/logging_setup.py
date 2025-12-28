"""Centralized logging setup for Xkeen UI.

Design goals
- Logging must never be required for functionality.
- Logs are split by purpose (core/access/ws) and rotate by size to protect flash.
- Runtime toggles are driven by env vars so DevTools can manage them.

Environment variables
- XKEEN_LOG_DIR: directory for all UI logs (default: /opt/var/log/xkeen-ui)
- XKEEN_LOG_CORE_ENABLE: 0/1 (default: 1)
- XKEEN_LOG_CORE_LEVEL: ERROR|WARNING|INFO|DEBUG (default: INFO)
- XKEEN_LOG_ACCESS_ENABLE: 0/1 (default: 0)
- XKEEN_LOG_WS_ENABLE: 0/1 (default: 0)
- XKEEN_LOG_ROTATE_MAX_MB: max size in MB for each log file before rotation (default: 2)
- XKEEN_LOG_ROTATE_BACKUPS: number of rotated files to keep (default: 3)

Notes
- We keep setup idempotent to avoid duplicating handlers on reload/import.
- Runtime updates (level/enable/rotate params) are applied via refresh_runtime_from_env().
"""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from typing import Dict, Optional, Tuple


DEFAULT_LOG_DIR = "/opt/var/log/xkeen-ui"
DEFAULT_CORE_LEVEL = "INFO"
DEFAULT_ROTATE_MAX_MB = 2
DEFAULT_ROTATE_BACKUPS = 3


_STATE: Dict[str, object] = {
    "configured": False,
    "log_dir": None,
    "handlers": {},  # type: ignore
}


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "on", "y"):
        return True
    if s in ("0", "false", "no", "off", "n"):
        return False
    return default


def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if v is None:
        return default
    try:
        return int(str(v).strip())
    except Exception:
        return default


def _parse_level(level_name: str) -> int:
    s = (level_name or "").strip().upper()
    if s in ("CRITICAL", "FATAL"):
        return logging.CRITICAL
    if s == "ERROR":
        return logging.ERROR
    if s in ("WARN", "WARNING"):
        return logging.WARNING
    if s == "DEBUG":
        return logging.DEBUG
    if s == "INFO":
        return logging.INFO
    # conservative fallback
    return logging.INFO


def get_log_dir(default_dir: Optional[str] = None) -> str:
    """Resolve log directory from env, with a conservative fallback."""
    p = (os.environ.get("XKEEN_LOG_DIR") or "").strip()
    if p:
        return p
    return default_dir or DEFAULT_LOG_DIR


def _mk_rotating_handler(path: str) -> RotatingFileHandler:
    max_mb = max(1, _env_int("XKEEN_LOG_ROTATE_MAX_MB", DEFAULT_ROTATE_MAX_MB))
    backups = max(1, _env_int("XKEEN_LOG_ROTATE_BACKUPS", DEFAULT_ROTATE_BACKUPS))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    h = RotatingFileHandler(
        path,
        maxBytes=max_mb * 1024 * 1024,
        backupCount=backups,
        encoding="utf-8",
        delay=True,
    )
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    h.setFormatter(fmt)
    return h


def setup_logging(log_dir: Optional[str] = None) -> None:
    """Configure core/access/ws loggers with rotating file handlers."""
    global _STATE
    if _STATE.get("configured"):
        # Idempotent: still allow runtime refresh.
        refresh_runtime_from_env()
        return

    log_dir = log_dir or get_log_dir()
    os.makedirs(log_dir, exist_ok=True)

    handlers: Dict[str, RotatingFileHandler] = {}

    core_path = os.path.join(log_dir, "core.log")
    access_path = os.path.join(log_dir, "access.log")
    ws_path = os.path.join(log_dir, "ws.log")

    handlers["core"] = _mk_rotating_handler(core_path)
    handlers["access"] = _mk_rotating_handler(access_path)
    handlers["ws"] = _mk_rotating_handler(ws_path)

    # Core logger
    core = logging.getLogger("xkeenui")
    core.propagate = False
    core.addHandler(handlers["core"])

    # Access logger
    access = logging.getLogger("xkeenui.access")
    access.propagate = False
    access.addHandler(handlers["access"])

    # WS logger
    ws = logging.getLogger("xkeenui.ws")
    ws.propagate = False
    ws.addHandler(handlers["ws"])

    # Also route Flask's app logger into core (when used)
    flask_logger = logging.getLogger("flask.app")
    flask_logger.propagate = True

    _STATE["configured"] = True
    _STATE["log_dir"] = log_dir
    _STATE["handlers"] = handlers

    refresh_runtime_from_env()



def core_enabled() -> bool:
    return _env_bool("XKEEN_LOG_CORE_ENABLE", default=True)


def refresh_runtime_from_env() -> None:
    """Apply runtime settings (levels / rotation params) from env."""
    if not _STATE.get("configured"):
        return

    handlers: Dict[str, RotatingFileHandler] = _STATE.get("handlers") or {}  # type: ignore
    max_mb = max(1, _env_int("XKEEN_LOG_ROTATE_MAX_MB", DEFAULT_ROTATE_MAX_MB))
    backups = max(1, _env_int("XKEEN_LOG_ROTATE_BACKUPS", DEFAULT_ROTATE_BACKUPS))

    # Update rotation params for already-created handlers
    try:
        for h in handlers.values():
            try:
                h.maxBytes = max_mb * 1024 * 1024
                h.backupCount = backups
            except Exception:
                pass
    except Exception:
        pass
    # Core enable/disable + level
    core = logging.getLogger("xkeenui")
    core.propagate = False
    core_h = handlers.get("core") if isinstance(handlers, dict) else None

    if not core_enabled():
        try:
            core.disabled = True
        except Exception:
            pass
        try:
            if core_h and core_h in getattr(core, 'handlers', []):
                core.removeHandler(core_h)
        except Exception:
            pass
        # When disabled, keep level very high to drop everything even if .disabled isn't respected somewhere.
        try:
            core.setLevel(100)
        except Exception:
            pass
    else:
        try:
            core.disabled = False
        except Exception:
            pass
        try:
            if core_h and core_h not in getattr(core, 'handlers', []):
                core.addHandler(core_h)
        except Exception:
            pass
        lvl_name = os.environ.get("XKEEN_LOG_CORE_LEVEL", DEFAULT_CORE_LEVEL)
        lvl = _parse_level(lvl_name)
        core.setLevel(lvl)

    # Access/ws are always DEBUG internally; the enable flag decides whether we log.
    logging.getLogger("xkeenui.access").setLevel(logging.INFO)
    logging.getLogger("xkeenui.ws").setLevel(logging.DEBUG)


def access_enabled() -> bool:
    return _env_bool("XKEEN_LOG_ACCESS_ENABLE", default=False)


def ws_enabled() -> bool:
    return _env_bool("XKEEN_LOG_WS_ENABLE", default=False)


def get_paths(log_dir: Optional[str] = None) -> Tuple[str, str, str]:
    """Return (core_path, access_path, ws_path)."""
    d = log_dir or _STATE.get("log_dir") or get_log_dir()
    d = str(d)
    return (
        os.path.join(d, "core.log"),
        os.path.join(d, "access.log"),
        os.path.join(d, "ws.log"),
    )


def core_logger() -> logging.Logger:
    return logging.getLogger("xkeenui")


def access_logger() -> logging.Logger:
    return logging.getLogger("xkeenui.access")


def ws_logger() -> logging.Logger:
    return logging.getLogger("xkeenui.ws")
