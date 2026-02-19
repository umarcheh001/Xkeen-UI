"""Inbounds presets and mode detection for XKeen Xray (03_inbounds.json).

Extracted from app.py as part of PR14 refactor.
"""

from __future__ import annotations

from typing import Any


# ---------- INBOUNDS presets (03_inbounds.json) ----------

MIXED_INBOUNDS = {
    "inbounds": [
        {
            "tag": "redirect",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "tcp", "followRedirect": True},
            "sniffing": {
                "enabled": True,
                "routeOnly": True,
                "destOverride": ["http", "tls"],
            },
        },
        {
            "tag": "tproxy",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "udp", "followRedirect": True},
            "streamSettings": {"sockopt": {"tproxy": "tproxy"}},
            "sniffing": {
                "enabled": True,
                "routeOnly": True,
                "destOverride": ["http", "tls"],
            },
        },
    ]
}

TPROXY_INBOUNDS = {
    "inbounds": [
        {
            "tag": "tproxy",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "tcp,udp", "followRedirect": True},
            "streamSettings": {"sockopt": {"tproxy": "tproxy"}},
            "sniffing": {
                "routeOnly": True,
                "enabled": True,
                "destOverride": ["http", "tls", "quic"],
            },
        }
    ]
}

REDIRECT_INBOUNDS = {
    "inbounds": [
        {
            "tag": "redirect",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "tcp", "followRedirect": True},
            "sniffing": {
                "enabled": True,
                "routeOnly": True,
                "destOverride": ["http", "tls"],
            },
        }
    ]
}


def detect_inbounds_mode(file_path: str | None = None, data: Any = None) -> str | None:
    """Best-effort detect UI mode for inbounds.

    Kept signature compatible with the historical function in app.py.
    In PR14 we only call it with ``data=...``.
    """
    _ = file_path  # kept for backwards compatibility
    if data is None:
        return None
    if not data:
        return None
    if data == MIXED_INBOUNDS:
        return "mixed"
    if data == TPROXY_INBOUNDS:
        return "tproxy"
    if data == REDIRECT_INBOUNDS:
        return "redirect"
    return "custom"
