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

from services.url_policy import (
    DEFAULT_TRUSTED_DOWNLOAD_HOSTS,
    URLPolicy,
    env_flag,
    get_policy_from_env,
    is_url_allowed as is_url_allowed_for_policy,
    parse_allow_hosts as parse_allow_hosts_shared,
    url_host,
)

DEFAULT_ALLOW_HOSTS = list(DEFAULT_TRUSTED_DOWNLOAD_HOSTS)


def parse_allow_hosts(raw: Optional[str] = None) -> List[str]:
    return parse_allow_hosts_shared(
        raw,
        env_key="XKEEN_UI_UPDATE_ALLOW_HOSTS",
        default_hosts=DEFAULT_ALLOW_HOSTS,
    )


def is_http_allowed() -> bool:
    return env_flag("XKEEN_UI_UPDATE_ALLOW_HTTP", False)


def is_url_allowed(url: str, allow_hosts: Optional[List[str]] = None) -> Tuple[bool, str]:
    """Return (ok, reason)."""
    policy = URLPolicy(
        allow_hosts=tuple(allow_hosts or parse_allow_hosts()),
        allow_http=is_http_allowed(),
        allow_private_hosts=False,
        allow_custom_urls=False,
    )
    return is_url_allowed_for_policy(url, policy)


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
        "require_sha": str(os.environ.get("XKEEN_UI_UPDATE_REQUIRE_SHA") or "1"),
    }
