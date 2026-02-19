"""Small file IO helpers.

Keep these minimal and dependency-free.
"""

from __future__ import annotations

import os


def load_text(path: str, default: str = "") -> str:
    try:
        with open(path, "r") as f:
            return f.read()
    except FileNotFoundError:
        return default


def save_text(path: str, content: str) -> None:
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(path, "w") as f:
        f.write(content)
