"""Trash operations for local filesystem.

These helpers are Flask-agnostic and build on the shared local FS sandbox
logic in :mod:`services.fs_common.local`.
"""

from __future__ import annotations

import os
import shutil
from typing import Any, Dict, List, Tuple

from services.fs_common.local import (
    _TRASH_META_DIRNAME,
    _local_resolve_nofollow,
    _local_soft_delete,
    _local_restore_from_trash,
    _local_trash_dirs,
)


def soft_delete_local(path_abs: str, localfs_roots: List[str], *, hard: bool = False) -> Dict[str, Any]:
    """Move entry into trash (default) or delete permanently (hard=True).

    Backwards-compatible helper.

    Prefer :func:`remove_local` which also performs "not found" checks.
    """

    return _local_soft_delete(path_abs, localfs_roots, hard=bool(hard))


def remove_local(path: str, localfs_roots: List[str], *, hard: bool = False) -> Dict[str, Any]:
    """Delete a local entry by user-supplied path.

    - Enforces root allowlist.
    - Uses ``lexists`` so broken symlinks can still be removed.
    - Performs a soft delete (trash) by default, unless ``hard=True``.

    Raises:
      - PermissionError: path not allowed / protected / mountpoint, etc.
      - FileNotFoundError: entry does not exist.
      - Exception: on other failures.
    """

    ap = _local_resolve_nofollow(path, localfs_roots)
    if not os.path.lexists(ap):
        raise FileNotFoundError('not_found')
    return _local_soft_delete(ap, localfs_roots, hard=bool(hard))


def restore_local_from_trash(paths: List[str], localfs_roots: List[str]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Restore items from trash.

    Returns (restored, errors).
    """

    restored: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    for pth in paths:
        try:
            info = _local_restore_from_trash(pth, localfs_roots)
            restored.append(info)
        except PermissionError as e:
            errors.append({'path': pth, 'error': str(e)})
        except Exception as e:
            errors.append({'path': pth, 'error': str(e) or 'restore_failed'})
    return restored, errors


def clear_local_trash(localfs_roots: List[str]) -> Dict[str, Any]:
    """Permanently remove everything inside the local trash directory.

    Returns { deleted, meta_deleted, errors }.
    """

    trash_root, meta_dir = _local_trash_dirs(localfs_roots)

    # Ensure directories exist.
    os.makedirs(trash_root, exist_ok=True)
    os.makedirs(meta_dir, exist_ok=True)

    deleted = 0
    meta_deleted = 0
    errors: List[Dict[str, Any]] = []

    # Delete content of trash root, but keep metadata dir itself.
    with os.scandir(trash_root) as it:
        for entry in it:
            try:
                if entry.name == _TRASH_META_DIRNAME:
                    continue
                p = entry.path
                if entry.is_dir(follow_symlinks=False):
                    shutil.rmtree(p)
                else:
                    os.unlink(p)
                deleted += 1
            except Exception as e:
                errors.append({'path': entry.path, 'error': str(e) or 'delete_failed'})

    # Clear meta files
    try:
        with os.scandir(meta_dir) as it:
            for entry in it:
                try:
                    p = entry.path
                    if entry.is_dir(follow_symlinks=False):
                        shutil.rmtree(p)
                    else:
                        os.unlink(p)
                    meta_deleted += 1
                except Exception as e:
                    errors.append({'path': entry.path, 'error': str(e) or 'delete_failed'})
    except Exception:
        pass

    return {
        'deleted': int(deleted),
        'meta_deleted': int(meta_deleted),
        'errors': errors,
    }
