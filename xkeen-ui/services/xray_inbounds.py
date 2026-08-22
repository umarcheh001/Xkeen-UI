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


class PortConflictError(ValueError):
    """Raised when two inbounds need the same socket protocol and port."""

    def __init__(
        self,
        port: int,
        first_tag: str,
        second_tag: str,
        first_networks: set[str],
        second_networks: set[str],
    ) -> None:
        self.port = int(port)
        self.first_tag = str(first_tag)
        self.second_tag = str(second_tag)
        self.first_networks = frozenset(first_networks)
        self.second_networks = frozenset(second_networks)
        self.overlap = frozenset(self.first_networks & self.second_networks)
        overlap = ",".join(sorted(self.overlap)) or "unknown"
        super().__init__(
            f"port conflict: {self.port}/{overlap} used by "
            f"{self.first_tag} and {self.second_tag}"
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "port": self.port,
            "first": {
                "tag": self.first_tag,
                "networks": sorted(self.first_networks),
            },
            "second": {
                "tag": self.second_tag,
                "networks": sorted(self.second_networks),
            },
            "overlap": sorted(self.overlap),
        }


def build_socks_inbound(port: int) -> dict:
    cfg = copy.deepcopy(SOCKS_INBOUND_TEMPLATE)
    cfg["port"] = int(port)
    return cfg


def _inbound_socket_networks(inbound: dict) -> set[str]:
    """Return the socket protocols an inbound is expected to bind.

    Xray can bind TCP and UDP to the same numeric port. A duplicate number is
    therefore a conflict only when the socket protocols overlap. Transparent
    proxy inbounds declare this through ``settings.network`` (legacy
    dokodemo-door) or ``settings.allowedNetwork`` (tunnel). SOCKS can add a UDP
    listener with ``settings.udp``. Other inbound transports default to TCP,
    except the UDP-based KCP/QUIC transports.
    """
    settings = inbound.get("settings")
    settings = settings if isinstance(settings, dict) else {}

    explicit = settings.get("allowedNetwork")
    if explicit is None:
        explicit = settings.get("network")
    if isinstance(explicit, str):
        networks = {
            item.strip().lower()
            for item in explicit.split(",")
            if item.strip().lower() in {"tcp", "udp"}
        }
        if networks:
            return networks

    protocol = str(inbound.get("protocol") or "").strip().lower()
    if protocol == "socks":
        networks = {"tcp"}
        if settings.get("udp") is True:
            networks.add("udp")
        return networks

    stream = inbound.get("streamSettings")
    stream = stream if isinstance(stream, dict) else {}
    transport = str(stream.get("network") or "").strip().lower()
    if transport in {"kcp", "mkcp", "quic"}:
        return {"udp"}

    # Xray's regular inbound listener and tunnel/dokodemo default are TCP.
    return {"tcp"}


def _inbound_bind_address(inbound: dict) -> str | None:
    """Return a normalized IP bind address, or ``None`` for a Unix socket."""
    listen = str(inbound.get("listen") or "").strip()
    if listen.startswith("@") or listen.startswith("/"):
        return None
    return listen.lower() or "0.0.0.0"


def _bind_addresses_overlap(first: str, second: str) -> bool:
    # Xray documents 0.0.0.0 and :: as all-interface listeners. Keep the
    # preflight conservative for those values; distinct explicit addresses can
    # legally reuse a port.
    wildcards = {"0.0.0.0", "::"}
    if first in wildcards or second in wildcards:
        return True
    return first == second


def _inbound_ports(value: Any) -> set[int]:
    """Best-effort parser for Xray's single/list/range port syntax."""
    if isinstance(value, bool):
        return set()
    if isinstance(value, int):
        return {value} if 1 <= value <= 65535 else set()
    if not isinstance(value, str):
        return set()

    ports: set[int] = set()
    for part in value.split(","):
        token = part.strip()
        if not token:
            continue
        for separator in ("-", ":"):
            if separator not in token:
                continue
            left, right = token.split(separator, 1)
            try:
                start, end = int(left.strip()), int(right.strip())
            except (TypeError, ValueError):
                break
            lo, hi = sorted((start, end))
            if 1 <= lo <= hi <= 65535:
                ports.update(range(lo, hi + 1))
            break
        else:
            try:
                port = int(token)
            except (TypeError, ValueError):
                continue
            if 1 <= port <= 65535:
                ports.add(port)
    return ports


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

    # TCP and UDP have separate socket namespaces, so the same numeric port is
    # valid when inbounds listen on disjoint protocols. This is how both the
    # built-in Hybrid preset and user-defined redirect/TProxy pairs work.
    merged_inbounds = list(preset.get("inbounds") or []) + extras
    listeners: dict[int, list[tuple[str, set[str], str]]] = {}
    for it in merged_inbounds:
        if not isinstance(it, dict):
            continue
        bind_address = _inbound_bind_address(it)
        if bind_address is None:
            continue
        tag = it.get("tag")
        t = str(tag) if isinstance(tag, str) and tag else "(no-tag)"
        networks = _inbound_socket_networks(it)
        for port_i in _inbound_ports(it.get("port")):
            for prev_tag, prev_networks, prev_address in listeners.get(port_i, []):
                if networks & prev_networks and _bind_addresses_overlap(bind_address, prev_address):
                    raise PortConflictError(
                        port_i,
                        prev_tag,
                        t,
                        prev_networks,
                        networks,
                    )
            listeners.setdefault(port_i, []).append((t, networks, bind_address))

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
