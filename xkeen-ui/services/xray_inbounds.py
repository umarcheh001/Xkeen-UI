"""Inbounds presets and mode detection for XKeen Xray (03_inbounds.json).

Extracted from app.py as part of PR14 refactor.
"""

from __future__ import annotations

from typing import Any
import copy


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


# Tags managed by presets (system inbounds). Everything else is considered "user extras".
SYSTEM_TAGS = {"redirect", "tproxy"}


SOCKS_INBOUND_TEMPLATE = {
    "tag": "socks-in",
    "port": 1080,
    "protocol": "socks",
    "settings": {
        "auth": "noauth",
        "udp": True,
    },
    "sniffing": {
        "enabled": True,
        "routeOnly": True,
        "destOverride": [
            "http",
            "tls",
        ],
    },
}


def build_socks_inbound(port: int) -> dict:
    cfg = copy.deepcopy(SOCKS_INBOUND_TEMPLATE)
    cfg["port"] = int(port)
    return cfg


def _extract_inbounds(data: Any) -> list:
    if isinstance(data, dict):
        v = data.get("inbounds")
        return v if isinstance(v, list) else []
    if isinstance(data, list):
        return data
    return []


def _index_by_tag(inbounds: list) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for it in inbounds:
        if not isinstance(it, dict):
            continue
        tag = it.get("tag")
        if not isinstance(tag, str):
            continue
        tag = tag.strip()
        if not tag or tag in out:
            continue
        out[tag] = it
    return out


def _subset_match(actual: Any, preset: Any) -> bool:
    """Return True if ``actual`` matches ``preset`` for all keys present in preset.

    We intentionally allow "extra" fields in actual config so that users can extend
    presets without being forced into "custom" mode.
    """
    if isinstance(preset, dict):
        if not isinstance(actual, dict):
            return False
        for k, v in preset.items():
            if k not in actual:
                return False
            if not _subset_match(actual.get(k), v):
                return False
        return True

    if isinstance(preset, list):
        if not isinstance(actual, list):
            return False
        # For simple lists (strings/ints), treat order as irrelevant.
        if (
            all(isinstance(x, (str, int, float, bool, type(None))) for x in preset)
            and len(set(preset)) == len(preset)
            and all(isinstance(x, (str, int, float, bool, type(None))) for x in actual)
        ):
            try:
                return set(actual) == set(preset)
            except Exception:
                return actual == preset
        return actual == preset

    if isinstance(preset, str) and isinstance(actual, str):
        def _norm(s: str) -> str:
            # Remove spaces to tolerate values like "tcp, udp" vs "tcp,udp".
            return "".join(s.strip().split())

        return _norm(actual) == _norm(preset)

    return actual == preset


def merge_inbounds_preset(
    current: Any,
    preset: dict,
    *,
    preserve_extras: bool = True,
    add_socks: bool = False,
    socks_port: int | None = None,
) -> dict:
    """Merge selected preset with user "extras" inbounds.

    - Always replace system tags (redirect/tproxy) with preset versions.
    - Preserve other inbounds (extras) unless preserve_extras=False.
    - Optionally (re)create socks-in inbound with given port.
    """
    base: dict = {}
    cur_inbounds: list = []
    if isinstance(current, dict):
        base = {k: v for k, v in current.items() if k != "inbounds"}
        cur_inbounds = _extract_inbounds(current)
    else:
        base = {}
        cur_inbounds = _extract_inbounds(current)

    extras: list[dict] = []
    if preserve_extras:
        for it in cur_inbounds:
            if not isinstance(it, dict):
                continue
            tag = it.get("tag")
            tag_s = tag.strip() if isinstance(tag, str) else ""
            if tag_s in SYSTEM_TAGS:
                continue
            extras.append(it)

    # Optional socks-in injection
    if add_socks:
        p = 1080 if socks_port is None else int(socks_port)
        if p < 1 or p > 65535:
            raise ValueError("invalid socks_port")

        # Drop existing socks-in from extras to avoid duplicates.
        extras = [it for it in extras if not (isinstance(it, dict) and str(it.get("tag") or "") == "socks-in")]
        extras.append(build_socks_inbound(p))

    # Validate port conflicts (basic safety).
    # NOTE: preset system tags (redirect/tproxy) may legally share the same port
    # (as in the default presets). We only prevent clashes when an "extra" inbound
    # tries to reuse a port already used by another inbound.
    merged_inbounds = list(preset.get("inbounds") or []) + extras
    ports: dict[int, str] = {}
    for it in merged_inbounds:
        if not isinstance(it, dict):
            continue
        port = it.get("port")
        tag = it.get("tag")
        try:
            port_i = int(port)
        except Exception:
            continue
        if port_i <= 0:
            continue
        t = str(tag) if isinstance(tag, str) and tag else "(no-tag)"

        if port_i in ports:
            prev = ports[port_i]
            # Allow system tags to share port between themselves.
            if (t in SYSTEM_TAGS) and (prev in SYSTEM_TAGS):
                continue
            # Otherwise it's a conflict.
            raise ValueError(f"port conflict: {port_i} used by {prev} and {t}")

        ports[port_i] = t

    return {**base, "inbounds": merged_inbounds}


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

    inbounds = _extract_inbounds(data)
    by_tag = _index_by_tag(inbounds)

    has_r = "redirect" in by_tag
    has_t = "tproxy" in by_tag

    if has_r and has_t:
        try:
            r_ok = _subset_match(by_tag["redirect"], MIXED_INBOUNDS["inbounds"][0])
            t_ok = _subset_match(by_tag["tproxy"], MIXED_INBOUNDS["inbounds"][1])
            if r_ok and t_ok:
                return "mixed"
        except Exception:
            pass

    if has_t and not has_r:
        try:
            if _subset_match(by_tag["tproxy"], TPROXY_INBOUNDS["inbounds"][0]):
                return "tproxy"
        except Exception:
            pass

    if has_r and not has_t:
        try:
            if _subset_match(by_tag["redirect"], REDIRECT_INBOUNDS["inbounds"][0]):
                return "redirect"
        except Exception:
            pass

    return "custom"
