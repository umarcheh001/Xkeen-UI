"""Remote directory listing parsing helpers (ls -l).

Moved from routes_remotefs.py to break routes->routes imports.
"""

from __future__ import annotations

import re
import time
from typing import Any, Dict, Optional


def _now() -> float:
    """Unix timestamp helper (seconds)."""
    return time.time()


# Month token map used by typical FTP/SFTP `ls -l` listings.
_MONTHS: Dict[str, int] = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}

def _parse_ls_line(line: str, *, now_ts: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """Best-effort parse of an ls -l style line produced by lftp `cls -l`.

    FTP/SFTP listings vary across servers. We use a forgiving token-based parser:
    - Detect permissions token (e.g. drwxr-xr-x)
    - Find month token (Jan/Feb/...) in the line
    - Treat the token right before month as size
    - Everything after (month day time|year) is the name (may include spaces)
    """
    s = (line or "").rstrip("\n").strip()
    if not s or s.startswith("total "):
        return None

    parts = s.split()
    if len(parts) < 6:
        return None

    perm = parts[0]
    # Must start with a file type char + 9 mode chars
    if not re.match(r"^[bcdlps-][rwxStTs-]{9}[@+.]?$", perm):
        return None

    # Locate month token
    month_idx = -1
    for i, tok in enumerate(parts):
        if tok.lower() in _MONTHS:
            month_idx = i
            break
    if month_idx < 0:
        return None

    # Need at least: <mon> <day> <time|year> <name...>
    if month_idx + 3 >= len(parts):
        return None

    # Size usually sits right before month token, but may be missing / non-numeric on some servers.
    size = 0
    try:
        size = int(parts[month_idx - 1]) if month_idx - 1 >= 1 else 0
    except Exception:
        size = 0

    mon_s = parts[month_idx].lower()
    try:
        day = int(parts[month_idx + 1])
    except Exception:
        return None
    ty = parts[month_idx + 2]

    name_rest = " ".join(parts[month_idx + 3:]) if (month_idx + 3) < len(parts) else ""
    if not name_rest:
        return None

    ftype = "other"
    if perm.startswith("d"):
        ftype = "dir"
    elif perm.startswith("-"):
        ftype = "file"
    elif perm.startswith("l"):
        ftype = "link"

    name = name_rest
    link_target = None
    if ftype == "link" and " -> " in name_rest:
        name, link_target = name_rest.split(" -> ", 1)

    # Some FTP servers include the full path in the NAME field (e.g. "/D/" or "D/MULTIKI/").
    # Normalize to the last path segment for UI consistency.
    if "/" in name:
        norm = name.rstrip("/")
        if norm:
            seg = norm.split("/")[-1]
            if seg:
                name = seg

    mtime = None
    if mon_s in _MONTHS:
        mon = _MONTHS[mon_s]
        if now_ts is None:
            now_ts = _now()
        lt = time.localtime(now_ts)
        year = lt.tm_year
        if ":" in ty:
            try:
                hh, mm = ty.split(":", 1)
                hh_i = int(hh)
                mm_i = int(mm)
            except Exception:
                hh_i = 0
                mm_i = 0
            # Heuristic: if month/day is ahead of today, assume previous year.
            if (mon, day) > (lt.tm_mon, lt.tm_mday):
                year -= 1
            try:
                mtime = int(time.mktime((year, mon, day, hh_i, mm_i, 0, 0, 0, -1)))
            except Exception:
                mtime = None
        else:
            try:
                year = int(ty)
                mtime = int(time.mktime((year, mon, day, 0, 0, 0, 0, 0, -1)))
            except Exception:
                mtime = None

    item: Dict[str, Any] = {
        "name": name,
        "type": ftype,
        "size": size,
        "perm": perm,
        "mtime": mtime,
    }
    if link_target is not None:
        item["link_target"] = link_target
    return item




