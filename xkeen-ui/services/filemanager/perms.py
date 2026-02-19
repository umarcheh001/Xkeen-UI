"""Filesystem permissions helpers (Flask-agnostic)."""

from __future__ import annotations

import os
import re
from typing import Any


def parse_mode_value(mode_v: Any) -> int:
    """Parse chmod mode value.

    Accepts:
      - int
      - strings like "644", "0755", "0o755"
      - decimal strings
    """

    if mode_v is None:
        raise RuntimeError('mode_required')
    if isinstance(mode_v, int):
        return int(mode_v)
    s = str(mode_v).strip().lower()
    if not s:
        raise RuntimeError('mode_required')
    if s.startswith('0o'):
        return int(s, 8)
    if re.match(r'^[0-7]{3,4}$', s):
        return int(s, 8)
    return int(s, 10)


def chmod_local(path_abs: str, mode_i: int) -> None:
    os.chmod(path_abs, int(mode_i))


def chown_local(path_abs: str, uid: int, gid: int = -1) -> None:
    os.chown(path_abs, int(uid), int(gid))
