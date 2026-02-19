"""Local filesystem backend helpers for FileOps.

These functions are intentionally *best-effort* with respect to metadata
(permissions/ownership/timestamps) so that basic copy/move operations work
reliably on diverse mounts (exFAT/NTFS/FAT, some FUSE drivers, etc.).
"""

from __future__ import annotations

import os
import shutil
import stat


def _copyfile_no_stat(src: str, dst: str) -> None:
    """Copy file bytes and try (but never require) metadata."""
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    shutil.copyfile(src, dst, follow_symlinks=False)
    try:
        shutil.copystat(src, dst, follow_symlinks=False)
    except Exception:
        pass


def _copytree_no_stat(src_dir: str, dst_dir: str) -> None:
    """Recursively copy a directory without failing on metadata errors."""
    os.makedirs(dst_dir, exist_ok=True)
    with os.scandir(src_dir) as it:
        for entry in it:
            sp = entry.path
            dp = os.path.join(dst_dir, entry.name)
            try:
                if entry.is_symlink():
                    try:
                        os.symlink(os.readlink(sp), dp)
                    except FileExistsError:
                        pass
                    continue
                if entry.is_dir(follow_symlinks=False):
                    _copytree_no_stat(sp, dp)
                else:
                    _copyfile_no_stat(sp, dp)
            except Exception:
                # Best-effort: continue copying other entries.
                continue
    try:
        shutil.copystat(src_dir, dst_dir, follow_symlinks=False)
    except Exception:
        pass


def _safe_move_no_stat(src: str, dst: str) -> None:
    """Move path, falling back to copy+delete, without strict metadata."""
    try:
        os.rename(src, dst)
        return
    except Exception:
        pass

    st = os.lstat(src)
    if stat.S_ISLNK(st.st_mode):
        os.symlink(os.readlink(src), dst)
        os.unlink(src)
        return

    if stat.S_ISDIR(st.st_mode):
        _copytree_no_stat(src, dst)
        shutil.rmtree(src, ignore_errors=True)
        return

    _copyfile_no_stat(src, dst)
    try:
        os.unlink(src)
    except IsADirectoryError:
        shutil.rmtree(src, ignore_errors=True)
