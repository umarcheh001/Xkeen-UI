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


def test_parse_amnezia_premium_key_returns_mihomo_proxy(client):
    http, _config_path = client
    wireguard_config = """\
[Interface]
Name = Amnezia Premium
PrivateKey = private-key
Address = 10.0.0.2/32
Jc = 5

[Peer]
PublicKey = server-key
Endpoint = fi-edge.example:51820
AllowedIPs = 0.0.0.0/0
"""
    with patch(
        "routes.mihomo._amnezia_import_connection_key",
        return_value=wireguard_config,
    ) as importer:
        response = http.post(
            "/api/mihomo/parse/amnezia-premium",
            json={"text": "vpn://test-key"},
        )

    assert response.status_code == 200
    result = response.get_json()
    assert result["proxy_name"] == "Amnezia Premium"
    assert "server: fi-edge.example" in result["proxy_yaml"]
    assert "jc: 5" in result["proxy_yaml"]
    importer.assert_called_once_with("vpn://test-key")


def test_amnezia_premium_locations_route_only_loads_available_locations(client):
    http, _config_path = client
    locations = [
        {"code": "FI", "name": "Finland"},
        {"code": "DE", "name": "Germany"},
    ]
    with patch(
        "routes.mihomo._amnezia_list_available_locations",
        return_value=locations,
    ) as list_locations:
        response = http.post(
            "/api/mihomo/amnezia-premium/locations",
            json={"text": "vpn://test-key"},
        )

    assert response.status_code == 200
    assert response.get_json()["locations"] == locations
    list_locations.assert_called_once_with("vpn://test-key")


def test_parse_amnezia_premium_key_returns_every_selected_location(client):
    http, _config_path = client
    calls = []

    def issue_config(text, *, server_country_code="", display_name=""):
        calls.append((text, server_country_code, display_name))
        return f"""\
[Interface]
PrivateKey = private-{server_country_code}
Address = 10.0.0.2/32

[Peer]
PublicKey = server-{server_country_code}
Endpoint = {server_country_code.lower()}.example:51820
AllowedIPs = 0.0.0.0/0
"""

    with patch(
        "routes.mihomo._amnezia_import_connection_key",
        side_effect=issue_config,
    ):
        response = http.post(
            "/api/mihomo/parse/amnezia-premium",
            json={
                "text": "vpn://test-key",
                "server_country_codes": ["FI", "DE"],
                "locations": [
                    {"code": "FI", "name": "Finland"},
                    {"code": "DE", "name": "Germany"},
                ],
                "existing_names": ["Germany"],
            },
        )

    assert response.status_code == 200
    result = response.get_json()
    assert [proxy["proxy_name"] for proxy in result["proxies"]] == ["Finland", "Germany_2"]
    assert "server: fi.example" in result["proxies"][0]["proxy_yaml"]
    assert "server: de.example" in result["proxies"][1]["proxy_yaml"]
    assert calls == [
        ("vpn://test-key", "FI", "Finland"),
        ("vpn://test-key", "DE", "Germany"),
    ]


def test_import_draft_route_auto_detects_amnezia_premium_key(client):
    http, _config_path = client
    wireguard_config = """\
[Interface]
Name = Amnezia Premium
PrivateKey = private-key
Address = 10.0.0.2/32

[Peer]
PublicKey = server-key
Endpoint = fi-edge.example:51820
AllowedIPs = 0.0.0.0/0
"""
    with patch(
        "routes.mihomo._amnezia_import_connection_key",
        return_value=wireguard_config,
    ) as importer:
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "vpn://test-key",
                "mode": "auto",
                "groups": [],
            },
        )

    assert response.status_code == 200
    assert "server: fi-edge.example" in response.get_json()["content"]
    importer.assert_called_once_with("vpn://test-key")


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
        "routes.mihomo._xray_convert_subscription_source_text",
        return_value=(proxies, [], "xray-json"),
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


def test_import_draft_route_converts_base64_xray_links_from_happ_subscription(client):
    http, _config_path = client
    link = (
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        "?encryption=none&security=tls&type=ws&path=%2Fws#Happ%20Node"
    )
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=(link, {"content-type": "text/plain"}),
    ):
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "happ://crypt5/demo-token",
                "mode": "subscription",
                "groups": [],
            },
        )

    assert response.status_code == 200
    result = response.get_json()
    assert result["inserted_kind"] == "proxy"
    assert result["inserted_names"] == ["Happ Node"]
    assert "server: example.com" in result["content"]


def test_import_draft_route_rejects_unsupported_client_placeholder(client):
    http, _config_path = client
    blocked = (
        "vless://00000000-0000-0000-0000-000000000000@subscription.blocked:443"
        "?security=tls&type=tcp#unsupported%20client"
    )
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=(blocked, {"content-type": "text/plain"}),
    ):
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "happ://crypt5/demo-token",
                "mode": "subscription",
                "groups": [],
            },
        )

    assert response.status_code == 400
    assert "служебную заглушку" in response.get_json()["error"]


def test_import_draft_route_rejects_invalid_mode(client):
    http, _config_path = client
    response = http.post(
        "/api/mihomo/node/import-draft",
        json={"content": "proxies: []\n", "source": "anything", "mode": "unknown"},
    )

    assert response.status_code == 400
    assert response.get_json()["code"] == "mihomo_node_import_invalid"
