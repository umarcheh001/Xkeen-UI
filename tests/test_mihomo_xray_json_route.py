"""Route-level tests for ``POST /api/mihomo/parse/xray-json``."""

from __future__ import annotations

import json
import urllib.error
from unittest.mock import patch

import pytest
from flask import Flask

from routes.mihomo import create_mihomo_blueprint


@pytest.fixture()
def client(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("proxies: []\n", encoding="utf-8")
    bp = create_mihomo_blueprint(
        MIHOMO_CONFIG_FILE=str(cfg),
        MIHOMO_TEMPLATES_DIR=str(tmp_path),
        MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "default.yaml"),
        restart_xkeen=lambda: None,
    )
    app = Flask(__name__)
    app.register_blueprint(bp)
    return app.test_client()


_SAMPLE_XRAY_SUBSCRIPTION = json.dumps(
    [
        {
            "remarks": "🇩🇪-Germany",
            "outbounds": [
                {
                    "tag": "proxy",
                    "protocol": "vless",
                    "settings": {
                        "vnext": [
                            {
                                "address": "1.2.3.4",
                                "port": 443,
                                "users": [
                                    {
                                        "id": "11111111-1111-1111-1111-111111111111",
                                        "encryption": "none",
                                    }
                                ],
                            }
                        ]
                    },
                    "streamSettings": {
                        "network": "xhttp",
                        "security": "tls",
                        "tlsSettings": {
                            "serverName": "edge.example.com",
                            "alpn": ["h2"],
                        },
                        "xhttpSettings": {"path": "/api/v2/", "mode": "auto"},
                    },
                },
                {"protocol": "freedom", "tag": "direct"},
            ],
        },
    ]
)


def test_parse_xray_json_with_inline_text(client):
    r = client.post(
        "/api/mihomo/parse/xray-json", json={"text": _SAMPLE_XRAY_SUBSCRIPTION}
    )
    assert r.status_code == 200
    data = r.get_json()
    assert data["ok"] is True
    assert data["count"] == 1
    assert data["proxies"][0]["proxy_name"].endswith("Germany")
    assert "type: vless" in data["proxies"][0]["proxy_yaml"]
    assert data["skipped"] == []
    assert data["proxies_yaml"].startswith("proxies:")


def test_parse_xray_json_url_fetched_through_fetcher(client):
    with patch(
        "routes.mihomo._xray_fetch_subscription_body_raw",
        return_value=(
            _SAMPLE_XRAY_SUBSCRIPTION,
            {"content-type": "application/json"},
            {"fetch_mode": "happ_ua", "warnings": ["Used Happ User-Agent fallback."]},
        ),
    ) as mock:
        r = client.post(
            "/api/mihomo/parse/xray-json",
            json={"url": "https://example.com/sub"},
        )
    assert r.status_code == 200
    assert r.get_json()["ok"] is True
    mock.assert_called_once_with("https://example.com/sub")


def test_parse_xray_json_follows_happ_redirect_and_keeps_full_profile(client):
    """Mihomo must use the same full Happ source as the Xray subscriptions UI."""

    source = "https://provider.example/subscription/happ"
    deep_link = "happ://crypt4/full-profile-token"
    profiles = []
    for index, (name, address) in enumerate(
        [
            ("Main node", "1.2.3.4"),
            ("Анти «Белые списки» 90.63fc", "5.6.7.8"),
            ("Анти «Белые списки» 97.9917", "9.10.11.12"),
        ],
        1,
    ):
        profile = json.loads(_SAMPLE_XRAY_SUBSCRIPTION)[0]
        profile["remarks"] = name
        outbound = profile["outbounds"][0]
        outbound["settings"]["vnext"][0]["address"] = address
        outbound["settings"]["vnext"][0]["users"][0]["id"] = (
            f"00000000-0000-0000-0000-{index:012d}"
        )
        profiles.append(profile)
    full_body = json.dumps(profiles, ensure_ascii=False)

    redirect = urllib.error.HTTPError(
        source,
        308,
        "Permanent Redirect",
        {"Location": deep_link},
        None,
    )
    with patch(
        "services.xray_subscriptions._fetch_subscription_body_once",
        side_effect=redirect,
    ), patch(
        "services.xray_subscriptions.happ_links.resolve_source",
        return_value={
            "kind": "text",
            "value": full_body,
            "via": "decryptor",
            "candidate": deep_link,
        },
    ):
        response = client.post("/api/mihomo/parse/xray-json", json={"url": source})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["count"] == 3
    assert [item["proxy_name"] for item in payload["proxies"]] == [
        "Main node",
        "Анти «Белые списки» 90.63fc",
        "Анти «Белые списки» 97.9917",
    ]
    assert payload["skipped"] == []


def test_parse_xray_json_returns_422_for_non_xray_body(client):
    r = client.post("/api/mihomo/parse/xray-json", json={"text": "<html>nope</html>"})
    assert r.status_code == 422
    body = r.get_json()
    assert body["code"] == "not_xray_json"


def test_parse_xray_json_surfaces_happ_landing_page_hint(client):
    body = (
        "<!DOCTYPE html><html><body>"
        '<a href="happ://crypt5/demo-token">Happ</a>'
        "</body></html>"
    )
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=(
            body,
            {
                "content-type": "text/html; charset=utf-8",
                "x-xkeen-happ-error": "happ_helper_not_configured",
            },
        ),
    ):
        r = client.post(
            "/api/mihomo/parse/xray-json",
            json={"url": "https://landing.example/sub"},
        )

    assert r.status_code == 422
    payload = r.get_json()
    assert payload["code"] == "happ_landing_page"
    assert "XKEEN_HAPP_HELPER_CMD" in payload["hint"]
    assert payload["ok"] is False


def test_parse_xray_json_surfaces_happ_decryptor_hint(client):
    body = (
        "<!DOCTYPE html><html><body>"
        '<a href="happ://crypt5/demo-token">Happ</a>'
        "</body></html>"
    )
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=(
            body,
            {
                "content-type": "text/html; charset=utf-8",
                "x-xkeen-happ-error": "happ_decryptor_not_configured",
            },
        ),
    ):
        r = client.post(
            "/api/mihomo/parse/xray-json",
            json={"url": "https://landing.example/sub"},
        )

    assert r.status_code == 422
    payload = r.get_json()
    assert payload["code"] == "happ_landing_page"
    assert "XKEEN_HAPP_DECRYPTOR_CMD" in payload["hint"]
    assert payload["ok"] is False


def test_parse_xray_json_returns_400_when_neither_url_nor_text(client):
    r = client.post("/api/mihomo/parse/xray-json", json={})
    assert r.status_code == 400


def test_parse_xray_json_propagates_url_blocked(client):
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        side_effect=RuntimeError("url_blocked:loopback"),
    ):
        r = client.post(
            "/api/mihomo/parse/xray-json", json={"url": "http://127.0.0.1/x"}
        )
    assert r.status_code == 400
    body = r.get_json()
    assert body["code"] == "url_blocked"


def test_parse_xray_json_propagates_size_limit(client):
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        side_effect=RuntimeError("size_limit"),
    ):
        r = client.post(
            "/api/mihomo/parse/xray-json", json={"url": "https://example.com/big"}
        )
    assert r.status_code == 413
    assert r.get_json()["code"] == "size_limit"


def test_parse_xray_json_fetch_failed_returns_user_hint(client):
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        side_effect=RuntimeError("connection timeout"),
    ):
        r = client.post(
            "/api/mihomo/parse/xray-json", json={"url": "https://example.com/sub"}
        )
    assert r.status_code == 502
    body = r.get_json()
    assert body["code"] == "fetch_failed"
    assert "DNS" in body["hint"]


def test_parse_xray_json_urlopen_failure_returns_user_hint_without_exception_log(client):
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        side_effect=urllib.error.URLError("certificate verify failed"),
    ), patch("routes.common.errors.log_route_exception") as log_exception:
        r = client.post(
            "/api/mihomo/parse/xray-json", json={"url": "https://example.com/sub"}
        )
    assert r.status_code == 502
    body = r.get_json()
    assert body["code"] == "fetch_failed"
    assert "certificate verify failed" in body["error"]
    log_exception.assert_not_called()


def test_parse_xray_json_returns_422_when_no_supported_proxies(client):
    body = json.dumps(
        [
            {
                "remarks": "ss-only",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "shadowsocks",
                        "settings": {"servers": [{"address": "x", "port": 1}]},
                    }
                ],
            }
        ]
    )
    r = client.post("/api/mihomo/parse/xray-json", json={"text": body})
    assert r.status_code == 422
    out = r.get_json()
    assert out["code"] == "no_supported_proxies"
    assert len(out.get("skipped") or []) == 1


def test_parse_xray_json_dedupes_against_existing_names(client):
    body = json.dumps(
        [
            {
                "remarks": "Germany",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "1.2.3.4",
                                    "port": 443,
                                    "users": [
                                        {
                                            "id": "11111111-1111-1111-1111-111111111111",
                                            "encryption": "none",
                                        }
                                    ],
                                }
                            ]
                        },
                        "streamSettings": {
                            "network": "tcp",
                            "security": "none",
                        },
                    }
                ],
            }
        ]
    )
    r = client.post(
        "/api/mihomo/parse/xray-json",
        json={"text": body, "existing_names": ["Germany"]},
    )
    assert r.status_code == 200
    data = r.get_json()
    assert data["proxies"][0]["proxy_name"] == "Germany_2"
