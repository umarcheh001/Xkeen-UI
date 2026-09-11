"""Safe DTO helpers for the Mihomo DNS diagnostics adapter."""

from __future__ import annotations

import ipaddress
import random
import socket
import struct
import time
from urllib.parse import urlsplit
from collections.abc import Mapping, Sequence
from typing import Any


DNS_TYPES = frozenset({"A", "AAAA", "CNAME", "TXT"})
DNS_RCODE_NAMES = {
    0: "NOERROR",
    1: "FORMERR",
    2: "SERVFAIL",
    3: "NXDOMAIN",
    4: "NOTIMP",
    5: "REFUSED",
}
DNS_REASON_NAMES = {
    "FORMERR": "format_error",
    "SERVFAIL": "server_failure",
    "NXDOMAIN": "nxdomain",
    "NOTIMP": "not_implemented",
    "REFUSED": "refused",
}
DNS_TYPE_NAMES = {
    1: "A",
    5: "CNAME",
    28: "AAAA",
    16: "TXT",
}
MAX_DNS_ANSWERS = 128
MAX_DNS_VALUE_CHARS = 1024
DNS_LISTENER_TYPES = {"A": 1, "AAAA": 28}


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any, limit: int = MAX_DNS_VALUE_CHARS) -> str:
    if value is None or isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return ""
    return str(value).replace("\x00", "").strip()[: max(0, int(limit))]


def _nonnegative_int(value: Any, default: int = 0, maximum: int = 86_400) -> int:
    if isinstance(value, bool):
        return default
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return max(0, min(maximum, number))


def _record_type(value: Any, fallback: str) -> str:
    if isinstance(value, str):
        candidate = value.strip().upper()
        if candidate in DNS_TYPES:
            return candidate
    if isinstance(value, int) and value in DNS_TYPE_NAMES:
        return DNS_TYPE_NAMES[value]
    return fallback


def normalize_dns_mode(config_payload: Any = None, query_payload: Any = None) -> str:
    """Return a compact mode label without forwarding resolver configuration."""

    query = _mapping(query_payload)
    for key in ("dns_mode", "dnsMode", "mode"):
        value = _text(query.get(key), 32).lower()
        if value in {"fake-ip", "fake_ip", "redir-host", "redir_host", "normal", "disabled"}:
            return value.replace("_", "-")

    config = _mapping(config_payload)
    dns = _mapping(config.get("dns"))
    value = _text(
        dns.get("enhanced-mode")
        if dns.get("enhanced-mode") is not None
        else dns.get("enhanced_mode"),
        32,
    ).lower()
    if value in {"fake-ip", "fake_ip", "redir-host", "redir_host", "normal"}:
        return value.replace("_", "-")
    if dns.get("enable") is False:
        return "disabled"
    if dns:
        return "normal"
    return "unknown"


def normalize_dns_reason(payload: Any) -> str | None:
    """Map Mihomo/compatible DNS errors to a stable reason vocabulary."""

    raw = _mapping(payload)
    status = raw.get("Status")
    if status is None:
        status = raw.get("status")
    if isinstance(status, str):
        status_name = status.strip().upper()
        if status_name in DNS_REASON_NAMES:
            return DNS_REASON_NAMES[status_name]
    if not isinstance(status, bool):
        try:
            status_number = int(status)
        except (TypeError, ValueError, OverflowError):
            status_number = 0
        if status_number:
            rcode = DNS_RCODE_NAMES.get(status_number, "UPSTREAM_ERROR")
            return DNS_REASON_NAMES.get(rcode, "upstream_error")

    error = _text(raw.get("error") or raw.get("Error") or raw.get("message"), 128).lower()
    if not error:
        return None
    if "name" in error and ("not found" in error or "nxdomain" in error):
        return "nxdomain"
    if "timeout" in error or "deadline" in error:
        return "timeout"
    if "refused" in error:
        return "refused"
    if "servfail" in error or "server failure" in error:
        return "server_failure"
    return "upstream_error"


def _configured_fake_ip_range(config_payload: Any) -> str | None:
    """Return the configured Fake-IP CIDR without exposing resolver settings."""

    dns = _mapping(_mapping(config_payload).get("dns"))
    for raw in (dns.get("fake-ip-range"), dns.get("fake-ip-range6")):
        value = _text(raw, 64)
        if not value:
            continue
        try:
            ipaddress.ip_network(value, strict=False)
        except ValueError:
            continue
        return value
    return None


def _fake_ip_answer_observation(
    config_payload: Any,
    answers: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Describe the shape of the controller API answer, not the client route.

    Mihomo's ``/dns/query`` endpoint can return upstream records even when the
    listener on port 53 hands Fake-IP addresses to LAN clients.  Therefore an
    address-shaped observation must never be presented as proof that the
    listener/TUN/TProxy path works.  The UI gets the explicit ``source`` marker
    and displays the route as unverified.
    """

    mode = normalize_dns_mode(config_payload)
    configured_range = _configured_fake_ip_range(config_payload)
    dns = _mapping(_mapping(config_payload).get("dns"))
    raw_ranges = [dns.get("fake-ip-range"), dns.get("fake-ip-range6")]
    ranges: list[str] = []
    networks: list[Any] = []
    for raw in raw_ranges:
        value = _text(raw, 64)
        if not value:
            continue
        try:
            network = ipaddress.ip_network(value, strict=False)
        except ValueError:
            continue
        ranges.append(value)
        networks.append(network)

    addresses: list[str] = []
    for answer in list(answers)[:MAX_DNS_ANSWERS]:
        value = _text(answer.get("data"), 128)
        try:
            parsed = ipaddress.ip_address(value)
        except ValueError:
            continue
        addresses.append(value)
        if mode == "fake-ip" and any(parsed in network for network in networks):
            return {
                "state": "fake-ip-range",
                "range": ranges[0] if ranges else configured_range,
                "source": "controller-api",
            }

    if not addresses:
        return {
            "state": "no-address",
            "range": ranges[0] if ranges else configured_range,
            "source": "controller-api",
        }
    if mode == "fake-ip":
        if not networks:
            return {
                "state": "range-unavailable",
                "range": None,
                "source": "controller-api",
            }
        return {
            "state": "upstream-address",
            "range": ranges[0] if ranges else configured_range,
            "source": "controller-api",
        }
    return {"state": "resolved", "range": None, "source": "controller-api"}


def _route_not_checked(config_payload: Any) -> dict[str, Any]:
    """Return an explicit no-proof marker for the port-53 Fake-IP path."""

    return {
        "state": "not-checked",
        "source": "controller-api",
        "range": _configured_fake_ip_range(config_payload),
        "reason": "controller_api_does_not_test_port53_listener",
    }


def _dns_wire_name(name: str) -> bytes:
    """Encode one already validated DNS name for a bounded UDP probe."""

    labels = []
    for label in str(name or "").strip().rstrip(".").split("."):
        encoded = label.encode("idna")
        if not encoded or len(encoded) > 63:
            raise ValueError("dns label too long")
        labels.append(bytes([len(encoded)]) + encoded)
    wire = b"".join(labels) + b"\0"
    if len(wire) > 255:
        raise ValueError("dns name too long")
    return wire


def _skip_dns_wire_name(packet: bytes, offset: int) -> int | None:
    """Skip a DNS name, including compressed pointers, without following them."""

    limit = len(packet)
    while offset < limit:
        length = packet[offset]
        if length == 0:
            return offset + 1
        if length & 0xC0 == 0xC0:
            return offset + 2 if offset + 1 < limit else None
        if length > 63 or offset + 1 + length > limit:
            return None
        offset += 1 + length
    return None


def _dns_listener_addresses(packet: bytes, *, txid: int, qtype: str) -> tuple[int, list[str]]:
    """Extract A/AAAA records from one bounded DNS response."""

    if len(packet) < 12:
        raise ValueError("short dns response")
    response_id, flags, questions, answer_count, _authority, _additional = struct.unpack(
        "!HHHHHH", packet[:12]
    )
    if response_id != txid or not (flags & 0x8000):
        raise ValueError("dns response id mismatch")
    offset = 12
    for _ in range(min(questions, 16)):
        offset = _skip_dns_wire_name(packet, offset) or -1
        if offset < 0 or offset + 4 > len(packet):
            raise ValueError("invalid dns question")
        offset += 4
    addresses: list[str] = []
    wanted = DNS_LISTENER_TYPES.get(qtype)
    for _ in range(min(answer_count, MAX_DNS_ANSWERS)):
        offset = _skip_dns_wire_name(packet, offset) or -1
        if offset < 0 or offset + 10 > len(packet):
            raise ValueError("invalid dns answer")
        record_type, record_class, _ttl, data_len = struct.unpack("!HHIH", packet[offset : offset + 10])
        offset += 10
        if offset + data_len > len(packet):
            raise ValueError("invalid dns rdata")
        data = packet[offset : offset + data_len]
        offset += data_len
        if record_class != 1 or record_type != wanted:
            continue
        expected_len = 4 if qtype == "A" else 16
        if len(data) == expected_len:
            addresses.append(str(ipaddress.ip_address(data)))
    return flags & 0x000F, addresses


def _classify_listener_route(config_payload: Any, addresses: Sequence[str]) -> dict[str, Any]:
    """Classify addresses returned by the actual local port-53 listener."""

    mode = normalize_dns_mode(config_payload)
    configured_range = _configured_fake_ip_range(config_payload)
    networks: list[Any] = []
    dns = _mapping(_mapping(config_payload).get("dns"))
    for raw in (dns.get("fake-ip-range"), dns.get("fake-ip-range6")):
        value = _text(raw, 64)
        if not value:
            continue
        try:
            networks.append(ipaddress.ip_network(value, strict=False))
        except ValueError:
            continue
    if mode == "fake-ip" and not addresses:
        state = "no-address"
    elif mode == "fake-ip" and not networks:
        state = "range-unavailable"
    elif mode == "fake-ip" and any(
        any(ipaddress.ip_address(value) in network for network in networks)
        for value in addresses
    ):
        state = "fake-ip"
    elif mode == "fake-ip":
        state = "real-ip"
    elif addresses:
        state = "resolved"
    else:
        state = "no-address"
    return {
        "state": state,
        "source": "local-listener",
        "range": configured_range,
        "addresses": list(addresses)[:16],
    }


def _listener_probe_hosts(config_payload: Any) -> list[tuple[int, str]]:
    """Return safe local addresses declared by ``dns.listen`` plus loopbacks."""

    hosts: list[tuple[int, str]] = []
    dns = _mapping(_mapping(config_payload).get("dns"))
    raw = _text(dns.get("listen"), 128)
    if raw:
        candidate = raw.split(",", 1)[0].strip()
        if "://" in candidate:
            parsed_url = urlsplit(candidate)
            candidate = parsed_url.netloc or parsed_url.path
        port = 53
        if candidate.startswith("[") and "]" in candidate:
            closing = candidate.index("]")
            host_text, port_text = candidate[1:closing], candidate[closing + 1 :]
            candidate = host_text
            if port_text.startswith(":"):
                try:
                    port = int(port_text[1:])
                except ValueError:
                    port = 0
        elif candidate.count(":") == 1:
            candidate, port_text = candidate.rsplit(":", 1)
            try:
                port = int(port_text)
            except ValueError:
                port = 0
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            address = None
        if port == 53 and address is not None and not address.is_unspecified and (
            address.is_loopback or address.is_private or address.is_link_local
        ):
            hosts.append((socket.AF_INET6 if address.version == 6 else socket.AF_INET, str(address)))
    hosts.extend(((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")))
    return list(dict.fromkeys(hosts))


def probe_dns_listener(
    name: str,
    *,
    qtype: str = "A",
    config_payload: Any = None,
    timeout: float = 1.2,
) -> dict[str, Any]:
    """Probe the router's local UDP/53 listener and classify its Fake-IP path.

    This is intentionally separate from ``/dns/query``: the controller API
    returns upstream records on Fake-IP installations, while a query sent to
    the listener is the observable address that a LAN client receives.
    """

    normalized_type = str(qtype or "A").strip().upper()
    if normalized_type not in DNS_LISTENER_TYPES:
        raise ValueError("only A and AAAA listener probes are supported")
    wire_name = _dns_wire_name(name)
    started = time.monotonic()
    deadline = started + max(0.2, min(5.0, float(timeout or 0)))
    txid = random.randint(0, 65535)
    packet = struct.pack("!HHHHHH", txid, 0x0100, 1, 0, 0, 0) + wire_name + struct.pack(
        "!HH", DNS_LISTENER_TYPES[normalized_type], 1
    )
    last_error = "timeout"
    for family, host in _listener_probe_hosts(config_payload):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as probe:
                probe.settimeout(min(1.0, max(0.2, remaining)))
                probe.sendto(packet, (host, 53))
                raw, _peer = probe.recvfrom(4096)
            rcode, addresses = _dns_listener_addresses(raw, txid=txid, qtype=normalized_type)
            observation = _classify_listener_route(config_payload, addresses)
            observation.update(
                {
                    "schema_version": 1,
                    "ok": rcode == 0 and bool(addresses),
                    "host": host,
                    "port": 53,
                    "qtype": normalized_type,
                    "rcode": rcode,
                    "latency_ms": round((time.monotonic() - started) * 1000.0, 1),
                }
            )
            if observation["ok"]:
                return observation
            last_error = f"dns rcode={rcode} with no {normalized_type} answers"
        except Exception as exc:  # noqa: BLE001 - probe is best effort
            last_error = str(exc)[:128] or "listener error"
    result = _classify_listener_route(config_payload, [])
    result.update(
        {
            "schema_version": 1,
            "ok": False,
            "host": None,
            "port": 53,
            "qtype": normalized_type,
            "rcode": None,
            "latency_ms": round((time.monotonic() - started) * 1000.0, 1),
            "error": last_error,
        }
    )
    result["state"] = "unreachable"
    return result


def normalize_dns_query(
    payload: Any,
    *,
    name: str,
    qtype: str,
    latency_ms: float,
    config_payload: Any = None,
    cached: bool = False,
) -> dict[str, Any]:
    """Normalize one bounded `/dns/query` response for the browser."""

    raw = _mapping(payload)
    answers_raw = raw.get("Answer")
    if answers_raw is None:
        answers_raw = raw.get("answer")
    if not isinstance(answers_raw, Sequence) or isinstance(
        answers_raw, (str, bytes, bytearray)
    ):
        answers_raw = []

    answers: list[dict[str, Any]] = []
    ttls: list[int] = []
    for candidate in list(answers_raw)[:MAX_DNS_ANSWERS]:
        item = _mapping(candidate)
        data = item.get("data")
        if isinstance(data, Sequence) and not isinstance(data, (str, bytes, bytearray)):
            data = " ".join(_text(value, 256) for value in list(data)[:8])
        value = _text(data)
        if not value:
            continue
        ttl = _nonnegative_int(item.get("TTL") if item.get("TTL") is not None else item.get("ttl"))
        ttls.append(ttl)
        answers.append(
            {
                "name": _text(item.get("name") or name, 253),
                "type": _record_type(item.get("type"), qtype),
                "ttl": ttl,
                "data": value,
            }
        )

    status_value = raw.get("Status")
    if status_value is None:
        status_value = raw.get("status", 0)
    try:
        rcode = max(0, int(status_value))
    except (TypeError, ValueError, OverflowError):
        rcode = 0
    reason = normalize_dns_reason(raw)
    return {
        "schema_version": 1,
        "ok": reason is None,
        "state": "live",
        "query": {
            "name": _text(name, 253),
            "type": str(qtype or "A").upper(),
        },
        "dns_mode": normalize_dns_mode(config_payload, raw),
        "rcode": rcode,
        "rcode_name": DNS_RCODE_NAMES.get(rcode, "UPSTREAM_ERROR"),
        "answers": answers,
        "answer_count": len(answers),
        "ttl": min(ttls) if ttls else 0,
        "latency_ms": max(0.0, round(float(latency_ms or 0.0), 1)),
        "error_reason": reason,
        "answer_observation": _fake_ip_answer_observation(config_payload, answers),
        "route_check": _route_not_checked(config_payload),
        "cached": bool(cached),
        "truncated": len(answers_raw) > MAX_DNS_ANSWERS,
    }


def dns_error_payload(
    *,
    name: str,
    qtype: str,
    reason: str,
    latency_ms: float | None = None,
    config_payload: Any = None,
) -> dict[str, Any]:
    """Create a safe error-shaped diagnostic response."""

    return {
        "schema_version": 1,
        "ok": False,
        "state": "error",
        "query": {"name": _text(name, 253), "type": str(qtype or "A").upper()},
        "dns_mode": normalize_dns_mode(config_payload),
        "answers": [],
        "answer_count": 0,
        "ttl": 0,
        "latency_ms": (
            max(0.0, round(float(latency_ms), 1))
            if latency_ms is not None
            else None
        ),
        "error_reason": str(reason or "upstream_error")[:64],
        "answer_observation": _fake_ip_answer_observation(config_payload, []),
        "route_check": _route_not_checked(config_payload),
        "cached": False,
        "truncated": False,
    }


__all__ = [
    "DNS_TYPES",
    "MAX_DNS_ANSWERS",
    "probe_dns_listener",
    "dns_error_payload",
    "normalize_dns_mode",
    "normalize_dns_query",
    "normalize_dns_reason",
]
