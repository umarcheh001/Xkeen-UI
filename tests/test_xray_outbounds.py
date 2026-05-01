from __future__ import annotations

from urllib.parse import parse_qs, urlparse


def test_build_outbounds_config_from_vless_uses_compact_settings_format():
    from services import xray_outbounds as outbounds

    cfg = outbounds.build_outbounds_config_from_vless(
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        "?type=tcp&security=reality&pbk=pubkey&sni=edge.example.com&sid=abcd"
        "&encryption=none&flow=xtls-rprx-vision#demo"
    )

    proxy = cfg["outbounds"][0]
    assert proxy["protocol"] == "vless"
    assert proxy["settings"]["address"] == "example.com"
    assert proxy["settings"]["port"] == 443
    assert proxy["settings"]["id"] == "11111111-1111-1111-1111-111111111111"
    assert proxy["settings"]["encryption"] == "none"
    assert proxy["settings"]["flow"] == "xtls-rprx-vision"
    assert "vnext" not in proxy["settings"]


def test_build_vless_url_from_config_accepts_compact_settings_format():
    from services import xray_outbounds as outbounds

    cfg = {
        "outbounds": [
            {
                "tag": "proxy",
                "protocol": "vless",
                "settings": {
                    "address": "example.com",
                    "port": 443,
                    "id": "11111111-1111-1111-1111-111111111111",
                    "encryption": "none",
                    "flow": "xtls-rprx-vision",
                    "level": 0,
                },
                "streamSettings": {
                    "network": "tcp",
                    "security": "reality",
                    "realitySettings": {
                        "publicKey": "pubkey",
                        "fingerprint": "chrome",
                        "serverName": "edge.example.com",
                        "shortId": "abcd",
                        "spiderX": "/",
                    },
                },
            }
        ]
    }

    url = outbounds.build_vless_url_from_config(cfg)
    parsed = urlparse(url or "")
    qs = parse_qs(parsed.query)

    assert parsed.scheme == "vless"
    assert parsed.username == "11111111-1111-1111-1111-111111111111"
    assert parsed.hostname == "example.com"
    assert parsed.port == 443
    assert qs["encryption"] == ["none"]
    assert qs["flow"] == ["xtls-rprx-vision"]
    assert qs["security"] == ["reality"]
    assert qs["sni"] == ["edge.example.com"]
    assert qs["pbk"] == ["pubkey"]
    assert qs["sid"] == ["abcd"]


def test_build_vless_url_from_config_keeps_legacy_vnext_compatibility():
    from services import xray_outbounds as outbounds

    cfg = {
        "outbounds": [
            {
                "tag": "proxy",
                "protocol": "vless",
                "settings": {
                    "vnext": [
                        {
                            "address": "legacy.example.com",
                            "port": 443,
                            "users": [
                                {
                                    "id": "22222222-2222-2222-2222-222222222222",
                                    "encryption": "none",
                                }
                            ],
                        }
                    ]
                },
                "streamSettings": {
                    "network": "ws",
                    "security": "tls",
                    "tlsSettings": {
                        "serverName": "legacy.example.com",
                    },
                    "wsSettings": {
                        "path": "/ws",
                        "headers": {"Host": "cdn.example.com"},
                    },
                },
            }
        ]
    }

    url = outbounds.build_vless_url_from_config(cfg)
    parsed = urlparse(url or "")
    qs = parse_qs(parsed.query)

    assert parsed.scheme == "vless"
    assert parsed.username == "22222222-2222-2222-2222-222222222222"
    assert parsed.hostname == "legacy.example.com"
    assert parsed.port == 443
    assert qs["security"] == ["tls"]
    assert qs["host"] == ["cdn.example.com"]
    assert qs["path"] == ["/ws"]
