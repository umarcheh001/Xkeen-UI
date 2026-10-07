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
import threading
import time
import glob
from typing import Any, Dict, List, Optional, Tuple

from services.io import read_json
from services.io.atomic import _atomic_write_json


_LOCK_GUARDS: Dict[str, threading.Lock] = {}
_LOCK_GUARDS_MUTEX = threading.Lock()
_LOCK_TRANSFER_TIMEOUT_SEC = 1.0
_LOCK_GUARD_RETRY_SEC = 0.01


def _thread_lock(path: str) -> threading.Lock:
    with _LOCK_GUARDS_MUTEX:
        return _LOCK_GUARDS.setdefault(os.path.abspath(path), threading.Lock())


def _acquire_process_guard(path: str, *, timeout_sec: float = 0.0) -> int | None:
    deadline = time.monotonic() + max(0.0, timeout_sec)
    while True:
        fd: int | None = None
        try:
            fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
            if os.name == "nt":
                import msvcrt

                if os.fstat(fd).st_size == 0:
                    os.write(fd, b"0")
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except ImportError:
            if fd is not None:
                os.close(fd)
            return None
        except OSError:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            time.sleep(min(_LOCK_GUARD_RETRY_SEC, remaining))


def _release_process_guard(fd: int) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_UN)
    except (OSError, ImportError):
        pass
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


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


def _pid_is_running(pid: Any) -> bool:
    try:
        pid_int = int(pid)
    except Exception:
        return False

    if pid_int <= 0:
        return False

    if os.name == "nt":
        # ``os.kill(pid, 0)`` is a Unix process-existence probe.  Its Windows
        # implementation does not provide the same reliable semantics and can
        # report the current pytest process as missing.  Query a read-only
        # process handle instead; no signal is delivered and no process state
        # is changed.
        try:
            import ctypes
            from ctypes import wintypes

            process_query_limited_information = 0x1000
            still_active = 259
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            open_process = kernel32.OpenProcess
            open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
            open_process.restype = wintypes.HANDLE
            get_exit_code = kernel32.GetExitCodeProcess
            get_exit_code.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
            get_exit_code.restype = wintypes.BOOL
            close_handle = kernel32.CloseHandle
            close_handle.argtypes = (wintypes.HANDLE,)
            close_handle.restype = wintypes.BOOL

            handle = open_process(process_query_limited_information, False, pid_int)
            if not handle:
                # Access denied still proves that a process owns this PID.
                return ctypes.get_last_error() == 5
            try:
                exit_code = wintypes.DWORD()
                if not get_exit_code(handle, ctypes.byref(exit_code)):
                    return False
                return int(exit_code.value) == still_active
            finally:
                close_handle(handle)
        except Exception:
            return False

    try:
        os.kill(pid_int, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


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
        _atomic_write_json(status_file, status)
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
      alive: bool
      stale: bool
    """
    out: Dict[str, Any] = {"exists": False, "pid": None, "created_ts": None, "age_sec": None, "alive": False, "stale": False}
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
    out["alive"] = _pid_is_running(out.get("pid"))
    out["stale"] = bool(out["exists"] and not out["alive"])
    return out


def try_acquire_lock(lock_file: str) -> Tuple[bool, Dict[str, Any]]:
    """Try to create lock file atomically.

    Returns (acquired, lock_info).
    """
    directory = os.path.dirname(lock_file) or "."
    os.makedirs(directory, exist_ok=True)
    thread_guard = _thread_lock(lock_file)
    if not thread_guard.acquire(blocking=False):
        return False, {"exists": True, "alive": True, "stale": False}
    guard_fd = _acquire_process_guard(lock_file + ".guard")
    if guard_fd is None:
        thread_guard.release()
        return False, {"exists": True, "alive": True, "stale": False}
    try:
        info = read_lock(lock_file)
        if info.get("exists") and not info.get("stale"):
            return False, info
        if info.get("stale"):
            try:
                os.remove(lock_file)
            except FileNotFoundError:
                pass
            except OSError:
                return False, read_lock(lock_file)
        payload = _lock_payload()
        try:
            fd = os.open(lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, json.dumps(payload).encode("utf-8"))
            finally:
                os.close(fd)
            info = {"exists": True, **payload, "age_sec": 0.0, "alive": True, "stale": False}
            return True, info
        except FileExistsError:
            return False, read_lock(lock_file)
        except Exception:
            # If lock cannot be created due to FS errors, treat as locked to be safe.
            info = read_lock(lock_file)
            info["exists"] = True
            return False, info
    finally:
        _release_process_guard(guard_fd)
        thread_guard.release()


def transfer_lock(lock_file: str, previous_pid: int) -> bool:
    """Transfer an existing live lock to this process without unlocking it."""

    directory = os.path.dirname(lock_file) or "."
    os.makedirs(directory, exist_ok=True)
    deadline = time.monotonic() + _LOCK_TRANSFER_TIMEOUT_SEC
    thread_guard = _thread_lock(lock_file)
    if not thread_guard.acquire(timeout=_LOCK_TRANSFER_TIMEOUT_SEC):
        return False
    guard_fd = _acquire_process_guard(
        lock_file + ".guard",
        timeout_sec=max(0.0, deadline - time.monotonic()),
    )
    if guard_fd is None:
        thread_guard.release()
        return False
    try:
        info = read_lock(lock_file)
        try:
            expected = int(previous_pid)
            recorded = int(info.get("pid"))
        except (TypeError, ValueError):
            return False
        if not info.get("exists") or recorded != expected:
            return False
        try:
            _atomic_write_json(lock_file, _lock_payload())
        except Exception:
            return False
        return True
    finally:
        _release_process_guard(guard_fd)
        thread_guard.release()


def reconcile_runtime_status(status_file: str, lock_file: str) -> Tuple[Dict[str, Any], Dict[str, Any], bool]:
    """Finalize stale `running` status when the runner is no longer alive.

    This recovers the UI after abrupt runner exits: status.json may still say
    `running`, while the lock file is gone (cleanup on shell EXIT) or stale.
    """

    status = read_status(status_file)
    lock_info = read_lock(lock_file)
    if status.get("state") != "running":
        return status, lock_info, False

    if lock_info.get("alive"):
        return status, lock_info, False

    if _pid_is_running(status.get("pid")):
        return status, lock_info, False

    now = time.time()
    op = str(status.get("op") or "update").strip().lower()
    failed = dict(status)
    failed["state"] = "failed"
    failed["finished_ts"] = failed.get("finished_ts") or now
    failed["updated_ts"] = now
    failed["error"] = "runner_stale"
    failed["message"] = (
        "Предыдущий rollback-runner завершился аварийно. Проверьте update.log."
        if op == "rollback"
        else "Предыдущее обновление завершилось аварийно. Проверьте update.log."
    )
    failed["stale"] = True
    write_status(status_file, failed)
    return failed, lock_info, True


def release_lock(lock_file: str, *, owner_pid: int | None = None) -> None:
    if owner_pid is not None:
        try:
            if int(read_lock(lock_file).get("pid")) != int(owner_pid):
                return
        except (TypeError, ValueError):
            return
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
