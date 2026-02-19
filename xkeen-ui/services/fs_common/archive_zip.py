"""ZIP archive helpers for local file manager.

Moved from routes_remotefs.py to break routes->routes imports.
"""

from __future__ import annotations

import os
import zipfile
from typing import List, Tuple

def _zip_directory(src_dir: str, zip_path: str, *, root_name: str) -> None:
    """Create ZIP archive from a directory.

    - `root_name` becomes the top-level folder in the archive.
    - Symlinks are skipped for safety/stability on embedded systems.
    """
    src_dir = os.path.abspath(src_dir)
    root_name = (root_name or 'download').strip().strip('/') or 'download'
    # ZIP_DEFLATED requires zlib; on some embedded Python builds it may be missing.
    try:
        import zlib  # noqa: F401
        comp = zipfile.ZIP_DEFLATED
    except Exception:
        comp = zipfile.ZIP_STORED

    # Ensure parent exists
    os.makedirs(os.path.dirname(zip_path) or '.', exist_ok=True)

    with zipfile.ZipFile(zip_path, 'w', compression=comp, allowZip64=True) as zf:
        # Add empty root dir entry (some unzip tools show it nicely)
        try:
            zf.writestr(root_name.rstrip('/') + '/', b'')
        except Exception:
            pass

        for dirpath, dirnames, filenames in os.walk(src_dir, topdown=True, followlinks=False):
            # Skip symlinked directories (os.walk won't follow, but entries are in dirnames)
            safe_dirnames = []
            for d in list(dirnames):
                full = os.path.join(dirpath, d)
                try:
                    if os.path.islink(full):
                        continue
                except Exception:
                    continue
                safe_dirnames.append(d)
            dirnames[:] = safe_dirnames

            rel_dir = os.path.relpath(dirpath, src_dir)
            rel_dir = '' if rel_dir == '.' else rel_dir

            # Preserve empty directories
            if not filenames and not dirnames:
                arc_dir = os.path.join(root_name, rel_dir).replace(os.sep, '/')
                if not arc_dir.endswith('/'):
                    arc_dir += '/'
                try:
                    zf.writestr(arc_dir, b'')
                except Exception:
                    pass

            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                try:
                    if os.path.islink(fp):
                        continue
                except Exception:
                    continue
                arc = os.path.join(root_name, rel_dir, fn).replace(os.sep, '/')
                try:
                    zf.write(fp, arc)
                except Exception:
                    # Best-effort: skip unreadable files
                    continue

def _zip_add_dir_to_zip(zf: zipfile.ZipFile, src_dir: str, arc_root: str) -> None:
    """Add directory tree into an open ZipFile under arc_root.

    Symlinks are skipped for safety/stability on embedded systems.
    """
    src_dir = os.path.abspath(src_dir)
    arc_root = (arc_root or 'download').strip().strip('/') or 'download'

    # Add root dir entry
    try:
        zf.writestr(arc_root.rstrip('/') + '/', b'')
    except Exception:
        pass

    for dirpath, dirnames, filenames in os.walk(src_dir, topdown=True, followlinks=False):
        # Skip symlinked directories
        safe_dirnames = []
        for d in list(dirnames):
            full = os.path.join(dirpath, d)
            try:
                if os.path.islink(full):
                    continue
            except Exception:
                continue
            safe_dirnames.append(d)
        dirnames[:] = safe_dirnames

        rel_dir = os.path.relpath(dirpath, src_dir)
        rel_dir = '' if rel_dir == '.' else rel_dir

        # Preserve empty directories
        if not filenames and not dirnames:
            arc_dir = os.path.join(arc_root, rel_dir).replace(os.sep, '/')
            if not arc_dir.endswith('/'):
                arc_dir += '/'
            try:
                zf.writestr(arc_dir, b'')
            except Exception:
                pass

        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            try:
                if os.path.islink(fp):
                    continue
            except Exception:
                continue
            arc = os.path.join(arc_root, rel_dir, fn).replace(os.sep, '/')
            try:
                zf.write(fp, arc)
            except Exception:
                continue


def _zip_add_path(zf: zipfile.ZipFile, src_path: str, arc_name: str) -> None:
    """Add a file or directory to an open ZipFile under arc_name."""
    src_path = os.path.abspath(src_path)
    arc_name = (arc_name or 'item').strip().strip('/') or 'item'
    # Avoid weird absolute paths inside archive
    arc_name = arc_name.replace('..', '_').lstrip('/').lstrip('\\')
    if os.path.isdir(src_path):
        _zip_add_dir_to_zip(zf, src_path, arc_name)
        return
    if os.path.isfile(src_path):
        try:
            if os.path.islink(src_path):
                return
        except Exception:
            pass
        try:
            zf.write(src_path, arc_name.replace(os.sep, '/'))
        except Exception:
            pass
        return


def _zip_selection_local(resolved: List[Tuple[str, str]], zip_path: str, *, root_name: str) -> None:
    """Create a ZIP of multiple resolved local paths.

    `resolved` is a list of (real_path, display_name).
    The archive will contain a top-level folder `root_name`.
    """
    root_name = (root_name or 'selection').strip().strip('/') or 'selection'

    try:
        import zlib  # noqa: F401
        comp = zipfile.ZIP_DEFLATED
    except Exception:
        comp = zipfile.ZIP_STORED

    os.makedirs(os.path.dirname(zip_path) or '.', exist_ok=True)

    used: set[str] = set()
    with zipfile.ZipFile(zip_path, 'w', compression=comp, allowZip64=True) as zf:
        # Add root dir entry
        try:
            zf.writestr(root_name.rstrip('/') + '/', b'')
        except Exception:
            pass

        for rp, name in resolved:
            base = os.path.basename(name.rstrip('/')) or os.path.basename(rp.rstrip('/')) or 'item'
            base = base.replace('..', '_').replace('/', '_').replace('\\', '_') or 'item'
            arc = f"{root_name}/{base}"
            # Ensure unique
            if arc in used:
                n = 2
                while f"{arc}_{n}" in used:
                    n += 1
                arc = f"{arc}_{n}"
            used.add(arc)
            _zip_add_path(zf, rp, arc)


