"""HTTP-related helpers for file transfers (Content-Disposition, filename sanitizing).

Moved from routes_remotefs.py to break routes->routes imports.
"""

from __future__ import annotations

import os
from urllib.parse import quote as _url_quote

def _sanitize_download_filename(name: str, *, default: str = "download") -> str:
    """Sanitize filename for Content-Disposition header (prevent header injection)."""
    s = (name or "").strip()
    try:
        s = os.path.basename(s)
    except Exception:
        pass
    # Strip header-breaking characters.
    s = s.replace("\r", "").replace("\n", "").replace('"', "")
    if not s:
        s = default
    # Keep header reasonably small.
    if len(s) > 180:
        s = s[:180]
    return s


def _content_disposition_attachment(filename: str) -> str:
    """Build a safe Content-Disposition attachment header value."""
    fn = _sanitize_download_filename(filename)
    # RFC 5987 filename* improves UTF-8 handling in modern browsers.
    try:
        fn_star = _url_quote(fn, safe='')
        return f'attachment; filename="{fn}"; filename*=UTF-8\'\'{fn_star}'
    except Exception:
        return f'attachment; filename="{fn}"'



