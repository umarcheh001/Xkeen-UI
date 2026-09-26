import base64
import json
import zlib
from unittest.mock import patch

import pytest

from services.amnezia_premium import (
    AMNEZIA_PREMIUM_GATEWAY_URL,
    AmneziaPremiumImportError,
    _x25519,
    decode_connection_key,
    generate_wireguard_keypair,
    import_connection_key,
    list_available_locations,
)
from services.mihomo_proxy_parsers import parse_wireguard


def _encode_key(payload, *, signature=True):
    raw = zlib.compress(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    if signature:
        raw = b"\x00\x00\x00\xff" + raw
    return "vpn://" + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _connection_key():
    return _encode_key(
        {
            "name": "Amnezia Premium Finland",
            "config_version": 2,
            "api_config": {
                "service_type": "amnezia-premium",
                "service_protocol": "awg",
                "user_country_code": "FI",
            },
            "auth_data": {"api_key": "test-api-key"},
        }
    )


def _gateway_response():
    client_config = {
        "hostName": "fi-edge.example",
        "port": 51820,
        "client_ip": "10.8.0.2/32",
        "client_priv_key": "$WIREGUARD_CLIENT_PRIVATE_KEY",
        "server_pub_key": "server-public-key",
        "psk_key": "preshared-key",
        "client_id": "1, 2, 3",
        "allowed_ips": ["0.0.0.0/0", "::/0"],
        "persistent_keep_alive": "25",
        "Jc": "5",
        "S1": "15",
        "HeaderProtectionKey": "header-key",
        "RandomTrailers": "true",
    }
    server_config = {
        "containers": [{"awg": {"protocol_version": "3", "last_config": json.dumps(client_config)}}]
    }
    return {"config": _encode_key(server_config, signature=False)}


def test_decode_connection_key_reads_only_subscription_metadata():
    connection = decode_connection_key(_connection_key())

    assert connection.name == "Amnezia Premium Finland"
    assert connection.service_type == "amnezia-premium"
    assert connection.service_protocol == "awg"
    assert connection.user_country_code == "FI"
    assert connection.api_key == "test-api-key"


def test_import_connection_key_requests_gateway_and_returns_mihomo_compatible_awg_config():
    requests = []

    def gateway_post(payload):
        requests.append(payload)
        return _gateway_response()

    config = import_connection_key(_connection_key(), gateway_post=gateway_post)

    assert len(requests) == 1
    request = requests[0]
    assert request["service_type"] == "amnezia-premium"
    assert request["service_protocol"] == "awg"
    assert request["auth_data"] == {"api_key": "test-api-key"}
    assert request["public_key"] != request["auth_data"]["api_key"]
    assert "[Interface]" in config
    assert "PrivateKey = $WIREGUARD_CLIENT_PRIVATE_KEY" not in config
    assert "Endpoint = fi-edge.example:51820" in config
    assert "Version = 3" in config
    assert "HeaderProtectionKey = header-key" in config

    proxy = parse_wireguard(config)
    assert proxy.name == "Amnezia Premium Finland"
    assert "server: fi-edge.example" in proxy.yaml
    assert "version: 3" in proxy.yaml
    assert "header-protection-key: header-key" in proxy.yaml
    assert "random-trailers: true" in proxy.yaml


def test_import_rejects_unrecognized_or_unsupported_connection_keys():
    with pytest.raises(AmneziaPremiumImportError, match="Некорректный ключ"):
        decode_connection_key("vpn://not-a-valid-key")

    unsupported = _encode_key(
        {
            "api_config": {
                "service_type": "amnezia-premium",
                "service_protocol": "openvpn",
                "user_country_code": "FI",
            },
            "auth_data": {"api_key": "test-api-key"},
        }
    )
    with pytest.raises(AmneziaPremiumImportError, match="неподдерживаемый протокол"):
        import_connection_key(unsupported, gateway_post=lambda _payload: {})


def test_generated_wireguard_keypair_contains_two_distinct_32_byte_keys():
    private_key, public_key = generate_wireguard_keypair()

    assert len(base64.b64decode(private_key)) == 32
    assert len(base64.b64decode(public_key)) == 32
    assert private_key != public_key
    assert AMNEZIA_PREMIUM_GATEWAY_URL.startswith("https://")


def test_list_available_locations_uses_account_endpoint_without_issuing_configs():
    response = {
        "available_countries": [
            {
                "server_country_code": "FI",
                "server_country_name": "Finland",
                "available_protocols": ["awg"],
            },
            {
                "server_country_code": "DE",
                "server_country_name": "Germany",
                "available_protocols": ["awg"],
            },
            {
                "server_country_code": "US",
                "server_country_name": "United States",
                "available_protocols": ["vless"],
            },
        ]
    }
    with patch("services.amnezia_premium._post_to_gateway", return_value=response) as gateway:
        locations = list_available_locations(_connection_key())

    assert locations == [
        {"code": "FI", "name": "Finland"},
        {"code": "DE", "name": "Germany"},
    ]
    assert gateway.call_args.kwargs["endpoint"] == "account_info"
    assert "public_key" not in gateway.call_args.args[0]


def test_x25519_public_key_matches_rfc_7748_vector():
    private_key = bytes.fromhex(
        "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"
    )

    public_key = _x25519(private_key, b"\x09" + (b"\x00" * 31))

    assert public_key.hex() == "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"
