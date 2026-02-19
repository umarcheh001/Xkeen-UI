"""Local filesystem helper operations used by the FS API.

These helpers are intentionally Flask-agnostic, so they can be unit-tested and
reused by multiple routes.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import time
from typing import Optional, Tuple


def apply_local_metadata_best_effort(dst_path: str, st0: os.stat_result | None) -> None:
    """Best-effort preserve mode/owner/group when overwriting a local file."""
    from services.filemanager.metadata import _apply_local_metadata_best_effort
    _apply_local_metadata_best_effort(dst_path, st0)


def tmp_free_bytes(tmp_dir: str) -> Optional[int]:
    """Return free bytes for tmp_dir, or None if unavailable."""
    try:
        return int(shutil.disk_usage(str(tmp_dir)).free)
    except Exception:
        return None


def dir_walk_sum_bytes(root: str, *, max_items: int = 200_000) -> Tuple[Optional[int], int, bool]:
    """Best-effort recursive size estimate for local trees.

    Args:
        root: File or directory path.
        max_items: Hard cap on visited entries to avoid hanging on huge trees.

    Returns:
        (bytes|None, items_count, truncated)
    """

    total = 0
    items = 0
    truncated = False

    def _scan_dir(d: str) -> None:
        nonlocal total, items, truncated
        if truncated:
            return
        try:
            with os.scandir(d) as it:
                for entry in it:
                    if truncated:
                        return
                    items += 1
                    if items > int(max_items or 0):
                        truncated = True
                        return
                    try:
                        st = entry.stat(follow_symlinks=False)
                    except Exception:
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            _scan_dir(os.path.join(d, entry.name))
                        else:
                            total += int(getattr(st, "st_size", 0) or 0)
                    except Exception:
                        continue
        except Exception:
            truncated = True

    try:
        if os.path.isfile(root):
            try:
                return int(os.path.getsize(root)), 1, False
            except Exception:
                return None, 1, True
        if not os.path.isdir(root):
            return None, 0, True
        _scan_dir(root)
        return int(total), int(items), bool(truncated)
    except Exception:
        return None, int(items), True


def dir_size_bytes_best_effort(path_abs: str, *, timeout_s: float = 3.0) -> Tuple[Optional[int], Optional[str]]:
    """Return (bytes, error). Best-effort and time-bounded.

    Prefer `du` if available (fast). Fallback to a Python scandir walk.
    We do NOT follow symlinks to avoid loops.
    """

    # 1) Try du -sb (GNU/coreutils). Some busybox builds also support -b.
    try:
        cp = subprocess.run(
            ["du", "-sb", path_abs],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=float(timeout_s),
        )
        if cp.returncode == 0 and cp.stdout:
            tok = cp.stdout.strip().split()[0]
            if tok.isdigit():
                return int(tok), None
    except Exception:
        pass

    # 2) Try du -sk (busybox-friendly). Convert KiB -> bytes.
    try:
        cp = subprocess.run(
            ["du", "-sk", path_abs],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=float(timeout_s),
        )
        if cp.returncode == 0 and cp.stdout:
            tok = cp.stdout.strip().split()[0]
            if tok.isdigit():
                return int(tok) * 1024, None
    except Exception:
        pass

    # 3) Fallback: scandir walk with deadline.
    deadline = time.monotonic() + float(timeout_s)
    total = 0
    stack = [path_abs]
    try:
        while stack:
            if time.monotonic() > deadline:
                return None, "timeout"
            d = stack.pop()
            try:
                with os.scandir(d) as it:
                    for ent in it:
                        if time.monotonic() > deadline:
                            return None, "timeout"
                        try:
                            st = ent.stat(follow_symlinks=False)
                        except Exception:
                            continue
                        mode_i = int(getattr(st, "st_mode", 0) or 0)
                        # Do not follow symlinks. Count the symlink itself as-is.
                        if stat.S_ISLNK(mode_i):
                            total += int(getattr(st, "st_size", 0) or 0)
                            continue
                        if stat.S_ISDIR(mode_i):
                            stack.append(ent.path)
                        else:
                            total += int(getattr(st, "st_size", 0) or 0)
            except (PermissionError, FileNotFoundError):
                continue
        return int(total), None
    except Exception:
        return None, "failed"


# --- basic local FS mutations (mkdir/rename/touch) ---

def mkdir_local(path_abs: str, *, parents: bool = False) -> None:
    """Create a directory at an absolute path.

    Behaviour matches the legacy routes implementation:
    - parents=False: os.mkdir (raises FileExistsError)
    - parents=True: os.makedirs(exist_ok=True)
    """

    if parents:
        os.makedirs(path_abs, exist_ok=True)
    else:
        os.mkdir(path_abs)


def rename_local(src_abs: str, dst_abs: str) -> None:
    """Rename/move a path (absolute paths)."""
    os.rename(src_abs, dst_abs)


def touch_local(
    path_abs: str,
    *,
    create_parents: bool = True,
    create_only: bool = True,
    parent_fallback: str = '/tmp',
) -> bool:
    """Touch a file (absolute path).

    Returns:
        skipped: True if create_only=True and the file already exists.
    """

    if create_parents:
        parent = os.path.dirname(path_abs) or str(parent_fallback or '/tmp')
        os.makedirs(parent, exist_ok=True)

    if create_only and os.path.exists(path_abs):
        return True

    if not os.path.exists(path_abs):
        # create empty file
        with open(path_abs, 'a', encoding='utf-8'):
            pass

    os.utime(path_abs, None)
    return False
