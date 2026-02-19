"""Spool directory manager for FileOps.

Used mainly for remote->remote transfers where data needs to pass through
local temporary storage.
"""

from __future__ import annotations

import os
import shutil
import uuid
from typing import List


class SpoolManager:
    def __init__(self, *, base_dir: str, max_bytes: int, cleanup_age_seconds: int = 21600, now_fn=None) -> None:
        self.base_dir = str(base_dir)
        self.max_bytes = int(max_bytes or 0)
        self.cleanup_age_seconds = int(cleanup_age_seconds or 0)
        self._now = now_fn or (lambda: __import__('time').time())

    def ensure_dir(self) -> str:
        try:
            os.makedirs(self.base_dir, exist_ok=True)
        except Exception:
            pass
        return self.base_dir

    def tmp_file(self, *, ext: str = '') -> str:
        base = self.ensure_dir()
        name = f"spool_{uuid.uuid4().hex[:10]}"
        if ext:
            if not ext.startswith('.'):
                ext = '.' + ext
            name += ext
        return os.path.join(base, name)

    def tmp_dir(self) -> str:
        base = self.ensure_dir()
        p = os.path.join(base, f"spooldir_{uuid.uuid4().hex[:10]}")
        try:
            os.makedirs(p, exist_ok=True)
        except Exception:
            pass
        return p

    def dir_size_bytes(self, path: str, *, stop_after: int | None = None) -> int:
        """Compute directory/file size in bytes (best-effort)."""
        total = 0
        try:
            if os.path.isfile(path):
                return int(os.path.getsize(path))
        except Exception:
            return 0

        stack: List[str] = [path]
        while stack:
            cur = stack.pop()
            try:
                with os.scandir(cur) as it:
                    for entry in it:
                        try:
                            if entry.is_symlink():
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(entry.path)
                                continue
                            if entry.is_file(follow_symlinks=False):
                                try:
                                    total += int(entry.stat(follow_symlinks=False).st_size or 0)
                                except Exception:
                                    pass
                                if stop_after is not None and total > stop_after:
                                    return total
                        except Exception:
                            continue
            except Exception:
                continue
        return total

    def cleanup_stale(self) -> None:
        """Best-effort cleanup of stale spool items left after crashes."""
        if not self.cleanup_age_seconds:
            return
        base = self.ensure_dir()
        cutoff = self._now() - float(self.cleanup_age_seconds)
        try:
            with os.scandir(base) as it:
                for entry in it:
                    name = entry.name
                    if not (name.startswith('spool_') or name.startswith('spooldir_')):
                        continue
                    try:
                        st = entry.stat(follow_symlinks=False)
                        if float(st.st_mtime) > cutoff:
                            continue
                    except Exception:
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            shutil.rmtree(entry.path)
                        else:
                            os.remove(entry.path)
                    except Exception:
                        pass
        except Exception:
            pass

    def check_limit(self, size_bytes: int) -> None:
        if size_bytes <= 0:
            return
        if self.max_bytes and size_bytes > self.max_bytes:
            raise RuntimeError('spool_limit_exceeded')


__all__ = ['SpoolManager']
