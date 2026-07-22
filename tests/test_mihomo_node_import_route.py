from unittest.mock import patch

import pytest
from flask import Flask

from routes.mihomo import create_mihomo_blueprint
from services.mihomo_proxy_parsers import ProxyParseResult


@pytest.fixture()
def client(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text("proxies: []\n", encoding="utf-8")
    app = Flask(__name__)
    app.register_blueprint(
        create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(config),
            MIHOMO_TEMPLATES_DIR=str(tmp_path),
            MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "default.yaml"),
            restart_xkeen=lambda: None,
        )
    )
    return app.test_client(), config


def test_import_draft_route_returns_patched_content_without_writing_file(client):
    http, config_path = client
    source = (
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        "?encryption=none&security=tls&type=tcp#Mobile"
    )
    content = """\
proxies: []
proxy-groups:
  - name: Main
    type: select
    proxies: [DIRECT]
"""
    response = http.post(
        "/api/mihomo/node/import-draft",
        json={"content": content, "source": source, "mode": "proxy", "groups": ["Main"]},
    )

    assert response.status_code == 200
    result = response.get_json()
    assert result["inserted_names"] == ["Mobile"]
    assert "  - name: Mobile\n" in result["content"]
    assert '    proxies: [DIRECT, Mobile]' in result["content"]
    assert result["highlight"]["end"] > result["highlight"]["start"]
    assert config_path.read_text(encoding="utf-8") == "proxies: []\n"


def test_import_draft_route_falls_back_to_safe_provider_adapter(client):
    http, _config_path = client
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=("proxies:\n  - name: Clash\n    type: direct\n", {}),
    ), patch(
        "routes.mihomo._mh_hwid_probe_subscription_safe",
        return_value={"ok": True, "hwid_response_headers": {}},
    ), patch("routes.mihomo._mihomo_provider_direct_headers", return_value={}):
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "https://provider.example/subscription",
                "mode": "subscription",
                "groups": [],
            },
        )

    assert response.status_code == 200
    result = response.get_json()
    assert result["inserted_kind"] == "provider"
    assert "proxy-providers:" in result["content"]
    assert "http://127.0.0.1:" in result["content"]


def test_import_draft_route_selects_hwid_adapter_when_provider_requires_device(client):
    http, _config_path = client
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=("proxies:\n  - name: Placeholder\n    type: direct\n", {}),
    ), patch(
        "routes.mihomo._mh_hwid_probe_subscription_safe",
        return_value={"ok": True, "hwid_response_headers": {"x-hwid-not-supported": "true"}},
    ), patch("routes.mihomo._mihomo_provider_direct_headers", return_value={}), patch(
        "routes.mihomo._mh_hwid_get_device_info",
        return_value={"headers": {"x-hwid": "device"}},
    ), patch(
        "routes.mihomo._mh_hwid_fetch_provider_payload",
        return_value=(b"proxies: []\n", {}),
    ), patch(
        "routes.mihomo._mihomo_provider_payload_summary",
        return_value={"has_nodes": True, "node_count": 2},
    ):
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "https://provider.example/hwid",
                "mode": "subscription",
                "groups": [],
            },
        )

    assert response.status_code == 200
    assert "/mihomo/hwid/provider.yaml?" in response.get_json()["content"]


def test_import_draft_route_registers_xray_auto_update_when_requested(client):
    http, _config_path = client
    proxies = [ProxyParseResult("Node", "- name: Node\n  type: vless\n")]
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=("xray-json", {}),
    ), patch(
        "routes.mihomo._xray_convert_subscription_text",
        return_value=(proxies, []),
    ), patch("routes.mihomo._mh_sub_sync_imported_xray_subscription") as register:
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "https://provider.example/xray",
                "mode": "subscription",
                "groups": [],
                "auto_update_subscriptions": True,
                "interval_hours": 48,
            },
        )

    assert response.status_code == 200
    assert response.get_json()["registered_subscriptions"] == 1
    register.assert_called_once()
    assert register.call_args.kwargs["interval_hours"] == 48
    assert register.call_args.kwargs["proxy_yamls"] == [proxies[0].yaml]


def test_import_draft_route_rejects_invalid_mode(client):
    http, _config_path = client
    response = http.post(
        "/api/mihomo/node/import-draft",
        json={"content": "proxies: []\n", "source": "anything", "mode": "unknown"},
    )

    assert response.status_code == 400
    assert response.get_json()["code"] == "mihomo_node_import_invalid"
