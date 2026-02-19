"""High-level Xray log helpers used by HTTP/WS endpoints.

This module decouples log tailing and loglevel config logic from the monolithic
legacy app.py while preserving backward-compatible imports.

It wraps low-level helpers in :mod:`services.xray_logs` and keeps a small in-memory
cache for tailing.
"""

from __future__ import annotations

import os
import shutil
from typing import Any, Callable, Dict, List, Optional, Tuple

from services import xray_logs

LoadJsonFn = Callable[[str, Any], Any]
SaveJsonFn = Callable[[str, Any], Any]


# --- Bound runtime configuration (set by init_xray_log_api from app.py) ---

_LOAD_JSON: Optional[LoadJsonFn] = None
_SAVE_JSON: Optional[SaveJsonFn] = None
_CONFIG_PATH: str = ""
_ACCESS_LOG: str = ""
_ERROR_LOG: str = ""
_TZ_OFFSET_HOURS: int = 3


# Simple cache for tail_lines() to avoid rereading unchanged files.
# Key: file path, value: dict with {size, mtime, lines}.
LOG_CACHE: Dict[str, Dict[str, Any]] = {}


def init_xray_log_api(
    load_json: LoadJsonFn,
    save_json: SaveJsonFn,
    config_path: str,
    access_log: str,
    error_log: str,
    *,
    tz_offset_hours: int = 3,
) -> None:
    """Bind paths and IO helpers.

    Must be called once during app startup *after* paths are resolved.
    """

    global _LOAD_JSON, _SAVE_JSON, _CONFIG_PATH, _ACCESS_LOG, _ERROR_LOG, _TZ_OFFSET_HOURS
    _LOAD_JSON = load_json
    _SAVE_JSON = save_json
    _CONFIG_PATH = str(config_path or "")
    _ACCESS_LOG = str(access_log or "")
    _ERROR_LOG = str(error_log or "")
    try:
        _TZ_OFFSET_HOURS = int(tz_offset_hours)
    except Exception:
        _TZ_OFFSET_HOURS = 3


def _saved_path(path: str) -> str:
    return f"{path}.saved"


def tail_lines(path: str, max_lines: int = 800) -> List[str]:
    """Tail file with caching."""
    return xray_logs.tail_lines(path, max_lines=max_lines, cache=LOG_CACHE)


def adjust_log_timezone(lines: List[str], offset_hours: Optional[int] = None) -> List[str]:
    """Shift timestamps in log lines."""
    return xray_logs.adjust_log_timezone(lines, int(offset_hours if offset_hours is not None else _TZ_OFFSET_HOURS))


def load_xray_log_config() -> Dict[str, Any]:
    """Load (and normalize) Xray log config."""
    if _LOAD_JSON is None:
        # Safe defaults when not initialized.
        return {"log": {"loglevel": "none", "access": _ACCESS_LOG or "", "error": _ERROR_LOG or ""}}
    return xray_logs.load_xray_log_config(_LOAD_JSON, _CONFIG_PATH, _ACCESS_LOG, _ERROR_LOG)


def save_xray_log_config(cfg: Dict[str, Any]) -> bool:
    """Save Xray log config."""
    if _SAVE_JSON is None or not _CONFIG_PATH:
        return False
    try:
        _SAVE_JSON(_CONFIG_PATH, cfg)
        return True
    except Exception:
        return False


def resolve_xray_log_path_for_ws(file_name: str) -> Optional[str]:
    """Return log path for streaming/tailing.

    Uses *.saved when loglevel=none.
    """
    file_name = (file_name or "error").lower()

    cfg = load_xray_log_config()
    log_cfg = cfg.get("log", {}) if isinstance(cfg, dict) else {}
    loglevel = str(log_cfg.get("loglevel", "none")).lower()

    access_saved = _saved_path(_ACCESS_LOG) if _ACCESS_LOG else ""
    error_saved = _saved_path(_ERROR_LOG) if _ERROR_LOG else ""

    if file_name in ("error", "error.log"):
        if loglevel == "none" and error_saved and os.path.isfile(error_saved):
            return error_saved
        return _ERROR_LOG or None

    if file_name in ("access", "access.log"):
        if loglevel == "none" and access_saved and os.path.isfile(access_saved):
            return access_saved
        return _ACCESS_LOG or None

    # Default to error
    if loglevel == "none" and error_saved and os.path.isfile(error_saved):
        return error_saved
    return _ERROR_LOG or None


def clear_logs(file_name: Optional[str] = None) -> None:
    """Clear Xray logs (and their *.saved snapshots)."""

    targets: List[str] = []
    if file_name in ("error", "error.log"):
        targets = [_ERROR_LOG]
    elif file_name in ("access", "access.log"):
        targets = [_ACCESS_LOG]
    else:
        targets = [_ACCESS_LOG, _ERROR_LOG]

    for base in targets:
        if not base:
            continue
        for actual in (base, _saved_path(base)):
            try:
                os.makedirs(os.path.dirname(actual), exist_ok=True)
                with open(actual, "w", encoding="utf-8") as f:
                    f.write("")
                LOG_CACHE.pop(actual, None)
            except Exception:
                # Router FS can be RO; ignore.
                pass


def get_status() -> Dict[str, Any]:
    """Return current loglevel and paths."""
    cfg = load_xray_log_config()
    log_cfg = cfg.get("log", {}) if isinstance(cfg, dict) else {}
    return {
        "loglevel": log_cfg.get("loglevel", "none"),
        "access": log_cfg.get("access", _ACCESS_LOG),
        "error": log_cfg.get("error", _ERROR_LOG),
    }


def enable_logs(
    level: str = "warning",
    *,
    restart_xray_core: Optional[Callable[[], Tuple[bool, str]]] = None,
) -> Tuple[bool, str, str, bool]:
    """Enable logs by setting loglevel and restarting Xray core.

    Returns: (resp_ok, detail, normalized_level, xray_restarted)
    """

    lvl = str(level or "warning").strip().lower()
    allowed = {"debug", "info", "warning", "error", "none"}
    if lvl not in allowed:
        lvl = "warning"

    cfg = load_xray_log_config()
    if not isinstance(cfg, dict):
        cfg = {}
    cfg.setdefault("log", {})
    cfg["log"]["access"] = _ACCESS_LOG
    cfg["log"]["error"] = _ERROR_LOG
    cfg["log"]["loglevel"] = lvl
    save_xray_log_config(cfg)

    ok, detail = (True, "")
    xray_restarted = False
    if restart_xray_core is not None:
        ok, detail = restart_xray_core()
        xray_restarted = bool(ok)

    nonfatal = str(detail or "") == "xray not running"
    resp_ok = bool(ok or nonfatal)
    return resp_ok, str(detail or ""), lvl, xray_restarted


def disable_logs(
    *,
    restart_xray_core: Optional[Callable[[], Tuple[bool, str]]] = None,
) -> Tuple[bool, str, bool]:
    """Disable logs (loglevel=none), snapshot current logs, restart Xray core.

    Returns: (resp_ok, detail, xray_restarted)
    """

    # Snapshot current logs to *.saved
    try:
        if _ACCESS_LOG and os.path.isfile(_ACCESS_LOG):
            shutil.copy2(_ACCESS_LOG, _saved_path(_ACCESS_LOG))
        if _ERROR_LOG and os.path.isfile(_ERROR_LOG):
            shutil.copy2(_ERROR_LOG, _saved_path(_ERROR_LOG))
    except Exception:
        pass

    cfg = load_xray_log_config()
    if not isinstance(cfg, dict):
        cfg = {}
    cfg.setdefault("log", {})
    cfg["log"]["loglevel"] = "none"
    save_xray_log_config(cfg)

    ok, detail = (True, "")
    xray_restarted = False
    if restart_xray_core is not None:
        ok, detail = restart_xray_core()
        xray_restarted = bool(ok)

    nonfatal = str(detail or "") == "xray not running"
    resp_ok = bool(ok or nonfatal)
    return resp_ok, str(detail or ""), xray_restarted
