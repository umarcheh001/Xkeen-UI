"""JSON read/write helpers (with JSONC comment stripping for reads)."""

from __future__ import annotations

import json
import os

from .jsonc import strip_json_comments_text


def load_json(path: str, default=None):
    """Load JSON from file.

    - Supports JSONC-ish comments (//, #, /* */) by stripping them before parsing.
    - Returns `default` on FileNotFoundError or JSONDecodeError.
    """
    try:
        with open(path, "r") as f:
            raw = f.read()
        cleaned = strip_json_comments_text(raw)
        if not cleaned.strip():
            return default
        return json.loads(cleaned)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: str, data) -> None:
    """Save JSON to file (pretty-printed)."""
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
