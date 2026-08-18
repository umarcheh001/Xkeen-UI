"""Shared helpers for authenticated Keenetic RCI requests.

KeeneticOS 5.2 requires an access token for the local RCI endpoint.  XKeen
stores that token in ``/opt/etc/xkeen/xkeen.json`` under
``xkeen.rci_token``.  Keep the token lookup in one place so UI-owned RCI
clients do not silently lose functionality after a firmware upgrade.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional

from core.paths import BASE_ETC_DIR
from utils.jsonc import strip_json_comments_text


RCI_TOKEN_HEADER = "X-Ndma-Tkn"
DEFAULT_XKEEN_CONFIG_FILE = os.path.join(BASE_ETC_DIR, "xkeen", "xkeen.json")
RCI_VERSION_URL = "http://127.0.0.1:79/rci/show/version"


@dataclass(frozen=True)
class RciAccessStatus:
    state: str
    token_configured: bool
    http_status: Optional[int] = None

    @property
    def ok(self) -> bool:
        return self.state == "available"


def xkeen_config_file() -> str:
    raw = str(os.environ.get("XKEEN_CONFIG_FILE") or "").strip()
    if not raw:
        return DEFAULT_XKEEN_CONFIG_FILE
    return raw if os.path.isabs(raw) else os.path.join(BASE_ETC_DIR, raw)


def load_rci_token(config_file: Optional[str] = None) -> str:
    """Read ``xkeen.rci_token`` from JSON/JSONC without ever logging it."""
    path = str(config_file or xkeen_config_file()).strip()
    if not path:
        return ""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            payload = json.loads(strip_json_comments_text(handle.read()))
        xkeen = payload.get("xkeen") if isinstance(payload, dict) else None
        token = xkeen.get("rci_token") if isinstance(xkeen, dict) else ""
        return str(token or "").strip()
    except Exception:
        return ""


def rci_headers(
    *,
    token: Optional[str] = None,
    accept: Optional[str] = "application/json",
    user_agent: Optional[str] = None,
) -> Dict[str, str]:
    """Build headers accepted by both pre-5.2 and KeeneticOS 5.2+ RCI."""
    headers: Dict[str, str] = {}
    if accept:
        headers["Accept"] = str(accept)
    if user_agent:
        headers["User-Agent"] = str(user_agent)
    effective_token = load_rci_token() if token is None else str(token or "").strip()
    if effective_token:
        headers[RCI_TOKEN_HEADER] = effective_token
    return headers


def build_rci_request(
    url: str,
    *,
    token: Optional[str] = None,
    data: Optional[bytes] = None,
    method: str = "GET",
    user_agent: str = "XKeen-UI",
) -> urllib.request.Request:
    return urllib.request.Request(
        url,
        data=data,
        headers=rci_headers(token=token, user_agent=user_agent),
        method=method,
    )


def probe_rci_access(
    *,
    url: str = RCI_VERSION_URL,
    timeout: float = 2.0,
    token: Optional[str] = None,
) -> RciAccessStatus:
    """Check local RCI access without exposing the credential.

    The probe is deliberately best-effort: startup and developer machines must
    continue to work when no Keenetic RCI endpoint exists.
    """
    effective_token = load_rci_token() if token is None else str(token or "").strip()
    request = build_rci_request(url, token=effective_token)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - local router RCI
            status = int(getattr(response, "status", 200) or 200)
        return RciAccessStatus(
            "available" if 200 <= status < 300 else "http_error",
            bool(effective_token),
            status,
        )
    except urllib.error.HTTPError as exc:
        status = int(getattr(exc, "code", 0) or 0) or None
        if status in (401, 403):
            state = "invalid_token" if effective_token else "token_required"
        else:
            state = "http_error"
        return RciAccessStatus(state, bool(effective_token), status)
    except Exception:
        return RciAccessStatus("unavailable", bool(effective_token), None)


def redact_rci_token(value: Any) -> Any:
    """Return a copy suitable for export/support bundles."""
    if not isinstance(value, dict):
        return value
    copied = dict(value)
    xkeen = copied.get("xkeen")
    if isinstance(xkeen, dict):
        xkeen_copy = dict(xkeen)
        if "rci_token" in xkeen_copy:
            xkeen_copy["rci_token"] = ""
        copied["xkeen"] = xkeen_copy
    return copied
