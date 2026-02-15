"""Helpers for Xray config backups/snapshots.

We keep two kinds of backup artifacts in the same BACKUP_DIR:

1) History (manual / timestamp): 05_routing-YYYYMMDD-HHMMSS.json
2) Snapshots by file name: 02_dns.json, 07_observatory.json, ...

Snapshot semantics:
  - snapshot file is updated on every overwrite as a rollback aid
  - it stores the *previous* content of the config file being overwritten.

All helpers are defensive: they either return a safe result or no-op.
"""

from __future__ import annotations

import os
import re
import time
from typing import Optional, Tuple


_HISTORY_RE = re.compile(r"^.+-\d{8}-\d{6}\.jsonc?$")


def is_hidden_filename(name: str) -> bool:
    try:
        return str(name or "").startswith(".")
    except Exception:
        return False


def is_history_backup_filename(name: str) -> bool:
    """True for history backup files (manual timestamp)."""
    try:
        n = str(name or "")
    except Exception:
        return False
    if not n:
        return False
    if is_hidden_filename(n):
        return False
    if ".auto-backup-" in n:
        return False
    if not (n.endswith(".json") or n.endswith(".jsonc")):
        return False
    return bool(_HISTORY_RE.match(n))


def is_snapshot_filename(name: str) -> bool:
    """True for snapshot files (02_dns.json, 07_observatory.json, ...)."""
    try:
        n = str(name or "")
    except Exception:
        return False
    if not n:
        return False
    if is_hidden_filename(n):
        return False
    if ".auto-backup-" in n:
        return False
    if not (n.endswith(".json") or n.endswith(".jsonc")):
        return False
    # Exclude history backups with timestamp suffix.
    if _HISTORY_RE.match(n):
        return False
    return True


def safe_basename(name: str) -> Optional[str]:
    """Return a safe basename (no slashes), or None."""
    try:
        n = str(name or "").strip()
    except Exception:
        return None
    if not n:
        return None
    if "/" in n or "\\" in n:
        return None
    bn = os.path.basename(n)
    if not bn or bn != n:
        return None
    return bn


def safe_child_realpath(base_dir: str, child_basename: str) -> Optional[str]:
    """Resolve child path and ensure it stays within base_dir (realpath-safe)."""
    bn = safe_basename(child_basename)
    if not bn:
        return None
    try:
        base_real = os.path.realpath(base_dir)
        cand = os.path.join(base_real, bn)
        cand_real = os.path.realpath(cand)
        if cand_real == base_real:
            return None
        if not cand_real.startswith(base_real + os.sep):
            return None
        return cand_real
    except Exception:
        return None


def format_mtime(ts: float) -> str:
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(float(ts)))
    except Exception:
        return ""


def read_text_limited(path: str, max_bytes: int = 512 * 1024) -> Tuple[str, bool, int]:
    """Read UTF-8 text with a size limit.

    Returns: (text, truncated, size)
    """
    try:
        st = os.stat(path)
        size = int(st.st_size)
    except Exception:
        size = 0

    truncated = False
    raw = b""
    try:
        with open(path, "rb") as f:
            if size and size > max_bytes:
                raw = f.read(max_bytes)
                truncated = True
            else:
                raw = f.read(max_bytes + 1)
                if len(raw) > max_bytes:
                    raw = raw[:max_bytes]
                    truncated = True
    except Exception:
        return "", False, size

    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception:
        try:
            text = str(raw)
        except Exception:
            text = ""
    return text, truncated, size


def _read_bytes_limited(path: str, max_bytes: int) -> Tuple[bytes, bool, int]:
    """Read bytes with size limit. Returns (data, truncated, size)."""
    try:
        st = os.stat(path)
        size = int(st.st_size)
    except Exception:
        size = 0

    truncated = False
    data = b""
    try:
        with open(path, "rb") as f:
            if size and size > max_bytes:
                data = f.read(max_bytes)
                truncated = True
            else:
                data = f.read(max_bytes + 1)
                if len(data) > max_bytes:
                    data = data[:max_bytes]
                    truncated = True
    except Exception:
        return b"", False, size
    return data, truncated, size


def atomic_write_bytes(dst_path: str, data: bytes, mode: Optional[int] = None) -> bool:
    """Atomically write bytes to dst_path (best-effort).

    Returns True on success, False otherwise. Never raises.
    """
    try:
        d = os.path.dirname(dst_path)
        if d and not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)
    except Exception:
        pass

    tmp = None
    try:
        tmp = f"{dst_path}.tmp.{os.getpid()}.{int(time.time() * 1000)}"
        with open(tmp, "wb") as f:
            f.write(data or b"")
            try:
                f.flush()
                os.fsync(f.fileno())
            except Exception:
                pass
        if mode is not None:
            try:
                os.chmod(tmp, int(mode))
            except Exception:
                pass
        os.replace(tmp, dst_path)
        return True
    except Exception:
        try:
            if tmp and os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        return False


def is_xray_config_path(
    abs_path: str,
    *,
    xray_configs_dir_real: str,
    backup_dir_real: str,
) -> bool:
    """Return True if abs_path points to an Xray config fragment we want to snapshot."""
    try:
        rp = os.path.realpath(str(abs_path or ""))
    except Exception:
        return False
    if not rp:
        return False
    try:
        base = os.path.realpath(str(xray_configs_dir_real or ""))
        bkp = os.path.realpath(str(backup_dir_real or ""))
    except Exception:
        return False

    if not base:
        return False
    if not (rp == base or rp.startswith(base + os.sep)):
        return False
    if bkp and (rp == bkp or rp.startswith(bkp + os.sep)):
        return False
    if not (rp.endswith(".json") or rp.endswith(".jsonc")):
        return False
    return True


def snapshot_before_overwrite(
    abs_path: str,
    *,
    backup_dir: str,
    xray_configs_dir_real: str,
    backup_dir_real: str,
    max_bytes: int = 5 * 1024 * 1024,
) -> bool:
    """Create/update a snapshot for abs_path before it is overwritten.

    Snapshot is written to BACKUP_DIR/<basename>, containing previous content.
    Returns True if snapshot was written, False otherwise. Never raises.
    """
    try:
        if not abs_path:
            return False
        rp = os.path.realpath(abs_path)
        if not is_xray_config_path(rp, xray_configs_dir_real=xray_configs_dir_real, backup_dir_real=backup_dir_real):
            return False
        if not os.path.isfile(rp):
            return False
    except Exception:
        return False

    try:
        bn = os.path.basename(rp)
        dst = safe_child_realpath(backup_dir, bn)
        if not dst:
            return False
    except Exception:
        return False

    st0 = None
    try:
        st0 = os.stat(rp)
    except Exception:
        st0 = None

    data, truncated, _size = _read_bytes_limited(rp, max_bytes)
    if truncated:
        # We refuse to snapshot huge files; this should never happen for Xray configs.
        return False

    mode = None
    try:
        if st0 is not None:
            mode = int(getattr(st0, "st_mode", 0) or 0) & 0o7777
    except Exception:
        mode = None

    ok = atomic_write_bytes(dst, data, mode=mode)
    if not ok:
        return False

    # Best-effort ownership restore.
    try:
        if st0 is not None:
            uid = int(getattr(st0, "st_uid", -1))
            gid = int(getattr(st0, "st_gid", -1))
            if uid >= 0 and gid >= 0:
                try:
                    os.chown(dst, uid, gid)
                except Exception:
                    pass
    except Exception:
        pass
    return True
