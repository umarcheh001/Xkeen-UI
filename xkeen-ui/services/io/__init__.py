"""IO helpers.

These modules should be safe to use from services and routes.

Keep the API small and boring:
- read_json(): best-effort JSON loader with defaults
- safe_write_text(): crash-safe atomic text writes
"""

from __future__ import annotations

from .helpers import read_json, safe_write_text

__all__ = [
    "read_json",
    "safe_write_text",
]
