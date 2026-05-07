from __future__ import annotations

import pytest
from flask import Flask

from routes import mihomo


@pytest.fixture()
def client(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("proxy-providers: {}\n", encoding="utf-8")
    bp = mihomo.create_mihomo_blueprint(
        MIHOMO_CONFIG_FILE=str(cfg),
        MIHOMO_TEMPLATES_DIR=str(tmp_path),
        MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "default.yaml"),
        restart_xkeen=lambda: None,
    )
    app = Flask(__name__)
    app.register_blueprint(bp)
    return app.test_client()


def test_hwid_probe_route_blocks_private_url_before_probe(monkeypatch, client):
    monkeypatch.delenv("XKEEN_MIHOMO_HWID_ALLOW_PRIVATE_HOSTS", raising=False)
    calls = []

    def fake_probe(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("probe should not be called for blocked URL")

    monkeypatch.setattr(mihomo, "_mh_hwid_probe_subscription_safe", fake_probe)

    response = client.post(
        "/api/mihomo/hwid/probe",
        json={"url": "https://127.0.0.1/sub"},
    )

    assert response.status_code == 400
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["error"]["code"] == "URL_BLOCKED"
    assert payload["error"]["reason"] == "private_host_not_allowed:127.0.0.1"
    assert calls == []


def test_hwid_apply_route_blocks_http_url_before_probe(monkeypatch, client):
    monkeypatch.delenv("XKEEN_MIHOMO_HWID_ALLOW_HTTP", raising=False)
    calls = []

    def fake_probe(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("probe should not be called for blocked URL")

    monkeypatch.setattr(mihomo, "_mh_hwid_probe_subscription_safe", fake_probe)

    response = client.post(
        "/api/mihomo/hwid/apply",
        json={"url": "http://example.com/sub", "name": "sub", "restart": True},
    )

    assert response.status_code == 400
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["stage"] == "probe"
    assert payload["probe"]["error"]["code"] == "URL_BLOCKED"
    assert payload["probe"]["error"]["reason"] == "http_not_allowed"
    assert calls == []


def test_hwid_probe_route_allows_private_url_when_enabled(monkeypatch, client):
    monkeypatch.setenv("XKEEN_MIHOMO_HWID_ALLOW_PRIVATE_HOSTS", "1")
    calls = []

    monkeypatch.setattr(
        mihomo,
        "_mh_hwid_get_device_info",
        lambda: {"headers": {"x-hwid": "AABBCCDDEEFF"}},
    )

    def fake_probe(url, *, headers, insecure, timeout, prefer, policy):
        calls.append(
            {
                "url": url,
                "headers": headers,
                "allow_private_hosts": policy.allow_private_hosts,
            }
        )
        return {
            "ok": True,
            "probe": {
                "url": url,
                "resolved_url": url,
                "method": "HEAD",
                "http_status": 200,
                "content_type": "text/plain",
                "content_length": 0,
                "timing_ms": 1,
            },
            "profile": {
                "profile_title": "Local",
                "profile_title_raw": "Local",
                "profile_title_encoding": None,
                "suggested_name": "Local",
            },
            "headers_used": headers or {},
            "warnings": [],
            "error": None,
        }

    monkeypatch.setattr(mihomo, "_mh_hwid_probe_subscription_safe", fake_probe)

    response = client.post(
        "/api/mihomo/hwid/probe",
        json={"url": "https://127.0.0.1/sub"},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert calls[0]["allow_private_hosts"] is True
    assert calls[0]["headers"]["x-hwid"] == "AABBCCDDEEFF"
    assert calls[1]["headers"] is None

