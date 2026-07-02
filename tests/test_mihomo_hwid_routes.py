from __future__ import annotations

import base64

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


def test_hwid_device_route_returns_diagnostics(monkeypatch, client):
    monkeypatch.setattr(
        mihomo,
        "_mh_hwid_get_device_info",
        lambda: {
            "mac": "aa:bb:cc:dd:ee:ff",
            "mac_hwid": "AABBCCDDEEFF",
            "hwid": "4194304",
            "hwid_source": "XKEEN_MIHOMO_HWID",
            "hwid_format": "string",
            "has_env_override": True,
            "hwid_matches_router_mac": False,
            "override_differs_from_router": True,
            "device_model": "Keenetic",
            "os_release": "4.2.6",
            "kernel_release": "4.2.6",
            "mihomo_version": "1.19.25",
            "mihomo_version_raw": "v1.19.25",
            "user_agent": "ClashMeta/1.19.25; mihomo/1.19.25",
            "headers": {"x-hwid": "4194304"},
            "hwid_warning": "warning",
        },
    )

    response = client.get("/api/mihomo/hwid/device")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["mac_hwid"] == "AABBCCDDEEFF"
    assert payload["hwid_format"] == "string"
    assert payload["override_differs_from_router"] is True


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
    monkeypatch.setattr(
        mihomo,
        "_mh_hwid_fetch_provider_payload",
        lambda *args, **kwargs: (
            "proxies:\n  - name: node-1\n    type: direct\n",
            {"format": "yaml", "proxy_section": True, "bytes": 42},
        ),
    )

    response = client.post(
        "/api/mihomo/hwid/probe",
        json={"url": "https://127.0.0.1/sub"},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert calls[0]["allow_private_hosts"] is True
    assert calls[0]["headers"]["x-hwid"] == "AABBCCDDEEFF"
    assert payload["provider_payload"]["has_nodes"] is True
    assert payload["provider_payload"]["node_count"] == 1
    assert "no_headers_ok" not in payload
    assert len(calls) == 1


def test_hwid_probe_route_warns_when_hwid_payload_empty_but_regular_has_nodes(monkeypatch, client):
    monkeypatch.setattr(
        mihomo,
        "_mh_hwid_get_device_info",
        lambda: {"headers": {"x-hwid": "AABBCCDDEEFF"}},
    )

    def fake_probe(url, *, headers, insecure, timeout, prefer, policy):
        return {
            "ok": True,
            "probe": {"url": url, "http_status": 200, "method": "HEAD"},
            "profile": {"profile_title": "Empty", "suggested_name": "Empty"},
            "headers_used": headers or {},
            "warnings": [],
            "error": None,
        }

    fetch_calls = []

    def fake_fetch(url, *, headers, insecure, timeout, policy):
        fetch_calls.append(headers)
        if headers:
            return "proxies: []\n", {
                "format": "yaml",
                "proxy_section": True,
                "content_type": "text/yaml",
                "bytes": 12,
            }
        return "dmxlc3M6Ly9leGFtcGxl\n", {
            "format": "raw",
            "content_type": "text/plain",
            "bytes": 24,
        }

    monkeypatch.setattr(mihomo, "_mh_hwid_probe_subscription_safe", fake_probe)
    monkeypatch.setattr(mihomo, "_mh_hwid_fetch_provider_payload", fake_fetch)

    response = client.post(
        "/api/mihomo/hwid/probe",
        json={"url": "https://provider.example/sub"},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["provider_payload"]["has_nodes"] is False
    assert payload["provider_payload"]["empty_proxy_provider"] is True
    assert payload["regular_provider_payload"]["has_nodes"] is True
    codes = [w["code"] for w in payload["warnings"]]
    assert "HWID_PROVIDER_EMPTY" in codes
    assert "HWID_EMPTY_BUT_REGULAR_HAS_NODES" in codes
    assert fetch_calls[0] == {"x-hwid": "AABBCCDDEEFF"}
    assert fetch_calls[1] == {}


def test_mihomo_provider_payload_summary_counts_base64_uri_nodes():
    summary = mihomo._mihomo_provider_payload_summary(
        "dmxlc3M6Ly9leGFtcGxl\n",
        {"format": "raw", "bytes": 24},
    )

    assert summary["has_nodes"] is True
    assert summary["base64_uri_count"] == 1
    assert summary["node_count"] == 1


def test_mihomo_provider_payload_summary_counts_hysteria_uri_nodes():
    summary = mihomo._mihomo_provider_payload_summary(
        "hysteria://secret@example.com:443#hy\n",
        {"format": "raw", "bytes": 40},
    )

    assert summary["has_nodes"] is True
    assert summary["raw_uri_count"] == 1
    assert summary["node_count"] == 1


def test_mihomo_provider_payload_summary_exposes_happ_fallback_meta():
    summary = mihomo._mihomo_provider_payload_summary(
        "proxies:\n  - name: hy\n    type: hysteria2\n",
        {
            "format": "xray-json",
            "converted": True,
            "xray_json": True,
            "happ_fallback_used": True,
            "happ_fallback_original_count": 6,
            "proxy_count": 15,
            "skipped_count": 0,
        },
    )

    assert summary["xray_json"] is True
    assert summary["happ_fallback_used"] is True
    assert summary["happ_fallback_original_count"] == 6
    assert summary["proxy_count"] == 15
    assert summary["skipped_count"] == 0


def test_mihomo_provider_payload_summary_exposes_hwid_limit_info():
    summary = mihomo._mihomo_provider_payload_summary(
        "proxies:\n  - name: one\n    type: vless\n",
        {
            "format": "raw",
            "hwid_response_headers": {
                "x-hwid-limit": "true",
                "x-hwid-devices": "4/4",
            },
        },
    )

    assert summary["hwid_limit_info"]["reached"] is True
    assert summary["hwid_limit_info"]["used"] == 4
    assert summary["hwid_limit_info"]["limit"] == 4


def test_mihomo_provider_payload_summary_treats_hwid_placeholder_nodes_as_empty():
    dummy = (
        "vless://00000000-0000-0000-0000-000000000000@0.0.0.0:1"
        "?encryption=none#HWID%20%D0%BD%D0%B5%20%D0%BF%D0%BE%D0%B4%D0%B4%D0%B5%D1%80%D0%B6%D0%B0%D0%BD"
    )
    encoded = base64.b64encode(dummy.encode("utf-8")).decode("ascii")

    summary = mihomo._mihomo_provider_payload_summary(
        encoded,
        {
            "format": "raw",
            "hwid_response_headers": {
                "x-hwid-limit": "true",
                "x-hwid-not-supported": "true",
            },
        },
    )

    assert summary["base64_uri_count"] == 1
    assert summary["placeholder_node_count"] == 1
    assert summary["hwid_placeholder_provider"] is True
    assert summary["node_count"] == 0
    assert summary["has_nodes"] is False


def test_mihomo_provider_payload_summary_detects_yaml_device_limit_placeholder():
    payload = """
proxies:
  - name: "📱 Превышен лимит устройств "
    type: vless
    server: 0.0.0.0
    port: 1
    uuid: 00000000-0000-0000-0000-000000000000
proxy-groups:
  - name: Remnawave
    proxies:
      - "📱 Превышен лимит устройств "
"""

    summary = mihomo._mihomo_provider_payload_summary(
        payload,
        {"format": "yaml", "content_type": "text/yaml"},
    )

    assert summary["yaml_proxy_count"] >= 1
    assert summary["placeholder_node_count"] >= 1
    assert summary["hwid_placeholder_provider"] is True
    assert summary["hwid_placeholder_reason"] == "device_limit"
    assert summary["hwid_limit_info"]["reached"] is True
    assert summary["node_count"] == 0
    assert summary["has_nodes"] is False


def test_hwid_probe_route_maps_tls_handshake_timeout_to_504(monkeypatch, client):
    monkeypatch.setattr(
        mihomo,
        "_mh_hwid_get_device_info",
        lambda: {"headers": {"x-hwid": "AABBCCDDEEFF"}},
    )

    def fake_probe(url, *, headers, insecure, timeout, prefer, policy):
        return {
            "ok": False,
            "probe": {
                "url": url,
                "resolved_url": None,
                "method": "HEAD",
                "http_status": None,
                "content_type": None,
                "content_length": None,
                "timing_ms": int(timeout * 1000),
            },
            "profile": {
                "profile_title": None,
                "profile_title_raw": None,
                "profile_title_encoding": None,
                "suggested_name": None,
            },
            "headers_used": headers or {},
            "warnings": [],
            "error": {
                "code": "TLS_HANDSHAKE_TIMEOUT",
                "message": "TLS handshake с сервером подписки не завершился вовремя.",
                "hint": "Попробуйте другой VPN/exit-IP.",
                "retryable": True,
            },
        }

    monkeypatch.setattr(mihomo, "_mh_hwid_probe_subscription_safe", fake_probe)

    response = client.post(
        "/api/mihomo/hwid/probe",
        json={"url": "https://provider.example/sub"},
    )

    assert response.status_code == 504
    payload = response.get_json()
    assert payload["error"]["code"] == "TLS_HANDSHAKE_TIMEOUT"


def test_hwid_provider_adapter_route_is_loopback_only(monkeypatch, client):
    monkeypatch.setattr(
        mihomo,
        "_mh_hwid_get_device_info",
        lambda: {"headers": {"x-hwid": "AABBCCDDEEFF"}},
    )

    calls = []

    def fake_fetch(url, *, headers, insecure, timeout, policy):
        calls.append(
            {
                "url": url,
                "headers": headers,
                "insecure": insecure,
                "allow_custom_urls": policy.allow_custom_urls,
            }
        )
        return "proxies:\n  - name: node-1\n    type: direct\n", {"converted": True}

    monkeypatch.setattr(mihomo, "_mh_hwid_fetch_provider_payload", fake_fetch)

    response = client.get(
        "/mihomo/hwid/provider.yaml?url=https%3A%2F%2Fprovider.example%2Fsub&insecure=1"
    )

    assert response.status_code == 200
    assert response.get_data(as_text=True).startswith("proxies:\n")
    assert calls[0]["url"] == "https://provider.example/sub"
    assert calls[0]["headers"]["x-hwid"] == "AABBCCDDEEFF"
    assert calls[0]["insecure"] is True
    assert calls[0]["allow_custom_urls"] is True

    denied = client.get(
        "/mihomo/hwid/provider.yaml?url=https%3A%2F%2Fprovider.example%2Fsub",
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert denied.status_code == 403


def test_regular_provider_adapter_route_fetches_without_hwid_headers(monkeypatch, client):
    calls = []

    def fake_fetch(url, *, headers, insecure, timeout, policy):
        calls.append(
            {
                "url": url,
                "headers": headers,
                "insecure": insecure,
                "allow_custom_urls": policy.allow_custom_urls,
            }
        )
        return "dmxlc3M6Ly9leGFtcGxl\n", {"format": "raw"}

    monkeypatch.setattr(mihomo, "_mh_hwid_fetch_provider_payload", fake_fetch)

    response = client.get(
        "/mihomo/provider.yaml?url=http%3A%2F%2Fprovider.example%2Fsub&insecure=1"
    )

    assert response.status_code == 200
    assert response.get_data(as_text=True).startswith("dmxlc3M6")
    assert calls[0]["url"] == "http://provider.example/sub"
    assert calls[0]["headers"] == {}
    assert calls[0]["insecure"] is True
    assert calls[0]["allow_custom_urls"] is True

    denied = client.get(
        "/mihomo/provider.yaml?url=https%3A%2F%2Fprovider.example%2Fsub",
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert denied.status_code == 403


def test_regular_provider_probe_fetches_without_hwid_headers(monkeypatch, client):
    probe_calls = []
    fetch_calls = []

    def fake_probe(url, *, headers, insecure, timeout, prefer, policy):
        probe_calls.append(
            {
                "url": url,
                "headers": headers,
                "insecure": insecure,
                "prefer": prefer,
                "allow_http": policy.allow_http,
                "allow_custom_urls": policy.allow_custom_urls,
            }
        )
        return {
            "ok": True,
            "probe": {"url": url, "http_status": 200},
            "profile": {
                "profile_title": "Remnawave",
                "profile_title_raw": "base64:UmVtbmF3YXZl",
                "profile_title_encoding": "base64",
                "suggested_name": "Remnawave",
            },
            "headers_used": {},
            "warnings": [],
        }

    def fake_fetch(url, *, headers, insecure, timeout, policy):
        fetch_calls.append(
            {
                "url": url,
                "headers": headers,
                "insecure": insecure,
                "allow_http": policy.allow_http,
            }
        )
        return "dmxlc3M6Ly9leGFtcGxl\n", {
            "format": "raw",
            "content_type": "text/plain",
            "bytes": 24,
        }

    monkeypatch.setattr(mihomo, "_mh_hwid_probe_subscription_safe", fake_probe)
    monkeypatch.setattr(mihomo, "_mh_hwid_fetch_provider_payload", fake_fetch)

    response = client.post(
        "/api/mihomo/provider/probe",
        json={"url": "http://provider.example/sub", "insecure": True},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["profile"]["suggested_name"] == "Remnawave"
    assert payload["provider_url"] == "http://provider.example/sub"
    assert payload["provider_headers"] == {"User-Agent": "router"}
    assert payload["provider_mode"] == "direct_headers"
    assert payload["provider_payload"]["format"] == "raw"
    assert probe_calls[0]["url"] == "http://provider.example/sub"
    assert probe_calls[0]["headers"] == {}
    assert probe_calls[0]["insecure"] is True
    assert probe_calls[0]["prefer"] == "head_then_range_get"
    assert probe_calls[0]["allow_http"] is True
    assert probe_calls[0]["allow_custom_urls"] is True
    assert fetch_calls[0]["headers"] == {"User-Agent": "router"}
    assert fetch_calls[0]["allow_http"] is True


def test_regular_provider_probe_falls_back_to_adapter_when_direct_headers_empty(monkeypatch, client):
    def fake_probe(url, *, headers, insecure, timeout, prefer, policy):
        return {
            "ok": True,
            "probe": {"url": url, "http_status": 200},
            "profile": {"profile_title": "Empty", "suggested_name": "Empty"},
            "headers_used": {},
            "warnings": [],
        }

    def fake_fetch(url, *, headers, insecure, timeout, policy):
        return "proxies: []\n", {"format": "yaml", "content_type": "text/yaml", "bytes": 12}

    monkeypatch.setattr(mihomo, "_mh_hwid_probe_subscription_safe", fake_probe)
    monkeypatch.setattr(mihomo, "_mh_hwid_fetch_provider_payload", fake_fetch)

    response = client.post(
        "/api/mihomo/provider/probe",
        json={"url": "https://provider.example/sub"},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["provider_url"].startswith("http://127.0.0.1:")
    assert "/mihomo/provider.yaml?" in payload["provider_url"]
    assert payload["provider_headers"] == {}
    assert payload["provider_mode"] == "adapter"


def test_regular_provider_probe_rejects_html_install_page_from_adapter(monkeypatch, client):
    monkeypatch.setattr(mihomo, "_mihomo_provider_direct_headers", lambda: {})

    def fake_probe(url, *, headers, insecure, timeout, prefer, policy):
        return {
            "ok": True,
            "probe": {"url": url, "http_status": 200},
            "profile": {"profile_title": "Landing", "suggested_name": "Landing"},
            "headers_used": {},
            "warnings": [],
        }

    def fake_fetch(url, *, headers, insecure, timeout, policy):
        raise ValueError("landing_page_html:install_page")

    monkeypatch.setattr(mihomo, "_mh_hwid_probe_subscription_safe", fake_probe)
    monkeypatch.setattr(mihomo, "_mh_hwid_fetch_provider_payload", fake_fetch)

    response = client.post(
        "/api/mihomo/provider/probe",
        json={"url": "https://provider.example/sub"},
    )

    assert response.status_code == 400
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["error"]["code"] == "LANDING_PAGE_HTML"
    assert "Happ/INCY" in payload["error"]["hint"]


def test_regular_provider_probe_prefers_hwid_adapter_when_hwid_payload_has_more_nodes(monkeypatch, client):
    monkeypatch.setattr(
        mihomo,
        "_mh_hwid_get_device_info",
        lambda: {"headers": {"x-hwid": "AABBCCDDEEFF", "User-Agent": "ClashMeta/1.19.24"}},
    )

    def fake_probe(url, *, headers, insecure, timeout, prefer, policy):
        return {
            "ok": True,
            "probe": {"url": url, "http_status": 200},
            "profile": {"profile_title": "HWID", "suggested_name": "HWID"},
            "headers_used": headers or {},
            "hwid_response_headers": {"x-hwid-not-supported": "true"},
            "warnings": [],
        }

    fetch_calls = []

    def fake_fetch(url, *, headers, insecure, timeout, policy):
        fetch_calls.append(dict(headers or {}))
        if (headers or {}).get("x-hwid"):
            return (
                "proxies:\n"
                "  - name: one\n"
                "    type: vless\n"
                "  - name: two\n"
                "    type: hysteria2\n",
                {"format": "xray-json", "converted": True, "proxy_section": True},
            )
        return (
            "dmxlc3M6Ly9leGFtcGxl\n",
            {
                "format": "raw",
                "hwid_response_headers": {"x-hwid-not-supported": "true"},
            },
        )

    monkeypatch.setattr(mihomo, "_mh_hwid_probe_subscription_safe", fake_probe)
    monkeypatch.setattr(mihomo, "_mh_hwid_fetch_provider_payload", fake_fetch)

    response = client.post(
        "/api/mihomo/provider/probe",
        json={"url": "https://provider.example/sub"},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["provider_mode"] == "hwid_adapter"
    assert "/mihomo/hwid/provider.yaml?" in payload["provider_url"]
    assert payload["provider_headers"] == {}
    assert payload["provider_payload"]["node_count"] == 2
    assert [item["proxy_name"] for item in payload["provider_proxies"]] == [
        "one",
        "two",
    ]
    assert payload["provider_proxies"][0]["proxy_yaml"].startswith("- name: one\n")
    assert fetch_calls[0] == {"User-Agent": "router"}
    assert fetch_calls[1]["x-hwid"] == "AABBCCDDEEFF"


def test_regular_provider_probe_ignores_hwid_placeholder_direct_nodes(monkeypatch, client):
    monkeypatch.setattr(
        mihomo,
        "_mh_hwid_get_device_info",
        lambda: {"headers": {"x-hwid": "AABBCCDDEEFF", "User-Agent": "ClashMeta/1.19.24"}},
    )

    dummy_lines = "\n".join(
        [
            (
                "vless://00000000-0000-0000-0000-000000000000@0.0.0.0:1"
                f"?encryption=none#HWID%20placeholder%20{i}"
            )
            for i in range(3)
        ]
    )
    dummy_payload = base64.b64encode(dummy_lines.encode("utf-8")).decode("ascii")

    def fake_probe(url, *, headers, insecure, timeout, prefer, policy):
        return {
            "ok": True,
            "probe": {"url": url, "http_status": 200},
            "profile": {"profile_title": "HWID", "suggested_name": "HWID"},
            "headers_used": headers or {},
            "hwid_response_headers": {
                "x-hwid-limit": "true",
                "x-hwid-not-supported": "true",
            },
            "warnings": [],
        }

    fetch_calls = []

    def fake_fetch(url, *, headers, insecure, timeout, policy):
        fetch_calls.append(dict(headers or {}))
        if (headers or {}).get("x-hwid"):
            return (
                "proxies:\n"
                "  - name: real\n"
                "    type: vless\n",
                {"format": "yaml", "proxy_section": True},
            )
        return (
            dummy_payload,
            {
                "format": "raw",
                "hwid_response_headers": {
                    "x-hwid-limit": "true",
                    "x-hwid-not-supported": "true",
                },
            },
        )

    monkeypatch.setattr(mihomo, "_mh_hwid_probe_subscription_safe", fake_probe)
    monkeypatch.setattr(mihomo, "_mh_hwid_fetch_provider_payload", fake_fetch)

    response = client.post(
        "/api/mihomo/provider/probe",
        json={"url": "https://provider.example/sub"},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["provider_mode"] == "hwid_adapter"
    assert "/mihomo/hwid/provider.yaml?" in payload["provider_url"]
    assert payload["provider_headers"] == {}
    assert payload["provider_payload"]["node_count"] == 1
    assert fetch_calls[0] == {"User-Agent": "router"}
    assert fetch_calls[1]["x-hwid"] == "AABBCCDDEEFF"


def test_regular_provider_probe_tries_hwid_for_placeholder_without_hwid_headers(monkeypatch, client):
    monkeypatch.setattr(
        mihomo,
        "_mh_hwid_get_device_info",
        lambda: {"headers": {"x-hwid": "AABBCCDDEEFF", "User-Agent": "ClashMeta/1.19.24"}},
    )

    dummy_lines = "\n".join(
        [
            (
                "vless://00000000-0000-0000-0000-000000000000@0.0.0.0:1"
                f"?encryption=none#Enable%20HWID%20{i}"
            )
            for i in range(2)
        ]
    )
    dummy_payload = base64.b64encode(dummy_lines.encode("utf-8")).decode("ascii")

    def fake_probe(url, *, headers, insecure, timeout, prefer, policy):
        return {
            "ok": True,
            "probe": {"url": url, "http_status": 200},
            "profile": {"profile_title": "RightSide", "suggested_name": "RightSide"},
            "headers_used": headers or {},
            "hwid_response_headers": {},
            "warnings": [],
        }

    fetch_calls = []

    def fake_fetch(url, *, headers, insecure, timeout, policy):
        fetch_calls.append(dict(headers or {}))
        if (headers or {}).get("x-hwid"):
            return (
                "proxies:\n"
                "  - name: Finland\n"
                "    type: vless\n"
                "  - name: Germany\n"
                "    type: vless\n",
                {"format": "yaml", "converted": True, "proxy_section": True},
            )
        return dummy_payload, {"format": "raw", "hwid_response_headers": {}}

    monkeypatch.setattr(mihomo, "_mh_hwid_probe_subscription_safe", fake_probe)
    monkeypatch.setattr(mihomo, "_mh_hwid_fetch_provider_payload", fake_fetch)

    response = client.post(
        "/api/mihomo/provider/probe",
        json={"url": "https://provider.example/sub"},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["provider_mode"] == "hwid_adapter"
    assert "/mihomo/hwid/provider.yaml?" in payload["provider_url"]
    assert payload["provider_headers"] == {}
    assert payload["provider_payload"]["node_count"] == 2
    assert [item["proxy_name"] for item in payload["provider_proxies"]] == [
        "Finland",
        "Germany",
    ]
    assert payload["provider_proxies"][0]["proxy_yaml"].startswith("- name: Finland\n")
    assert fetch_calls[0] == {"User-Agent": "router"}
    assert fetch_calls[1]["x-hwid"] == "AABBCCDDEEFF"
