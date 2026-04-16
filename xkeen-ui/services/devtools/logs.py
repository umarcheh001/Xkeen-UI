"""DevTools logs helpers (split from services.devtools).

This module contains the log target allow-list and helpers used by the DevTools
API to list/tail/truncate log files.

IMPORTANT: Public names are re-exported by `services.devtools` to preserve
backwards-compatible imports.
"""

from __future__ import annotations

import base64
import json
import os
import re
from typing import Any, Dict, List, Mapping, Optional, Tuple

from services.xray_logs import read_new_lines, tail_lines_fast


def _ui_state_dir() -> str:
    # Keep in sync with app.py defaults
    return (
        (os.environ.get("XKEEN_UI_STATE_DIR") or os.environ.get("XKEEN_UI_DIR") or "/opt/etc/xkeen-ui").strip()
        or "/opt/etc/xkeen-ui"
    )


def _restart_log_path() -> str:
    return (os.environ.get("XKEEN_RESTART_LOG_FILE") or os.path.join(_ui_state_dir(), "restart.log")).strip()


def _update_log_path() -> str:
    update_dir = (os.environ.get("XKEEN_UI_UPDATE_DIR") or "").strip()
    if update_dir:
        return os.path.join(update_dir, "update.log")
    try:
        from core.paths import BASE_VAR_DIR  # type: ignore

        base_var = str(BASE_VAR_DIR)
    except Exception:
        base_var = "/opt/var"
    return os.path.join(base_var, "lib", "xkeen-ui", "update", "update.log")


def _log_dir() -> str:
    # Keep in sync with services/logging_setup.py and app.py
    return (os.environ.get("XKEEN_LOG_DIR") or "/opt/var/log/xkeen-ui").strip() or "/opt/var/log/xkeen-ui"


def _log_targets() -> Mapping[str, str]:
    """Return available log targets.

    Prefer the real paths from services/logging_setup (it knows the actual
    configured directory, including dev fallbacks). Fall back to legacy
    /opt/var paths when logging_setup isn't available.
    """
    try:
        from services import logging_setup as _ls  # local import to keep logging optional

        core, access, ws = _ls.get_paths()  # type: ignore[attr-defined]
        d = os.path.dirname(core)
        return {
            "core": core,
            "access": access,
            "ws": ws,
            "stdout": os.path.join(d, "stdout.log"),
            "stderr": os.path.join(d, "stderr.log"),
            "update": _update_log_path(),
            "restart": _restart_log_path(),
            # Legacy single-file log (old init script)
            "xkeen-ui": "/opt/var/log/xkeen-ui.log",
        }
    except Exception:
        d = _log_dir()
        return {
            # Split logs (recommended)
            "core": os.path.join(d, "core.log"),
            "access": os.path.join(d, "access.log"),
            "ws": os.path.join(d, "ws.log"),
            "stdout": os.path.join(d, "stdout.log"),
            "stderr": os.path.join(d, "stderr.log"),
            "update": _update_log_path(),
            "restart": _restart_log_path(),
            # Legacy single-file log (old init script)
            "xkeen-ui": "/opt/var/log/xkeen-ui.log",
        }


def _resolve_log_path(name: str) -> Optional[str]:
    targets = dict(_log_targets())
    if name in targets:
        return targets.get(name)

    m = re.match(r"^([A-Za-z0-9_-]+)\.(\d+)$", str(name or ""))
    if not m:
        return None
    base = m.group(1)
    idx = m.group(2)
    base_path = targets.get(base)
    if not base_path:
        return None
    cand = f"{base_path}.{idx}"
    if os.path.isfile(cand):
        return cand
    return None


def _stat_log(path: str) -> Dict[str, Any]:
    try:
        st = os.stat(path)
        return {
            "size": int(getattr(st, "st_size", 0) or 0),
            "mtime": float(getattr(st, "st_mtime", 0.0) or 0.0),
            "ino": int(getattr(st, "st_ino", 0) or 0),
        }
    except Exception:
        return {"size": 0, "mtime": 0.0, "ino": 0}


def _b64e(b: bytes) -> str:
    if not b:
        return ""
    return base64.urlsafe_b64encode(b).decode("ascii")


def _b64d(s: str) -> bytes:
    if not s:
        return b""
    try:
        return base64.urlsafe_b64decode(s.encode("ascii"))
    except Exception:
        try:
            pad = "=" * (-len(s) % 4)
            return base64.urlsafe_b64decode((s + pad).encode("ascii"))
        except Exception:
            return b""


def _encode_cursor(obj: Dict[str, Any]) -> str:
    try:
        raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii")
    except Exception:
        return ""


def _decode_cursor(cur: Optional[str]) -> Optional[Dict[str, Any]]:
    if not cur:
        return None
    try:
        raw = base64.urlsafe_b64decode(cur.encode("ascii"))
    except Exception:
        try:
            pad = "=" * (-len(cur) % 4)
            raw = base64.urlsafe_b64decode((cur + pad).encode("ascii"))
        except Exception:
            return None
    try:
        obj = json.loads(raw.decode("utf-8", "ignore"))
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def list_logs() -> List[Dict[str, Any]]:
    """List known logs (whitelisted) with basic metadata.

    Includes rotated files like core.1, core.2 when present.

    Notes:
      - Base targets (core/access/ws/stdout/stderr/restart/...) are always returned
        even if the file doesn't exist yet (exists=false), so UI can keep a stable list.
      - Rotated files are returned only when present.
    """
    targets = dict(_log_targets())
    order = ["core", "access", "ws", "stdout", "stderr", "update", "restart", "xkeen-ui"]
    out: List[Dict[str, Any]] = []

    def _add(name: str, path: str, exists: bool) -> None:
        st = _stat_log(path) if exists else {"size": 0, "mtime": 0.0, "ino": 0}
        out.append({"name": name, "path": path, "exists": bool(exists), **st})

    for base in order:
        p = targets.get(base)
        if p:
            ex = os.path.isfile(p)
            _add(base, p, ex)
            # Rotated: only existing files
            for i in range(1, 11):
                rp = f"{p}.{i}"
                if os.path.isfile(rp):
                    _add(f"{base}.{i}", rp, True)

    for base, p in sorted(targets.items()):
        if base in order:
            continue
        ex = os.path.isfile(p)
        _add(base, p, ex)

    return out


def tail_log(
    name: str,
    *,
    lines: int = 400,
    cursor: Optional[str] = None,
) -> Tuple[str, List[str], Optional[str], str]:
    """Tail log with optional incremental cursor.

    Returns: (path, lines, new_cursor, mode)
      mode = "full" | "append"
    """
    path = _resolve_log_path(name)
    if not path:
        raise ValueError("unknown_log")

    max_lines = max(1, min(5000, int(lines or 400)))
    st = _stat_log(path)
    ino = int(st.get("ino", 0) or 0)
    size = int(st.get("size", 0) or 0)

    cur = _decode_cursor(cursor)
    if cur and int(cur.get("ino", -1)) == ino:
        try:
            off = int(cur.get("off", 0) or 0)
        except Exception:
            off = 0
        if 0 <= off <= size:
            carry = _b64d(str(cur.get("carry", "")))
            new_lines, new_off, new_carry = read_new_lines(path, off, carry=carry, max_bytes=128 * 1024)
            new_cur = _encode_cursor({"ino": ino, "off": int(new_off), "carry": _b64e(new_carry)})
            return path, new_lines, new_cur, "append"

    lns = tail_lines_fast(path, max_lines=max_lines, max_bytes=256 * 1024)
    new_cur = _encode_cursor({"ino": ino, "off": size, "carry": ""})
    return path, lns, new_cur, "full"


def truncate_log(name: str) -> str:
    if re.match(r"^.+\.\d+$", str(name or "")):
        raise ValueError("unknown_log")
    path = _resolve_log_path(name)
    if not path:
        raise ValueError("unknown_log")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8"):
        pass
    return path
