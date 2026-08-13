"""Small, cached public egress lookup routed through Mihomo's HTTP proxy."""

from __future__ import annotations

import ipaddress
import json
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any


IP_LOOKUP_URL = "https://ipapi.co/json/"
DEFAULT_CACHE_TTL_SECONDS = 300.0
MIN_FORCE_REFRESH_SECONDS = 10.0
MAX_RESPONSE_BYTES = 64 * 1024
DEFAULT_TIMEOUT_SECONDS = 7.0

_LOCK = threading.Lock()
_CACHE: dict[int, dict[str, Any]] = {}


class MihomoEgressInfoError(RuntimeError):
    def __init__(self, message: str, *, code: str, status: int = 502):
        super().__init__(message)
        self.code = str(code)
        self.status = int(status)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _text(value: Any, limit: int = 256) -> str:
    if value is None or isinstance(value, (dict, list, tuple, set, bool)):
        return ""
    return str(value).replace("\x00", "").strip()[: max(0, int(limit))]


def _normalize_payload(raw: Any) -> dict[str, Any]:
    payload = raw if isinstance(raw, Mapping) else {}
    if payload.get("error") is True:
        raise MihomoEgressInfoError(
            "Сервис определения IP отклонил запрос.",
            code="egress_lookup_rejected",
        )

    ip_text = _text(payload.get("ip"), 64)
    try:
        address = ipaddress.ip_address(ip_text)
    except ValueError as exc:
        raise MihomoEgressInfoError(
            "Сервис определения IP вернул некорректный адрес.",
            code="egress_lookup_invalid_response",
        ) from exc

    country_code = _text(payload.get("country_code") or payload.get("country"), 2).upper()
    asn = _text(payload.get("asn"), 32).upper()
    if asn and not asn.startswith("AS") and asn.isdigit():
        asn = f"AS{asn}"

    return {
        "ip": str(address),
        "ip_version": f"IPv{address.version}",
        "city": _text(payload.get("city"), 128),
        "region": _text(payload.get("region"), 128),
        "country": _text(payload.get("country_name"), 128),
        "country_code": country_code if len(country_code) == 2 else "",
        "asn": asn,
        "organization": _text(payload.get("org"), 256),
        "timezone": _text(payload.get("timezone"), 128),
    }


def _fetch_via_mihomo(proxy_port: int, timeout: float) -> Mapping[str, Any]:
    proxy_url = f"http://127.0.0.1:{int(proxy_port)}"
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}),
        _NoRedirect(),
    )
    request = urllib.request.Request(
        IP_LOOKUP_URL,
        headers={
            "Accept": "application/json",
            "Connection": "close",
            "User-Agent": "Xkeen-UI egress-check/1",
        },
        method="GET",
    )
    try:
        with opener.open(request, timeout=float(timeout)) as response:  # noqa: S310 - fixed HTTPS destination
            status = int(getattr(response, "status", 200) or 200)
            content_type = str(response.headers.get("Content-Type") or "").lower()
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise MihomoEgressInfoError(
            "Сервис определения IP временно недоступен.",
            code="egress_lookup_upstream_error",
        ) from exc
    except Exception as exc:
        raise MihomoEgressInfoError(
            "Не удалось проверить IP через Mihomo.",
            code="egress_lookup_unreachable",
        ) from exc

    if status != 200:
        raise MihomoEgressInfoError(
            "Сервис определения IP временно недоступен.",
            code="egress_lookup_upstream_error",
        )
    if "json" not in content_type:
        raise MihomoEgressInfoError(
            "Сервис определения IP вернул неожиданный ответ.",
            code="egress_lookup_invalid_response",
        )
    if len(body) > MAX_RESPONSE_BYTES:
        raise MihomoEgressInfoError(
            "Ответ сервиса определения IP слишком большой.",
            code="egress_lookup_response_too_large",
        )
    try:
        decoded = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MihomoEgressInfoError(
            "Сервис определения IP вернул повреждённый ответ.",
            code="egress_lookup_invalid_response",
        ) from exc
    return decoded if isinstance(decoded, Mapping) else {}


def get_mihomo_egress_info(
    proxy_port: int,
    *,
    force_refresh: bool = False,
    ttl_seconds: float = DEFAULT_CACHE_TTL_SECONDS,
    minimum_refresh_seconds: float = MIN_FORCE_REFRESH_SECONDS,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    wall_clock: Callable[[], float] = time.time,
    fetcher: Callable[[int, float], Mapping[str, Any]] = _fetch_via_mihomo,
) -> dict[str, Any]:
    """Return a bounded lookup, cached per local Mihomo proxy port."""

    try:
        port = int(proxy_port)
    except (TypeError, ValueError, OverflowError) as exc:
        raise MihomoEgressInfoError(
            "HTTP/mixed-port Mihomo не настроен.",
            code="mihomo_proxy_port_unavailable",
            status=409,
        ) from exc
    if not 1 <= port <= 65535:
        raise MihomoEgressInfoError(
            "HTTP/mixed-port Mihomo не настроен.",
            code="mihomo_proxy_port_unavailable",
            status=409,
        )

    now = float(clock())
    ttl = max(10.0, float(ttl_seconds))
    minimum_refresh = max(1.0, float(minimum_refresh_seconds))
    with _LOCK:
        cached = _CACHE.get(port)
        age = now - float(cached.get("cached_at", 0.0)) if cached else float("inf")
        if cached and ((age < ttl and not force_refresh) or age < minimum_refresh):
            return {
                **dict(cached["payload"]),
                "cached": True,
                "cache_age_seconds": max(0, int(age)),
            }

        normalized = _normalize_payload(fetcher(port, float(timeout_seconds)))
        normalized["checked_at"] = max(0, int(wall_clock()))
        _CACHE[port] = {"cached_at": now, "payload": dict(normalized)}
        return {**normalized, "cached": False, "cache_age_seconds": 0}


def reset_mihomo_egress_info_cache() -> None:
    with _LOCK:
        _CACHE.clear()


__all__ = [
    "DEFAULT_CACHE_TTL_SECONDS",
    "IP_LOOKUP_URL",
    "MihomoEgressInfoError",
    "get_mihomo_egress_info",
    "reset_mihomo_egress_info_cache",
]
