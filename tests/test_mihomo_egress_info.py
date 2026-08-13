from __future__ import annotations

import pytest

from services.mihomo_egress_info import (
    MihomoEgressInfoError,
    get_mihomo_egress_info,
    reset_mihomo_egress_info_cache,
)


def setup_function():
    reset_mihomo_egress_info_cache()


def test_egress_info_normalizes_and_caches_bounded_fields():
    calls = []

    def fetcher(port, timeout):
        calls.append((port, timeout))
        return {
            "ip": "2001:db8::8",
            "version": "IPv6",
            "city": "Helsinki",
            "region": "Uusimaa",
            "country_name": "Finland",
            "country_code": "fi",
            "asn": "64500",
            "org": "Example Network",
            "timezone": "Europe/Helsinki",
            "latitude": 60.1,
            "longitude": 24.9,
            "postal": "00100",
        }

    first = get_mihomo_egress_info(
        7890, fetcher=fetcher, clock=lambda: 100, wall_clock=lambda: 1000,
    )
    second = get_mihomo_egress_info(
        7890, fetcher=fetcher, clock=lambda: 120, wall_clock=lambda: 1001,
    )

    assert first == {
        "ip": "2001:db8::8",
        "ip_version": "IPv6",
        "city": "Helsinki",
        "region": "Uusimaa",
        "country": "Finland",
        "country_code": "FI",
        "asn": "AS64500",
        "organization": "Example Network",
        "timezone": "Europe/Helsinki",
        "checked_at": 1000,
        "cached": False,
        "cache_age_seconds": 0,
    }
    assert second["cached"] is True
    assert second["cache_age_seconds"] == 20
    assert calls == [(7890, 7.0)]


def test_egress_info_force_refresh_is_rate_limited():
    values = iter(({"ip": "203.0.113.1"}, {"ip": "203.0.113.2"}))
    fetcher = lambda _port, _timeout: next(values)
    first = get_mihomo_egress_info(7890, fetcher=fetcher, clock=lambda: 10)
    limited = get_mihomo_egress_info(7890, force_refresh=True, fetcher=fetcher, clock=lambda: 15)
    refreshed = get_mihomo_egress_info(7890, force_refresh=True, fetcher=fetcher, clock=lambda: 21)
    assert first["ip"] == "203.0.113.1"
    assert limited["ip"] == "203.0.113.1"
    assert limited["cached"] is True
    assert refreshed["ip"] == "203.0.113.2"


@pytest.mark.parametrize("port", (None, 0, 65536, "bad"))
def test_egress_info_rejects_missing_proxy_port(port):
    with pytest.raises(MihomoEgressInfoError) as captured:
        get_mihomo_egress_info(port, fetcher=lambda *_args: {"ip": "203.0.113.8"})
    assert captured.value.code == "mihomo_proxy_port_unavailable"


@pytest.mark.parametrize("payload", ({}, {"ip": "not-an-ip"}, {"ip": "203.0.113.8", "error": True}))
def test_egress_info_rejects_invalid_upstream_payload(payload):
    with pytest.raises(MihomoEgressInfoError):
        get_mihomo_egress_info(7890, fetcher=lambda *_args: payload)
