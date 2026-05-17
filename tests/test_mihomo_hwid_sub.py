from __future__ import annotations

import urllib.error

from services import mihomo_hwid_sub as hwid


def test_hwid_probe_blocks_private_hosts_by_default(monkeypatch):
    monkeypatch.delenv("XKEEN_MIHOMO_HWID_ALLOW_PRIVATE_HOSTS", raising=False)

    result = hwid.probe_subscription(
        "https://127.0.0.1/sub",
        headers={"x-hwid": "AABBCCDDEEFF"},
    )

    assert result["ok"] is False
    err = result["error"]
    assert err["code"] == "URL_BLOCKED"
    assert err["reason"] == "private_host_not_allowed:127.0.0.1"
    assert "XKEEN_MIHOMO_HWID_ALLOW_PRIVATE_HOSTS=1" in err["hint"]


def test_hwid_probe_blocks_plain_http_by_default(monkeypatch):
    monkeypatch.delenv("XKEEN_MIHOMO_HWID_ALLOW_HTTP", raising=False)

    result = hwid.probe_subscription(
        "http://example.com/sub",
        headers={"x-hwid": "AABBCCDDEEFF"},
    )

    assert result["ok"] is False
    err = result["error"]
    assert err["code"] == "URL_BLOCKED"
    assert err["reason"] == "http_not_allowed"
    assert "XKEEN_MIHOMO_HWID_ALLOW_HTTP=1" in err["hint"]


def test_hwid_probe_allows_public_custom_https_by_default(monkeypatch):
    calls = []

    def fake_probe_once(url, *, method, headers, insecure, timeout, policy):
        calls.append(
            {
                "url": url,
                "method": method,
                "headers": headers,
                "allow_custom_urls": policy.allow_custom_urls,
                "allow_private_hosts": policy.allow_private_hosts,
            }
        )
        return (
            hwid._ProbeMeta(
                url=url,
                resolved_url=url,
                method=method,
                http_status=200,
                content_type="text/plain",
                content_length=0,
                timing_ms=12,
            ),
            {
                "profile_title": "Premium Sub",
                "profile_title_raw": "Premium Sub",
                "profile_title_encoding": None,
                "suggested_name": "Premium_Sub",
            },
            [],
        )

    monkeypatch.setattr(hwid, "_probe_once", fake_probe_once)

    result = hwid.probe_subscription(
        "https://provider.example/sub",
        headers={"x-hwid": "AABBCCDDEEFF"},
    )

    assert result["ok"] is True
    assert result["profile"]["suggested_name"] == "Premium_Sub"
    assert calls and calls[0]["allow_custom_urls"] is True
    assert calls[0]["allow_private_hosts"] is False


def test_hwid_probe_private_host_can_be_enabled(monkeypatch):
    calls = []
    monkeypatch.setenv("XKEEN_MIHOMO_HWID_ALLOW_PRIVATE_HOSTS", "1")

    def fake_probe_once(url, *, method, headers, insecure, timeout, policy):
        calls.append(url)
        return (
            hwid._ProbeMeta(
                url=url,
                resolved_url=url,
                method=method,
                http_status=200,
                content_type="text/plain",
                content_length=0,
                timing_ms=1,
            ),
            {
                "profile_title": None,
                "profile_title_raw": None,
                "profile_title_encoding": None,
                "suggested_name": "",
            },
            [],
        )

    monkeypatch.setattr(hwid, "_probe_once", fake_probe_once)

    result = hwid.probe_subscription("https://127.0.0.1/sub", headers={})

    assert result["ok"] is True
    assert calls == ["https://127.0.0.1/sub"]


def test_hwid_device_info_uses_uuid_node_fallback_when_mac_missing(monkeypatch):
    monkeypatch.delenv("XKEEN_MIHOMO_HWID", raising=False)
    monkeypatch.delenv("XKEEN_HWID", raising=False)
    monkeypatch.setattr(hwid, "_pick_mac_address_keenetic", lambda: None)
    monkeypatch.setattr(hwid.uuid, "getnode", lambda: 0x6488FA3B0CF4)
    monkeypatch.setattr(hwid, "_ndmc_show_version", lambda: "")
    monkeypatch.setattr(hwid, "_detect_mihomo_version", lambda: "v1.19.25")

    info = hwid.get_device_info()

    assert info["hwid"] == "6488FA3B0CF4"
    assert info["hwid_source"] == "uuid_node"
    assert info["headers"]["x-hwid"] == "6488FA3B0CF4"
    assert info["headers"]["User-Agent"] == "mihomo/v1.19.25"
    assert "Обычно этого достаточно" in info["hwid_warning"]
    assert "DevTools → ENV" in info["hwid_warning"]
    assert "XKEEN_MIHOMO_HWID" in info["hwid_warning"]


def test_hwid_provider_entry_uses_mihomo_provider_defaults():
    entry = hwid.build_provider_entry(
        "OverSecure_VPN_4G",
        "https://oversub.cloud/eCNMgAGfH_ayLPH0",
        {
            "x-hwid": "6488FA3B0CF4",
            "x-device-os": "Keenetic OS",
            "x-ver-os": "4.2.6",
            "x-device-model": "Keenetic",
            "User-Agent": "mihomo/v1.19.25",
        },
    )

    assert "  OverSecure_VPN_4G:" in entry
    assert "    interval: 43200" in entry
    assert "      interval: 300" in entry
    assert "      expected-status: 204" in entry
    assert "      User-Agent:" in entry
    assert '      - "mihomo/v1.19.25"' in entry
    assert "      x-hwid:" in entry
    assert '      - "6488FA3B0CF4"' in entry
    assert "      x-device-os:" not in entry
    assert "    override:" in entry
    assert "      udp: true" in entry
    assert "      tfo: true" in entry


def test_hwid_probe_reports_tls_handshake_timeout(monkeypatch):
    def fake_probe_once(url, *, method, headers, insecure, timeout, policy):
        raise urllib.error.URLError("_ssl.c:999: The handshake operation timed out")

    monkeypatch.setattr(hwid, "_probe_once", fake_probe_once)

    result = hwid.probe_subscription(
        "https://provider.example/sub",
        headers={"x-hwid": "AABBCCDDEEFF"},
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "TLS_HANDSHAKE_TIMEOUT"
    assert result["error"]["message"] == "TLS handshake с сервером подписки не завершился вовремя."
    assert "VPN/exit-IP" in result["error"]["hint"]
    assert "_ssl.c:999" in result["error"]["detail"]
