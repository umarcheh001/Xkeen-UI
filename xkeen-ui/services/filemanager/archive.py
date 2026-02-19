"""Archive helpers.

This module is Flask-agnostic and is intended to hold reusable logic shared by
local and remote FS endpoints.

Commit 6 goal: start extracting archive-related helpers out of routes.
"""

from __future__ import annotations

import os
import re
import stat
import time
import tarfile
import zipfile
from typing import Any, Dict, List, Tuple


def sanitize_zip_filename(name: str) -> str:
    """Sanitize a ZIP file name (leaf only) and enforce .zip extension."""
    n = os.path.basename(str(name or "").strip()) or "selection.zip"
    n = n.replace('"', "").replace("'", "")
    if not n.lower().endswith(".zip"):
        n += ".zip"
    return n


def sanitize_root_name(name: str) -> str:
    """Sanitize ZIP root folder name (single folder component)."""
    s = str(name or "").strip()
    if not s:
        return "selection"
    s = s.replace("\\", "/")
    s = s.strip("/").strip()
    s = os.path.basename(s) or "selection"
    s = re.sub(r"[^0-9A-Za-z._-]+", "_", s)[:64] or "selection"
    return s


def normalize_selection_items(items_raw: Any) -> List[Dict[str, Any]]:
    """Normalize UI selection list into a list of dicts.

    Accepts either:
      - list[str]
      - list[{path,name,is_dir}]
    """
    items: List[Dict[str, Any]] = []
    if not isinstance(items_raw, list):
        return items
    for it in items_raw:
        if isinstance(it, str):
            path = str(it).strip()
            if not path:
                continue
            items.append({"path": path, "name": os.path.basename(path.rstrip("/")) or path, "is_dir": None})
        elif isinstance(it, dict):
            path = str(it.get("path") or "").strip()
            if not path:
                continue
            name = str(it.get("name") or os.path.basename(path.rstrip("/")) or path).strip()
            is_dir = it.get("is_dir", None)
            if isinstance(is_dir, str):
                is_dir = is_dir.strip().lower() in ("1", "true", "yes", "on")
            elif not isinstance(is_dir, bool):
                is_dir = None
            items.append({"path": path, "name": name, "is_dir": is_dir})
    return items


def sanitize_archive_filename(name: str, fmt: str) -> str:
    """Sanitize archive filename (leaf only) and enforce extension."""
    n = os.path.basename(str(name or "").strip())
    n = n.replace('"', "").replace("'", "")
    n = re.sub(r"\s+", " ", n).strip()
    if not n:
        n = "archive"

    f = str(fmt or "").strip().lower()
    if f in ("tgz", "tar.gz", "tar_gz", "targz"):
        ext = ".tar.gz"
        n = re.sub(r"(\.(zip|tgz|tar\.gz))$", "", n, flags=re.IGNORECASE)
        return (n or "archive") + ext

    ext = ".zip"
    n = re.sub(r"(\.(zip|tgz|tar\.gz))$", "", n, flags=re.IGNORECASE)
    return (n or "archive") + ext


def join_local_cwd(cwd: str, leaf: str) -> str:
    """Join absolute cwd with a leaf/relative path, returning a UI-style absolute path."""
    c = str(cwd or "").strip() or "/"
    if not c.startswith("/"):
        c = "/" + c
    c = re.sub(r"/+", "/", c)
    if len(c) > 1:
        c = c.rstrip("/")
    return c + "/" + str(leaf or "").lstrip("/").replace("\\", "/")


def is_safe_extract_path(dest_root_abs: str, rel_name: str) -> bool:
    """Reject absolute paths and path traversal outside the destination."""
    if not rel_name:
        return False
    rn = rel_name.replace("\\", "/")
    if rn.startswith("/"):
        return False
    out = os.path.abspath(os.path.join(dest_root_abs, rn))
    dest_root_abs = os.path.abspath(dest_root_abs)
    if out == dest_root_abs:
        return True
    return out.startswith(dest_root_abs.rstrip(os.sep) + os.sep)


def zipinfo_is_symlink(zinfo: zipfile.ZipInfo) -> bool:
    try:
        mode = (zinfo.external_attr >> 16) & 0xFFFF
        return stat.S_ISLNK(mode)
    except Exception:
        return False


def list_archive_contents(rp_arch: str, *, max_items: int = 2000) -> Tuple[List[Dict[str, Any]], bool]:
    """List archive contents for .zip and .tar.* files."""
    max_items = max(1, min(int(max_items or 2000), 10000))
    lower = str(rp_arch or "").lower()
    items: List[Dict[str, Any]] = []
    truncated = False

    def _push(name: str, size: int, mtime: int, is_dir: bool, is_link: bool) -> None:
        nonlocal truncated
        if len(items) >= max_items:
            truncated = True
            return
        items.append(
            {
                "name": name,
                "size": int(size or 0),
                "mtime": int(mtime or 0),
                "is_dir": bool(is_dir),
                "is_link": bool(is_link),
            }
        )

    if lower.endswith(".zip"):
        with zipfile.ZipFile(rp_arch, "r") as zf:
            for zi in zf.infolist():
                if truncated:
                    break
                nm = (zi.filename or "").replace("\\", "/")
                while nm.startswith("./"):
                    nm = nm[2:]
                if not nm or nm in (".", "./"):
                    continue
                is_dir = nm.endswith("/")
                is_link = zipinfo_is_symlink(zi)
                mtime = 0
                try:
                    dt = zi.date_time
                    mtime = int(time.mktime((dt[0], dt[1], dt[2], dt[3], dt[4], dt[5], 0, 0, -1)))
                except Exception:
                    mtime = 0
                _push(nm.rstrip("/"), int(getattr(zi, "file_size", 0) or 0), mtime, is_dir, is_link)
        return items, truncated

    if (
        lower.endswith(".tar")
        or lower.endswith(".tar.gz")
        or lower.endswith(".tgz")
        or lower.endswith(".tar.xz")
        or lower.endswith(".txz")
        or lower.endswith(".tar.bz2")
        or lower.endswith(".tbz")
        or lower.endswith(".tbz2")
    ):
        with tarfile.open(rp_arch, "r:*") as tf:
            for ti in tf.getmembers():
                if truncated:
                    break
                nm = (ti.name or "").replace("\\", "/")
                while nm.startswith("./"):
                    nm = nm[2:]
                if not nm or nm in (".", "./"):
                    continue
                is_dir = bool(ti.isdir() or nm.endswith("/"))
                is_link = bool(ti.issym() or ti.islnk())
                _push(nm.rstrip("/"), int(getattr(ti, "size", 0) or 0), int(getattr(ti, "mtime", 0) or 0), is_dir, is_link)
        return items, truncated

    raise ValueError("unsupported_archive")
