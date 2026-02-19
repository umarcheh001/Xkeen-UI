"""Checksum helpers for /api/fs/checksum."""

from __future__ import annotations

import hashlib
from typing import BinaryIO, Tuple


def hash_stream(fp: BinaryIO, *, chunk_bytes: int = 256 * 1024) -> Tuple[str, str, int]:
    """Compute md5 and sha256 hashes for a binary stream.

    Returns (md5_hex, sha256_hex, total_bytes_read).
    """

    md5 = hashlib.md5()
    sha = hashlib.sha256()
    total = 0
    while True:
        chunk = fp.read(int(chunk_bytes))
        if not chunk:
            break
        total += len(chunk)
        md5.update(chunk)
        sha.update(chunk)
    return md5.hexdigest(), sha.hexdigest(), int(total)


def hash_file(path_abs: str, *, chunk_bytes: int = 256 * 1024) -> Tuple[str, str, int]:
    with open(path_abs, 'rb') as fp:
        return hash_stream(fp, chunk_bytes=chunk_bytes)
