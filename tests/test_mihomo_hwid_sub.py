from __future__ import annotations

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

