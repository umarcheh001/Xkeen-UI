from __future__ import annotations

import json


def test_old_state_gets_auto_request_profile(tmp_path):
    from services import xray_subscriptions as subs

    path = tmp_path / subs.STATE_FILENAME
    path.write_text(
        json.dumps(
            {
                "subscriptions": [
                    {
                        "id": "one",
                        "url": "https://example.test/sub",
                        "tag": "one",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    loaded = subs.list_subscriptions(str(tmp_path))

    assert loaded[0]["request_profile"] == {
        "mode": "auto",
        "hwid": "",
        "user_agent": "",
        "device_os": "",
        "os_version": "",
        "device_model": "",
    }


def test_upsert_round_trips_custom_request_profile(tmp_path):
    from services import xray_subscriptions as subs

    saved = subs.upsert_subscription(
        str(tmp_path),
        {
            "url": "https://example.test/sub",
            "request_profile": {
                "mode": "custom",
                "hwid": "KNOWN",
                "user_agent": "Happ/3",
                "device_os": "Android",
                "os_version": "15",
                "device_model": "Phone",
            },
        },
    )

    assert saved["request_profile"] == {
        "mode": "custom",
        "hwid": "KNOWN",
        "user_agent": "Happ/3",
        "device_os": "Android",
        "os_version": "15",
        "device_model": "Phone",
    }
    assert subs.list_subscriptions(str(tmp_path))[0]["request_profile"] == saved["request_profile"]


def test_custom_profile_is_sent_without_auto_retry(monkeypatch):
    from services import xray_subscriptions as subs

    calls = []

    def fake_fetch(url, request_headers=None):
        calls.append(dict(request_headers or {}))
        return "vless://id@example.test:443", {}

    monkeypatch.setattr(subs, "fetch_subscription_body", fake_fetch)

    _body, _headers, meta = subs.fetch_subscription_body_for_xray(
        "https://example.test/sub",
        request_profile={"mode": "custom", "hwid": "KNOWN", "user_agent": "Happ/3"},
    )

    assert calls == [{"x-hwid": "KNOWN", "User-Agent": "Happ/3"}]
    assert meta["fetch_mode"] == "custom"


def test_disabled_profile_does_not_use_detected_fallback(monkeypatch):
    from services import xray_subscriptions as subs

    calls = []

    def fake_fetch(url, request_headers=None):
        calls.append(dict(request_headers or {}))
        return "", {"x-hwid-not-supported": "true"}

    monkeypatch.setattr(subs, "fetch_subscription_body", fake_fetch)

    _body, _headers, meta = subs.fetch_subscription_body_for_xray(
        "https://example.test/sub",
        request_profile={"mode": "disabled"},
    )

    assert calls == [{}]
    assert meta["fetch_mode"] == "disabled"


def test_auto_profile_keeps_adaptive_retry(monkeypatch):
    from services import xray_subscriptions as subs

    calls = []

    def fake_fetch(url, request_headers=None):
        headers = dict(request_headers or {})
        calls.append(headers)
        if headers.get("x-hwid") == "ROUTER":
            return "vless://id@example.test:443", {}
        return "", {"x-hwid-not-supported": "true"}

    monkeypatch.setattr(subs, "fetch_subscription_body", fake_fetch)
    monkeypatch.setattr(
        subs,
        "_subscription_request_variants",
        lambda: [("hwid", {"x-hwid": "ROUTER"}, "retried")],
    )

    _body, _headers, meta = subs.fetch_subscription_body_for_xray(
        "https://example.test/sub",
        request_profile={"mode": "auto"},
    )

    assert calls == [{}, {"x-hwid": "ROUTER"}]
    assert meta["fetch_mode"] == "hwid"
