"""Small file IO helpers.

Keep these minimal and dependency-free.
"""

from __future__ import annotations

import os

_READ_ENCODINGS = ("utf-8-sig", "cp1251")


def load_text(path: str, default: str = "") -> str:
    try:
        last_error = None
        for encoding in _READ_ENCODINGS:
            try:
                with open(path, "r", encoding=encoding) as f:
                    return f.read()
            except UnicodeDecodeError as error:
                last_error = error
        if last_error is not None:
            raise last_error
    except FileNotFoundError:
        return default


def save_text(path: str, content: str) -> None:
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
