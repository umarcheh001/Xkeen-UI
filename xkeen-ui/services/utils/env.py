"""Environment helpers.

Keep conversions tolerant: routers often have minimal shells and
environment values may be empty or non-integers.
"""

from __future__ import annotations

import os


def _read_int_env(name: str, default: int = 0) -> int:
    """Read an int-ish env var.

    Accepts "10", "10.0" etc. Empty/missing -> default.
    """
    try:
        v = str(os.getenv(name, "") or "").strip()
        if not v:
            return int(default)
        return int(float(v))
    except Exception:
        return int(default)


def _read_float_env(name: str, default: float = 0.0) -> float:
    """Read a float-ish env var. Empty/missing -> default."""
    try:
        v = str(os.getenv(name, "") or "").strip()
        if not v:
            return float(default)
        return float(v)
    except Exception:
        return float(default)


def _env_bool(name: str, default: bool = False) -> bool:
    """Read a boolean env var.

    Truthy: 1, true, yes, y, on
    Falsy:  0, false, no, n, off
    """
    try:
        v = str(os.getenv(name, "") or "").strip().lower()
        if not v:
            return bool(default)
        if v in {"1", "true", "yes", "y", "on"}:
            return True
        if v in {"0", "false", "no", "n", "off"}:
            return False
        # Fallback: anything else is treated as default to avoid surprises.
        return bool(default)
    except Exception:
        return bool(default)
