"""Local storage helpers for UI self-update (status/lock/log).

This module is intentionally small and defensive.

PR/Commit 2 (self-update):
  - stable paths for update state
  - lock helpers to avoid concurrent update runs
  - status.json read/write
  - tail update.log for UI diagnostics

No network calls are performed here.
"""

from __future__ import annotations

import json
import os
import time
import glob
from typing import Any, Dict, List, Optional, Tuple

from services.io import read_json


def _is_dir_writable(path: str) -> bool:
    try:
        os.makedirs(path, exist_ok=True)
        test_path = os.path.join(path, ".writetest")
        with open(test_path, "w", encoding="utf-8") as f:
            f.write("")
        os.remove(test_path)
        return True
    except Exception:
        return False


def get_update_dir(ui_state_dir: str) -> str:
    """Return directory where update status/lock/log are stored."""

    env_dir = os.environ.get("XKEEN_UI_UPDATE_DIR")
    if env_dir:
        return env_dir

    base_var: str
    try:
        # Prefer the same var dir selection logic as the rest of the app.
        from core.paths import BASE_VAR_DIR  # type: ignore

        base_var = str(BASE_VAR_DIR)
    except Exception:
        base_var = "/opt/var"

    # If base_var is not writable (e.g. dev env), fall back under UI_STATE_DIR.
    if not _is_dir_writable(base_var):
        base_var = os.path.join(ui_state_dir, "var")
        os.makedirs(base_var, exist_ok=True)

    return os.path.join(base_var, "lib", "xkeen-ui", "update")


def get_update_paths(ui_state_dir: str) -> Dict[str, str]:
    update_dir = get_update_dir(ui_state_dir)
    return {
        "update_dir": update_dir,
        "status_file": os.path.join(update_dir, "status.json"),
        "lock_file": os.path.join(update_dir, "lock"),
        "log_file": os.path.join(update_dir, "update.log"),
    }


def ensure_update_dir(ui_state_dir: str) -> str:
    update_dir = get_update_dir(ui_state_dir)
    os.makedirs(update_dir, exist_ok=True)
    return update_dir


def _default_status() -> Dict[str, Any]:
    # Keep schema stable for UI.
    return {
        "state": "idle",  # idle|running|done|failed
        "step": None,  # free-form string (backup/download/install/...)
        "progress": None,  # free-form dict
        "created_ts": None,
        "started_ts": None,
        "finished_ts": None,
        "error": None,
        "pid": None,
    }


def read_status(status_file: str) -> Dict[str, Any]:
    """Read status.json. Returns defaults if missing/invalid."""
    base = _default_status()
    data = read_json(status_file, default=None)
    if isinstance(data, dict):
        base.update({k: data.get(k) for k in base.keys()})
        # Keep any extra keys (forward compatibility)
        for k, v in data.items():
            if k not in base:
                base[k] = v
    return base


def write_status(status_file: str, status: Dict[str, Any]) -> None:
    """Write status.json atomically (best-effort)."""
    try:
        os.makedirs(os.path.dirname(status_file) or ".", exist_ok=True)
        tmp = status_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(status, f, ensure_ascii=False, indent=2)
        os.replace(tmp, status_file)
    except Exception:
        # Status is diagnostic; failures must not crash API.
        pass


def _lock_payload() -> Dict[str, Any]:
    return {
        "pid": os.getpid(),
        "created_ts": time.time(),
    }


def read_lock(lock_file: str) -> Dict[str, Any]:
    """Read lock file info.

    Returns dict:
      exists: bool
      pid: int|None
      created_ts: float|None
      age_sec: float|None
    """
    out: Dict[str, Any] = {"exists": False, "pid": None, "created_ts": None, "age_sec": None}
    if not os.path.isfile(lock_file):
        return out

    out["exists"] = True
    data = read_json(lock_file, default=None)
    if isinstance(data, dict):
        out["pid"] = data.get("pid")
        out["created_ts"] = data.get("created_ts")

    try:
        ct = float(out.get("created_ts") or 0.0)
        if ct > 0:
            out["age_sec"] = max(0.0, time.time() - ct)
    except Exception:
        pass
    return out


def try_acquire_lock(lock_file: str) -> Tuple[bool, Dict[str, Any]]:
    """Try to create lock file atomically.

    Returns (acquired, lock_info).
    """
    os.makedirs(os.path.dirname(lock_file) or ".", exist_ok=True)
    payload = _lock_payload()
    try:
        fd = os.open(lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
            os.write(fd, json.dumps(payload).encode("utf-8"))
        finally:
            os.close(fd)
        info = {"exists": True, **payload, "age_sec": 0.0}
        return True, info
    except FileExistsError:
        return False, read_lock(lock_file)
    except Exception:
        # If lock cannot be created due to FS errors, treat as locked to be safe.
        info = read_lock(lock_file)
        info["exists"] = True
        return False, info


def release_lock(lock_file: str) -> None:
    try:
        os.remove(lock_file)
    except FileNotFoundError:
        pass
    except Exception:
        pass


def tail_lines_fast(path: str, max_lines: int = 200, max_bytes: int = 256 * 1024) -> List[str]:
    """Return last *max_lines* lines efficiently.

    Returns decoded UTF-8 lines (keeping original line breaks when present).
    """
    try:
        os.stat(path)
    except (FileNotFoundError, OSError):
        return []

    max_lines = max(1, int(max_lines or 200))
    max_bytes = max(16 * 1024, int(max_bytes or 256 * 1024))

    block = 4096
    buf = b""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            pos = f.tell()
            while pos > 0 and buf.count(b"\n") <= max_lines and len(buf) < max_bytes:
                step = block if pos >= block else pos
                pos -= step
                f.seek(pos, os.SEEK_SET)
                buf = f.read(step) + buf

        parts = buf.splitlines(True)  # keepends=True
        if len(parts) > max_lines:
            parts = parts[-max_lines:]
        return [p.decode("utf-8", "replace") for p in parts]
    except (FileNotFoundError, OSError):
        return []


def read_update_log_tail(log_file: str, *, lines: int = 200) -> List[str]:
    return tail_lines_fast(log_file, max_lines=lines, max_bytes=256 * 1024)


# --- Backups (for rollback) ---

def get_backup_dir(ui_state_dir: str) -> str:
    """Return directory where update backups are stored."""

    env_dir = os.environ.get("XKEEN_UI_BACKUP_DIR")
    if env_dir:
        return env_dir

    base_var: str
    try:
        from core.paths import BASE_VAR_DIR  # type: ignore

        base_var = str(BASE_VAR_DIR)
    except Exception:
        base_var = "/opt/var"

    # If base_var is not writable (e.g. dev env), fall back under UI_STATE_DIR.
    if not _is_dir_writable(base_var):
        base_var = os.path.join(ui_state_dir, "var")
        os.makedirs(base_var, exist_ok=True)

    return os.path.join(base_var, "backups", "xkeen-ui")


def list_backups(backup_dir: str, *, limit: int = 5) -> List[Dict[str, Any]]:
    """List latest backups (newest first)."""

    try:
        limit = max(0, int(limit or 5))
    except Exception:
        limit = 5
    limit = min(limit, 50)

    if not backup_dir:
        return []

    try:
        os.makedirs(backup_dir, exist_ok=True)
    except Exception:
        # If we cannot create the dir, still try to list (might exist)
        pass

    try:
        paths = glob.glob(os.path.join(backup_dir, "xkeen-ui-*.tgz"))
    except Exception:
        return []

    items: List[Dict[str, Any]] = []
    for fp in paths:
        try:
            st = os.stat(fp)
            mtime = float(st.st_mtime)
            items.append(
                {
                    "name": os.path.basename(fp),
                    "path": fp,
                    "size": int(st.st_size),
                    "mtime": mtime,
                    "mtime_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime)),
                }
            )
        except Exception:
            continue

    items.sort(key=lambda x: float(x.get("mtime") or 0.0), reverse=True)
    if limit:
        items = items[:limit]
    return items
