"""Safe DTO helpers for the Mihomo DNS diagnostics adapter."""

from __future__ import annotations

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
        "cached": False,
        "truncated": False,
    }


__all__ = [
    "DNS_TYPES",
    "MAX_DNS_ANSWERS",
    "dns_error_payload",
    "normalize_dns_mode",
    "normalize_dns_query",
    "normalize_dns_reason",
]
