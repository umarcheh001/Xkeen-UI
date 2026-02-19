"""Self-update security helpers.

PR/Commit 9 (self-update hardening):
- allow-list of download hosts
- https-only by default
- safe defaults for limits/timeouts

These helpers are used by the DevTools "check latest" endpoint to surface
warnings before the runner starts.

The runner enforces these policies independently.
"""

from __future__ import annotations

import os
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse


DEFAULT_ALLOW_HOSTS = [
    "github.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
]


def parse_allow_hosts(raw: Optional[str] = None) -> List[str]:
    raw = (raw if raw is not None else os.environ.get("XKEEN_UI_UPDATE_ALLOW_HOSTS")) or ""
    parts = [p.strip().lower() for p in raw.split(",") if p.strip()]
    if not parts:
        parts = list(DEFAULT_ALLOW_HOSTS)
    # de-dup
    out: List[str] = []
    for p in parts:
        if p not in out:
            out.append(p)
    return out


def is_http_allowed() -> bool:
    return str(os.environ.get("XKEEN_UI_UPDATE_ALLOW_HTTP") or "0").strip() == "1"


def url_host(url: str) -> Optional[str]:
    try:
        return (urlparse(url).hostname or "").lower() or None
    except Exception:
        return None


def is_url_allowed(url: str, allow_hosts: Optional[List[str]] = None) -> Tuple[bool, str]:
    """Return (ok, reason)."""
    url = str(url or "").strip()
    if not url:
        return False, "empty"

    try:
        p = urlparse(url)
    except Exception:
        return False, "parse_failed"

    scheme = (p.scheme or "").lower()
    if scheme not in ("https", "http"):
        return False, f"bad_scheme:{scheme or 'none'}"
    if scheme == "http" and not is_http_allowed():
        return False, "http_not_allowed"

    host = (p.hostname or "").lower()
    if not host:
        return False, "no_host"

    ah = allow_hosts or parse_allow_hosts()
    for h in ah:
        if host == h or host.endswith("." + h):
            return True, "ok"
    return False, f"host_not_allowed:{host}"


def security_snapshot() -> Dict[str, str]:
    """Expose effective security settings for UI diagnostics."""
    return {
        "allow_hosts": ",".join(parse_allow_hosts()),
        "allow_http": "1" if is_http_allowed() else "0",
        "max_bytes": str(os.environ.get("XKEEN_UI_UPDATE_MAX_BYTES") or "62914560"),
        "max_checksum_bytes": str(os.environ.get("XKEEN_UI_UPDATE_MAX_CHECKSUM_BYTES") or "1048576"),
        "connect_timeout": str(os.environ.get("XKEEN_UI_UPDATE_CONNECT_TIMEOUT") or "10"),
        "download_timeout": str(os.environ.get("XKEEN_UI_UPDATE_DOWNLOAD_TIMEOUT") or "300"),
        "api_timeout": str(os.environ.get("XKEEN_UI_UPDATE_API_TIMEOUT") or "10"),
        "sha_strict": str(os.environ.get("XKEEN_UI_UPDATE_SHA_STRICT") or "1"),
        "require_sha": str(os.environ.get("XKEEN_UI_UPDATE_REQUIRE_SHA") or "0"),
    }
