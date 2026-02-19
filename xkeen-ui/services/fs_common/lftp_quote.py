"""lftp quoting helper (no shell).

Moved from routes_remotefs.py to break routes->routes imports.
"""

from __future__ import annotations

import re

def _lftp_quote(s: str) -> str:
    """Quote a value for lftp command language.

    We avoid shell=True and pass the whole script as a single argument to -c,
    but lftp still parses its own quoting.
    """
    s = "" if s is None else str(s)
    # Strip ASCII control characters that could break lftp scripts (e.g. CR/LF).
    s = re.sub(r'[\x00-\x1f\x7f]', '', s)
    # Use double quotes + backslash escaping for common specials.
    s = s.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{s}"'



