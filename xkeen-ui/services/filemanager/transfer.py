"""File transfer helpers (upload/download staging).

These helpers are Flask-agnostic and can be used by both local and remote
filesystem endpoints.

Commit 5 goal: start pulling upload/download staging out of routes.
"""

from __future__ import annotations

import os
import uuid
from typing import BinaryIO, Iterable, Optional


def save_stream_to_tmp(
    stream: BinaryIO,
    *,
    tmp_dir: str,
    prefix: str = "xkeen_upload_",
    max_bytes: Optional[int] = None,
    chunk_size: int = 64 * 1024,
) -> tuple[str, int]:
    """Save a binary stream into a temporary file.

    Args:
        stream: file-like object with .read().
        tmp_dir: directory for temporary file.
        prefix: file name prefix.
        max_bytes: optional hard limit; if exceeded raises ValueError('too_large').
        chunk_size: read size.

    Returns:
        (tmp_path, total_bytes)

    Raises:
        ValueError('too_large') if max_bytes exceeded.
    """
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_path = os.path.join(tmp_dir, f"{prefix}{uuid.uuid4().hex}.tmp")
    total = 0
    try:
        with open(tmp_path, "wb") as outfp:
            while True:
                chunk = stream.read(chunk_size)
                if not chunk:
                    break
                total += len(chunk)
                if max_bytes is not None and total > int(max_bytes):
                    raise ValueError("too_large")
                outfp.write(chunk)
        return tmp_path, total
    except Exception:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        raise


def save_filestorage_to_tmp(
    file_storage: object,
    *,
    tmp_dir: str,
    prefix: str = "xkeen_upload_",
    max_bytes: Optional[int] = None,
    chunk_size: int = 64 * 1024,
) -> tuple[str, int]:
    """Save a Werkzeug FileStorage (or similar) into a temp file.

    This function intentionally avoids importing Werkzeug. It expects the object
    to expose `.stream` with `.read()`.

    Raises ValueError('no_stream') if stream is missing.
    """
    stream = getattr(file_storage, "stream", None)
    if stream is None:
        raise ValueError("no_stream")
    return save_stream_to_tmp(stream, tmp_dir=tmp_dir, prefix=prefix, max_bytes=max_bytes, chunk_size=chunk_size)


def stream_file_then_cleanup(
    file_path: str,
    *,
    chunk_size: int = 64 * 1024,
    cleanup_files: Optional[Iterable[str]] = None,
    cleanup_dirs: Optional[Iterable[str]] = None,
):
    """Yield file bytes and cleanup on completion.

    Intended for Flask Response streaming.
    """

    def _gen():
        fp = None
        try:
            fp = open(file_path, "rb")
            while True:
                chunk = fp.read(chunk_size)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                if fp:
                    fp.close()
            except Exception:
                pass
            for fpath in list(cleanup_files or []):
                try:
                    if fpath and os.path.exists(fpath):
                        os.remove(fpath)
                except Exception:
                    pass
            for dpath in list(cleanup_dirs or []):
                try:
                    if dpath:
                        import shutil

                        shutil.rmtree(dpath, ignore_errors=True)
                except Exception:
                    pass

    return _gen()
