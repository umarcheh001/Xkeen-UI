from __future__ import annotations

import pytest
import yaml
from flask import Flask

from routes.mihomo import create_mihomo_blueprint
from services.mihomo_generator_proxies import insert_proxies_from_state
from services.mihomo_proxy_parsers import parse_openvpn, parse_tailscale, parse_wireguard


AMNEZIA_WG_V2_CONF = """
[Interface]
PrivateKey = eCtXsJZ27+4PbhDkHnB923tkUn2Gj59wZw5wFA75MnU=
Address = 172.16.0.2/32, fd01:5ca1:ab1e:80fa:ab85:6eea:213f:f4a5/128
DNS = 1.1.1.1, 8.8.8.8
MTU = 1408
Jc = 5
Jmin = 500
Jmax = 501
S1 = 30
S2 = 40
S3 = 50
S4 = 5
H1 = 123456-123500
H2 = 67543-67550
H3 = 123123-123200
H4 = 32345-32350
I1 = <b 0xf6ab3267fa><c><b 0xf6ab><t><r 10><wt 10>
I2 = <b 0xf6ab3267fa><r 100>
I3 = ""
I4 = ""
I5 = ""

[Peer]
PublicKey = Cr8hWlKvtDt7nrvf+f0brNQQzabAqrjfBvas9pmowjo=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 162.159.192.1:2480
PersistentKeepalive = 25
PresharedKey = 31aIhAPwktDGpH4JDhA8GNvjFXEf/a6+UaQRyOAiyfM=
Reserved = [209, 98, 59]
"""

AMNEZIA_WG_V31_CONF = """
[Interface]
PrivateKey = eCtXsJZ27+4PbhDkHnB923tkUn2Gj59wZw5wFA75MnU=
Address = 10.9.9.2/32
DNS = 1.1.1.1
MTU = 1280
Jc = 4
Jmin = 35
Jmax = 95
S1 = 32
S2 = 32
S3 = 32
S4 = 32
H1 = 148736594-370455131
H2 = 621025620-1240228083
H3 = 1504827942-1530367889
H4 = 1629521638-1833671031
HeaderProtectionKey = MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
ContentPaddingAddition = 0-32
RekeyAfterTime = 110-130
RekeyTimeout = 5
RejectAfterTime = 180
KeepaliveTimeout = 10
MaxHandshakeAttempts = 18
RandomTrailers = true
DisableCookies = yes

[Peer]
PublicKey = Cr8hWlKvtDt7nrvf+f0brNQQzabAqrjfBvas9pmowjo=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = awg.example.com:443
PersistentKeepalive = 25
"""

OPENVPN_AUTH_USER_PASS_CONF = """
client
dev tun
proto udp
remote vpn.example.com 1194
cipher AES-256-GCM
auth SHA256
tun-mtu 1500
auth-user-pass
dhcp-option DNS 1.1.1.1
dhcp-option DNS 8.8.8.8
<auth-user-pass>
user
secret
</auth-user-pass>
<ca>
-----BEGIN CERTIFICATE-----
MIIBexample
-----END CERTIFICATE-----
</ca>
<tls-crypt>
-----BEGIN OpenVPN Static key V1-----
00000000000000000000000000000000
-----END OpenVPN Static key V1-----
</tls-crypt>
"""

TAILSCALE_SETTINGS = """
hostname: xkeen
auth-key: tskey-auth-example
state-dir: ./tailscale
udp: true
accept-routes: true
exit-node: auto:any
exit-node-allow-lan-access: true
"""


def _parsed_proxy(yaml_text: str) -> dict:
    parsed = yaml.safe_load(yaml_text)
    assert isinstance(parsed, list)
    assert len(parsed) == 1
    return parsed[0]


def test_parse_wireguard_accepts_amnezia_wg_v2_options():
    result = parse_wireguard(AMNEZIA_WG_V2_CONF, custom_name="amnezia-v2")
    proxy = _parsed_proxy(result.yaml)
    amnezia = proxy["amnezia-wg-option"]

    assert proxy["name"] == "amnezia-v2"
    assert proxy["type"] == "wireguard"
    assert proxy["ip"] == "172.16.0.2"
    assert proxy["ipv6"] == "fd01:5ca1:ab1e:80fa:ab85:6eea:213f:f4a5"
    assert proxy["reserved"] == [209, 98, 59]
    assert proxy["allowed-ips"] == ["0.0.0.0/0", "::/0"]
    assert proxy["dns"] == ["1.1.1.1", "8.8.8.8"]
    assert proxy["remote-dns-resolve"] is True

    assert amnezia["jc"] == 5
    assert amnezia["jmin"] == 500
    assert amnezia["jmax"] == 501
    assert amnezia["s3"] == 50
    assert amnezia["s4"] == 5
    assert amnezia["h1"] == "123456-123500"
    assert amnezia["h4"] == "32345-32350"
    assert amnezia["i1"] == "<b 0xf6ab3267fa><c><b 0xf6ab><t><r 10><wt 10>"
    assert amnezia["i2"] == "<b 0xf6ab3267fa><r 100>"
    assert amnezia["i3"] == ""
    assert amnezia["i4"] == ""
    assert amnezia["i5"] == ""
    assert "j1" not in amnezia
    assert "j2" not in amnezia
    assert "j3" not in amnezia
    assert "itime" not in amnezia


def test_parse_wireguard_preserves_amnezia_wg_v3_and_v31_options():
    result = parse_wireguard(AMNEZIA_WG_V31_CONF, custom_name="amnezia-v31")
    proxy = _parsed_proxy(result.yaml)
    amnezia = proxy["amnezia-wg-option"]

    assert proxy["name"] == "amnezia-v31"
    assert proxy["server"] == "awg.example.com"
    assert proxy["port"] == 443
    assert amnezia["version"] == 3
    assert amnezia["header-protection-key"] == "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
    assert amnezia["content-padding-addition"] == "0-32"
    assert amnezia["rekey-after-time"] == "110-130"
    assert amnezia["rekey-timeout"] == 5
    assert amnezia["reject-after-time"] == 180
    assert amnezia["keepalive-timeout"] == 10
    assert amnezia["max-handshake-attempts"] == 18
    assert amnezia["random-trailers"] is True
    assert amnezia["disable-cookies"] is True


def test_parse_wireguard_rejects_invalid_amnezia_wg_v31_boolean():
    invalid = AMNEZIA_WG_V31_CONF.replace("RandomTrailers = true", "RandomTrailers = perhaps")

    with pytest.raises(ValueError, match="Invalid AmneziaWG boolean option"):
        parse_wireguard(invalid)


def test_mihomo_parse_wireguard_route_returns_amnezia_wg_v2_yaml(tmp_path):
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

    response = app.test_client().post(
        "/api/mihomo/parse/wireguard",
        json={"text": AMNEZIA_WG_V2_CONF, "name": "route-awg"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["proxy_name"] == "route-awg"
    proxy = _parsed_proxy(body["proxy_yaml"])
    assert proxy["amnezia-wg-option"]["h1"] == "123456-123500"
    assert proxy["amnezia-wg-option"]["i3"] == ""


def test_generator_wireguard_proxy_insert_preserves_amnezia_wg_v2_options():
    base_config = "\n".join(
        [
            "proxies: []",
            "proxy-groups:",
            "  - name: Auto",
            "    type: select",
            "    proxies: [DIRECT]",
            "",
        ]
    )
    state = {
        "defaultGroups": ["Auto"],
        "proxies": [
            {
                "kind": "wireguard",
                "name": "generator-awg",
                "config": AMNEZIA_WG_V2_CONF,
            }
        ],
    }

    result = insert_proxies_from_state(base_config, state)
    parsed = yaml.safe_load(result)

    proxy = parsed["proxies"][0]
    assert proxy["name"] == "generator-awg"
    assert proxy["amnezia-wg-option"]["s4"] == 5
    assert proxy["amnezia-wg-option"]["h4"] == "32345-32350"
    assert proxy["amnezia-wg-option"]["i5"] == ""
    assert "generator-awg" in parsed["proxy-groups"][0]["proxies"]


def test_generator_wireguard_proxy_insert_preserves_amnezia_wg_v31_options():
    base_config = "proxies: []\nproxy-groups: []\n"
    state = {
        "proxies": [
            {
                "kind": "wireguard",
                "name": "generator-awg-v31",
                "config": AMNEZIA_WG_V31_CONF,
            }
        ],
    }

    result = insert_proxies_from_state(base_config, state)
    proxy = yaml.safe_load(result)["proxies"][0]
    amnezia = proxy["amnezia-wg-option"]

    assert amnezia["version"] == 3
    assert amnezia["header-protection-key"].endswith("=")
    assert amnezia["random-trailers"] is True
    assert amnezia["disable-cookies"] is True


def test_parse_openvpn_accepts_auth_user_pass_and_aes256():
    result = parse_openvpn(OPENVPN_AUTH_USER_PASS_CONF, custom_name="ovpn-aes256")
    proxy = _parsed_proxy(result.yaml)

    assert proxy["name"] == "ovpn-aes256"
    assert proxy["type"] == "openvpn"
    assert proxy["server"] == "vpn.example.com"
    assert proxy["port"] == 1194
    assert proxy["proto"] == "udp"
    assert proxy["cipher"] == "AES-256-GCM"
    assert proxy["auth"] == "SHA256"
    assert proxy["username"] == "user"
    assert proxy["password"] == "secret"
    assert proxy["remote-dns-resolve"] is True
    assert proxy["dns"] == ["1.1.1.1", "8.8.8.8"]
    assert "BEGIN CERTIFICATE" in proxy["ca"]
    assert "OpenVPN Static key" in proxy["tls-crypt"]
    assert "cert" not in proxy
    assert "key" not in proxy


def test_parse_tailscale_accepts_key_value_settings_without_server_port():
    result = parse_tailscale(TAILSCALE_SETTINGS, custom_name="tailnet")
    proxy = _parsed_proxy(result.yaml)

    assert proxy["name"] == "tailnet"
    assert proxy["type"] == "tailscale"
    assert proxy["hostname"] == "xkeen"
    assert proxy["auth-key"] == "tskey-auth-example"
    assert proxy["state-dir"] == "./tailscale"
    assert proxy["udp"] is True
    assert proxy["accept-routes"] is True
    assert proxy["exit-node"] == "auto:any"
    assert proxy["exit-node-allow-lan-access"] is True
    assert "server" not in proxy
    assert "port" not in proxy


def test_mihomo_parse_openvpn_and_tailscale_routes_return_yaml(tmp_path):
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
    client = app.test_client()

    openvpn_response = client.post(
        "/api/mihomo/parse/openvpn",
        json={"text": OPENVPN_AUTH_USER_PASS_CONF, "name": "route-ovpn"},
    )
    assert openvpn_response.status_code == 200
    openvpn_proxy = _parsed_proxy(openvpn_response.get_json()["proxy_yaml"])
    assert openvpn_proxy["name"] == "route-ovpn"
    assert openvpn_proxy["type"] == "openvpn"
    assert openvpn_proxy["cipher"] == "AES-256-GCM"

    tailscale_response = client.post(
        "/api/mihomo/parse/tailscale",
        json={"text": TAILSCALE_SETTINGS, "name": "route-tail"},
    )
    assert tailscale_response.status_code == 200
    tailscale_proxy = _parsed_proxy(tailscale_response.get_json()["proxy_yaml"])
    assert tailscale_proxy["name"] == "route-tail"
    assert tailscale_proxy["type"] == "tailscale"
    assert "server" not in tailscale_proxy


def test_generator_openvpn_and_tailscale_proxy_insert_registers_groups():
    base_config = "\n".join(
        [
            "proxies: []",
            "proxy-groups:",
            "  - name: Auto",
            "    type: select",
            "    proxies: [DIRECT]",
            "",
        ]
    )
    state = {
        "defaultGroups": ["Auto"],
        "proxies": [
            {
                "kind": "openvpn",
                "name": "generator-ovpn",
                "config": OPENVPN_AUTH_USER_PASS_CONF,
            },
            {
                "kind": "tailscale",
                "name": "generator-tail",
                "config": TAILSCALE_SETTINGS,
            },
        ],
    }

    result = insert_proxies_from_state(base_config, state)
    parsed = yaml.safe_load(result)

    proxy_types = {proxy["name"]: proxy["type"] for proxy in parsed["proxies"]}
    assert proxy_types["generator-ovpn"] == "openvpn"
    assert proxy_types["generator-tail"] == "tailscale"
    assert "generator-ovpn" in parsed["proxy-groups"][0]["proxies"]
    assert "generator-tail" in parsed["proxy-groups"][0]["proxies"]
