from __future__ import annotations

import json
import urllib.error

import yaml

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


def test_hwid_device_info_uses_stored_generated_fallback_when_mac_missing(monkeypatch, tmp_path):
    monkeypatch.delenv("XKEEN_MIHOMO_HWID", raising=False)
    monkeypatch.delenv("XKEEN_HWID", raising=False)
    monkeypatch.setattr(hwid, "_pick_mac_address_keenetic", lambda: None)
    monkeypatch.setattr(hwid, "_hwid_from_machine_id", lambda: (None, None))
    monkeypatch.setattr(hwid, "_ui_state_dir", lambda: str(tmp_path))
    monkeypatch.setattr(hwid.os, "urandom", lambda n: b"\x10\xdd\xb1\xc0\xba\xdf")
    monkeypatch.setattr(hwid, "_ndmc_show_version", lambda: "")
    monkeypatch.setattr(hwid, "_detect_mihomo_version", lambda: "v1.19.25")

    info = hwid.get_device_info()

    assert info["hwid"] == "12DDB1C0BADF"
    assert info["hwid_source"] == "generated_state"
    assert info["headers"]["x-hwid"] == "12DDB1C0BADF"
    assert info["mihomo_version"] == "1.19.25"
    assert info["headers"]["User-Agent"] == "ClashMeta/1.19.25; mihomo/1.19.25"
    assert "Обычно этого достаточно" in info["hwid_warning"]
    assert "не новый random при каждом клике" in info["hwid_warning"]
    assert "DevTools → ENV" in info["hwid_warning"]
    assert "XKEEN_MIHOMO_HWID" in info["hwid_warning"]
    assert (tmp_path / "mihomo-hwid.txt").read_text(encoding="utf-8").strip() == "12DDB1C0BADF"

    monkeypatch.setattr(hwid.os, "urandom", lambda n: b"\xaa\xbb\xcc\xdd\xee\xff")
    info2 = hwid.get_device_info()
    assert info2["hwid"] == "12DDB1C0BADF"


def test_hwid_device_info_accepts_string_env_override(monkeypatch):
    monkeypatch.setenv("XKEEN_MIHOMO_HWID", "4194304")
    monkeypatch.setattr(hwid, "_pick_mac_address_keenetic", lambda: "aa:bb:cc:dd:ee:ff")
    monkeypatch.setattr(hwid, "_ndmc_show_version", lambda: "")
    monkeypatch.setattr(hwid, "_detect_mihomo_version", lambda: "v1.19.25")

    info = hwid.get_device_info()

    assert info["hwid"] == "4194304"
    assert info["hwid_source"] == "XKEEN_MIHOMO_HWID"
    assert info["headers"]["x-hwid"] == "4194304"


def test_hwid_env_override_normalizes_mac_like_values_but_rejects_invalid_headers():
    assert hwid._normalize_env_hwid_override("aa:bb:cc:dd:ee:ff") == "AABBCCDDEEFF"
    assert hwid._normalize_env_hwid_override("remna-hwid-4194304") == "remna-hwid-4194304"
    assert hwid._normalize_env_hwid_override("bad\r\nx-test: 1") == ""


def test_hwid_provider_entry_uses_mihomo_provider_defaults():
    entry = hwid.build_provider_entry(
        "OverSecure_VPN_4G",
        "https://oversub.cloud/eCNMgAGfH_ayLPH0",
        {
            "x-hwid": "6488FA3B0CF4",
            "x-device-os": "Keenetic OS",
            "x-ver-os": "4.2.6",
            "x-device-model": "Keenetic",
            "User-Agent": "ClashMeta/1.19.25; mihomo/1.19.25",
        },
    )

    assert "  OverSecure_VPN_4G:" in entry
    assert "    interval: 43200" in entry
    assert "      interval: 300" in entry
    assert "      expected-status: 204" in entry
    assert "      User-Agent:" in entry
    assert '      - "ClashMeta/1.19.25; mihomo/1.19.25"' in entry
    assert "      x-hwid:" in entry
    assert '      - "6488FA3B0CF4"' in entry
    assert "      x-device-os:" not in entry
    assert "    override:" in entry
    assert "      udp: true" in entry
    assert "      tfo: true" in entry


def test_hwid_provider_payload_extracts_proxies_from_full_mihomo_config():
    payload, meta = hwid.provider_payload_from_subscription_text(
        """
mixed-port: 7890
dns:
  enable: true
proxies:
  - name: node-1
    type: vless
    server: example.com
    port: 443
proxy-groups:
  - name: auto
    type: select
    proxies: [node-1]
"""
    )

    assert meta["converted"] is True
    assert payload.startswith("proxies:\n")
    assert "  - name: node-1" in payload
    assert "mixed-port:" not in payload
    assert "proxy-groups:" not in payload


def test_hwid_provider_payload_converts_xray_json_with_hysteria2_to_provider_yaml():
    payload, meta = hwid.provider_payload_from_subscription_text(
        json.dumps(
            [
                {
                    "remarks": "Hy2",
                    "outbounds": [
                        {
                            "tag": "proxy",
                            "protocol": "hysteria",
                            "settings": {
                                "address": "hy.example.com",
                                "port": 443,
                                "version": 2,
                            },
                            "streamSettings": {
                                "network": "hysteria",
                                "hysteriaSettings": {"version": 2, "auth": "hy-secret"},
                                "security": "tls",
                                "tlsSettings": {
                                    "serverName": "hy.example.com",
                                    "alpn": ["h3"],
                                },
                                "finalmask": {
                                    "udp": [
                                        {
                                            "type": "salamander",
                                            "settings": {"password": "obfs-secret"},
                                        }
                                    ],
                                    "quicParams": {
                                        "brutalUp": "100 mbps",
                                        "brutalDown": "100 mbps",
                                    },
                                },
                            },
                        }
                    ],
                }
            ]
        )
    )

    assert meta["format"] == "xray-json"
    assert meta["converted"] is True
    assert meta["proxy_section"] is True
    assert meta["proxy_count"] == 1
    parsed = yaml.safe_load(payload)
    proxy = parsed["proxies"][0]
    assert proxy["name"] == "Hy2"
    assert proxy["type"] == "hysteria2"
    assert proxy["password"] == "hy-secret"
    assert proxy["obfs"] == "salamander"
    assert proxy["obfs-password"] == "obfs-secret"


def test_hwid_fetch_provider_payload_prefers_happ_json_when_it_has_more_nodes(monkeypatch):
    calls = []

    def fake_fetch(url, *, headers, insecure, timeout, policy, max_bytes):
        calls.append(dict(headers or {}))
        ua = str((headers or {}).get("User-Agent") or "")
        if ua == "Happ/1.0":
            return (
                json.dumps(
                    [
                        {
                            "remarks": "Hy2",
                            "outbounds": [
                                {
                                    "tag": "proxy",
                                    "protocol": "hysteria",
                                    "settings": {
                                        "address": "hy.example.com",
                                        "port": 443,
                                        "version": 2,
                                    },
                                    "streamSettings": {
                                        "network": "hysteria",
                                        "hysteriaSettings": {"version": 2, "auth": "hy-secret"},
                                        "security": "tls",
                                        "tlsSettings": {"serverName": "hy.example.com"},
                                    },
                                }
                            ],
                        },
                        {
                            "remarks": "Vless",
                            "outbounds": [
                                {
                                    "tag": "proxy",
                                    "protocol": "vless",
                                    "settings": {
                                        "vnext": [
                                            {
                                                "address": "vless.example.com",
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
                                        "security": "tls",
                                        "tlsSettings": {"serverName": "vless.example.com"},
                                    },
                                }
                            ],
                        },
                    ]
                ),
                {"content_type": "application/json", "bytes": 200, "hwid_response_headers": {}},
            )
        return (
            "proxies:\n  - name: Only\n    type: vless\n    server: only.example.com\n    port: 443\n",
            {"content_type": "text/yaml", "bytes": 80, "hwid_response_headers": {}},
        )

    monkeypatch.setattr(hwid, "_fetch_provider_subscription_text", fake_fetch)

    payload, meta = hwid.fetch_provider_payload(
        "https://provider.example/sub",
        headers={
            "x-hwid": "AABBCCDDEEFF",
            "User-Agent": "ClashMeta/1.19.24; mihomo/1.19.24",
        },
    )

    assert len(calls) == 2
    assert calls[0]["User-Agent"].startswith("ClashMeta/")
    assert calls[1]["User-Agent"] == "Happ/1.0"
    assert meta["happ_fallback_used"] is True
    assert meta["happ_fallback_original_count"] == 1
    parsed = yaml.safe_load(payload)
    assert [proxy["type"] for proxy in parsed["proxies"]] == ["hysteria2", "vless"]


def test_hwid_provider_entry_can_use_local_adapter_url_without_headers():
    entry = hwid.build_provider_entry(
        "Whitenet_VPN",
        "https://sub.example/full-config",
        {},
        provider_url="http://127.0.0.1:8088/mihomo/hwid/provider.yaml?url=https%3A%2F%2Fsub.example%2Ffull-config",
    )

    assert '    url: "http://127.0.0.1:8088/mihomo/hwid/provider.yaml?' in entry
    assert "    header:" not in entry


def test_hwid_user_agent_strips_v_prefix_and_uses_clashmeta_compatibility():
    assert (
        hwid._mihomo_hwid_user_agent("v1.19.25")
        == "ClashMeta/1.19.25; mihomo/1.19.25"
    )
    assert (
        hwid._mihomo_hwid_user_agent("mihomo v1.20.0 linux arm64")
        == "ClashMeta/1.20.0; mihomo/1.20.0"
    )


def test_hwid_user_agent_uses_stable_fallback_when_version_missing():
    assert hwid._mihomo_hwid_user_agent(None) == "ClashMeta/1.19.24; mihomo/1.19.24"


def test_hwid_probe_reports_tls_handshake_timeout(monkeypatch):
    def fake_probe_once(url, *, method, headers, insecure, timeout, policy):
        raise urllib.error.URLError("_ssl.c:999: The handshake operation timed out")

    monkeypatch.setattr(hwid, "_probe_once", fake_probe_once)

    result = hwid.probe_subscription(
        "https://provider.example/sub",
        headers={"x-hwid": "AABBCCDDEEFF"},
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "TLS_HANDSHAKE_TIMEOUT"
    assert result["error"]["message"] == "TLS handshake с сервером подписки не завершился вовремя."
    assert "VPN/exit-IP" in result["error"]["hint"]
    assert "_ssl.c:999" in result["error"]["detail"]


def test_hwid_probe_exposes_provider_hwid_headers_on_http_error(monkeypatch):
    def fake_probe_once(url, *, method, headers, insecure, timeout, policy):
        raise urllib.error.HTTPError(
            url,
            404,
            "Not Found",
            {
                "profile-title": "Premium",
                "x-hwid-active": "true",
                "x-hwid-max-devices-reached": "true",
            },
            None,
        )

    monkeypatch.setattr(hwid, "_probe_once", fake_probe_once)

    result = hwid.probe_subscription(
        "https://provider.example/sub",
        headers={"x-hwid": "4194304"},
    )

    assert result["ok"] is False
    assert result["profile"]["profile_title"] == "Premium"
    assert result["hwid_response_headers"]["x-hwid-active"] == "true"
    assert result["hwid_response_headers"]["x-hwid-max-devices-reached"] == "true"
    assert any(w["code"] == "HWID_MAX_DEVICES_REACHED" for w in result["warnings"])
