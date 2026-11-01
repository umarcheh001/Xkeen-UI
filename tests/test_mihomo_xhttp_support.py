from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

import pytest
import yaml

from services.mihomo_proxy_parsers import parse_trojan, parse_vless


ROOT = Path(__file__).resolve().parents[1]


def test_parse_vless_supports_xhttp_transport_for_mihomo():
    link = (
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        "?type=xhttp&security=tls&sni=edge.example.com"
        "&host=cdn.example.com&path=%2Fgateway&mode=stream-up#xhttp-node"
    )

    result = parse_vless(link)

    assert result.name == "xhttp-node"
    assert "network: xhttp" in result.yaml
    assert "xhttp-opts:" in result.yaml
    assert "path: /gateway" in result.yaml
    assert "host: cdn.example.com" in result.yaml
    assert "mode: stream-up" in result.yaml
    assert "servername: edge.example.com" in result.yaml
    assert "tfo" not in yaml.safe_load(result.yaml)[0]


def test_vless_uri_xhttp_keeps_packet_placement_and_explicit_false_values():
    extra = quote(json.dumps({
        "sessionIDKey": "auth", "sessionIDPlacement": "query", "seqKey": "offset", "seqPlacement": "query",
        "uplinkHTTPMethod": "GET", "uplinkDataPlacement": "body", "xPaddingBytes": "0-0",
        "noGRPCHeader": False, "xPaddingObfsMode": False, "xmux": {"maxConnections": 1, "hKeepAlivePeriod": 30},
    }))
    result = parse_vless(
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        f"?type=xhttp&security=reality&sni=edge.example.com&mode=packet-up&extra={extra}"
    )
    opts = yaml.safe_load(result.yaml)[0]["xhttp-opts"]
    assert opts["session-key"] == "auth"
    assert opts["session-placement"] == "query"
    assert opts["seq-key"] == "offset"
    assert opts["uplink-http-method"] == "GET"
    assert opts["x-padding-bytes"] == "100-1000"
    assert opts["no-grpc-header"] is False
    assert opts["x-padding-obfs-mode"] is False
    assert opts["reuse-settings"] == {"max-connections": 1, "h-keep-alive-period": 30}


@pytest.mark.parametrize("value", [0, "0", "0-0"])
@pytest.mark.parametrize("key", ["xPaddingBytes", "x-padding-bytes"])
def test_xhttp_padding_translates_xray_zero_default_but_keeps_native_mihomo_zero(key, value):
    extra = quote(json.dumps({key: value}))
    result = parse_vless(
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        f"?type=xhttp&security=tls&extra={extra}"
    )
    actual = yaml.safe_load(result.yaml)[0]["xhttp-opts"]["x-padding-bytes"]
    assert actual == ("100-1000" if key == "xPaddingBytes" else value)


def test_parse_vless_normalizes_vision_udp443_flow_for_mihomo_schema():
    link = (
        "vless://f3131569-259f-4c4e-8fd9-67daf2212223@umarwelder.xyz:443"
        "?type=tcp&encryption=none&security=reality"
        "&pbk=jh-iF7JCrGyiGair7VCnOzFBba6VBlT_a0-jtMXBjyE"
        "&fp=chrome&sni=bahn.de&sid=ff5f69637fd16f&spx=%2F"
        "&flow=xtls-rprx-vision-udp443#senko-umar"
    )

    result = parse_vless(link)

    assert result.name == "senko-umar"
    assert "flow: xtls-rprx-vision\n" in result.yaml
    assert "xtls-rprx-vision-udp443" not in result.yaml
    assert "packet-encoding: xudp" in result.yaml
    assert "support-x25519mlkem768" not in result.yaml


def test_parse_vless_only_emits_mlkem_support_when_link_explicitly_requests_it():
    link = (
        "vless://f3131569-259f-4c4e-8fd9-67daf2212223@example.com:443"
        "?type=tcp&encryption=none&security=reality"
        "&pbk=pubkey&fp=chrome&sni=www.example.com&sid=46ab9f"
        "&support-x25519mlkem768=true#pq-node"
    )

    result = parse_vless(link)
    parsed = yaml.safe_load(result.yaml)[0]

    assert parsed["reality-opts"]["support-x25519mlkem768"] is True


@pytest.mark.parametrize("sid_key", ["sid", "shortId", "short-id", "short_id", "shortid"])
def test_parse_vless_quotes_numeric_short_id_and_accepts_aliases(sid_key):
    link = (
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        f"?type=tcp&security=reality&pbk=pubkey&{sid_key}=46&sni=www.yandex.ru"
        "&encryption=none#numeric-short-id"
    )

    result = parse_vless(link)
    parsed = yaml.safe_load(result.yaml)[0]

    assert "short-id: '46'" in result.yaml
    assert parsed["reality-opts"]["short-id"] == "46"
    assert isinstance(parsed["reality-opts"]["short-id"], str)


def test_parse_vless_preserves_alphanumeric_short_id_alias():
    link = (
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        "?type=tcp&security=reality&publicKey=pubkey&shortId=46ab9f&sni=www.yandex.ru"
        "&encryption=none#alpha-short-id"
    )

    result = parse_vless(link)
    parsed = yaml.safe_load(result.yaml)[0]

    assert parsed["reality-opts"]["public-key"] == "pubkey"
    assert parsed["reality-opts"]["short-id"] == "46ab9f"


def test_parse_vless_xhttp_preserves_reuse_settings_and_extra_opts():
    extra = quote(
        json.dumps(
            {
                "headers": {"X-Forwarded-For": "1.1.1.1"},
                "noGrpcHeader": True,
                "xPaddingBytes": "100-1000",
                "scMaxEachPostBytes": 1000000,
                "reuseSettings": {
                    "maxConcurrency": "16-32",
                    "maxConnections": "0",
                    "cMaxReuseTimes": "0",
                    "hMaxRequestTimes": "600-900",
                    "hMaxReusableSecs": "1800-3000",
                },
            },
            ensure_ascii=False,
        )
    )
    link = (
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        f"?type=xhttp&security=reality&sni=edge.example.com&path=%2F&extra={extra}"
    )

    result = parse_vless(link)

    assert "xhttp-opts:" in result.yaml
    assert "headers:" in result.yaml
    assert "X-Forwarded-For: 1.1.1.1" in result.yaml
    assert "no-grpc-header: true" in result.yaml
    assert "x-padding-bytes: 100-1000" in result.yaml
    assert "sc-max-each-post-bytes: 1000000" in result.yaml
    assert "reuse-settings:" in result.yaml
    assert "max-concurrency: 16-32" in result.yaml
    # Numeric-looking strings are quoted to preserve string type in YAML.
    assert "max-connections: '0'" in result.yaml
    assert "c-max-reuse-times: '0'" in result.yaml
    assert "h-max-request-times: 600-900" in result.yaml
    assert "h-max-reusable-secs: 1800-3000" in result.yaml


def test_parse_vless_xhttp_preserves_download_settings_overrides():
    extra = quote(
        json.dumps(
            {
                "downloadSettings": {
                    "path": "/download",
                    "host": "download.example.com",
                    "headers": {"X-Download": "1"},
                    "noGrpcHeader": False,
                    "xPaddingBytes": "10-20",
                    "scMaxEachPostBytes": 131072,
                    "reuseSettings": {"maxConnections": "2"},
                    "server": "download-edge.example.com",
                    "port": 8443,
                    "tls": False,
                    "alpn": ["h2", "http/1.1"],
                    "skipCertVerify": False,
                    "fingerprint": "firefox",
                    "certificate": ["cert-a", "cert-b"],
                    "privateKey": "key-123",
                    "servername": "download-sni.example.com",
                    "clientFingerprint": "safari",
                    "realityOpts": {"public-key": "download-pbk", "short-id": "ab"},
                }
            },
            ensure_ascii=False,
        )
    )
    link = (
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        f"?type=xhttp&security=tls&sni=edge.example.com&path=%2Fup&extra={extra}"
    )

    result = parse_vless(link)

    assert "download-settings:" in result.yaml
    assert "path: /download" in result.yaml
    assert "host: download.example.com" in result.yaml
    # Numeric-looking string header values are quoted to preserve string type.
    assert "X-Download: '1'" in result.yaml
    assert "no-grpc-header: false" in result.yaml
    assert "x-padding-bytes: 10-20" in result.yaml
    assert "sc-max-each-post-bytes: 131072" in result.yaml
    assert "max-connections: '2'" in result.yaml
    assert "server: download-edge.example.com" in result.yaml
    assert "port: 8443" in result.yaml
    assert "tls: false" in result.yaml
    assert "http/1.1" in result.yaml
    assert "skip-cert-verify: false" in result.yaml
    assert "fingerprint: firefox" in result.yaml
    assert "certificate:" in result.yaml
    assert "private-key: key-123" in result.yaml
    assert "servername: download-sni.example.com" in result.yaml
    assert "client-fingerprint: safari" in result.yaml
    assert "public-key: download-pbk" in result.yaml


def test_parse_vless_grpc_without_service_name_omits_empty_grpc_opts():
    link = (
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        "?type=grpc&security=tls&sni=edge.example.com#grpc-node"
    )

    result = parse_vless(link)

    assert "network: grpc" in result.yaml
    assert "grpc-opts:" not in result.yaml


def test_non_vless_xhttp_is_still_rejected_for_mihomo():
    link = "trojan://secret@example.com:443?type=xhttp&sni=edge.example.com"

    with pytest.raises(ValueError, match="only for VLESS"):
        parse_trojan(link)


def test_frontend_mihomo_import_has_xhttp_generation_path():
    src = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")

    assert "const cleanDownloadSettings = (download) => {" in src
    assert "const normalizeXhttpSettings = (params) => normalizeXhttpOptions({" in src
    assert "output.xhttpSettings = normalizeXhttpSettings(params);" in src
    assert "common['xhttp-opts']" in src
    assert "xhttp['download-settings'] = downloadSettings;" in src
    assert "normalizeXhttpOptions(streamSettings.xhttpSettings)" in src
    assert "Keep xhttp synchronous in the shared parser API used by import and proxy tools." in src


def test_frontend_xray_json_bulk_preview_keeps_blank_lines_between_proxies():
    generator_src = (ROOT / "xkeen-ui/static/js/features/mihomo_generator.js").read_text(encoding="utf-8")
    import_src = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")

    assert '.join("\\n\\n")' in generator_src
    assert "group.join('\\n\\n')" in import_src


def test_frontend_mihomo_import_skips_empty_grpc_opts_objects():
    src = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")

    assert "const nested = toYaml(value, indent + 2);" in src
    assert "if (grpcServiceName) common['grpc-opts']" in src


def test_frontend_mihomo_import_keeps_reality_short_id_as_yaml_string():
    src = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")

    assert "const YAML_STRING_VALUE_KEYS = new Set(['short-id']);" in src
    assert "Number.isFinite(Number(s))" in src
    assert "'short-id': shortId == null ? undefined : String(shortId)" in src


def test_frontend_mihomo_import_normalizes_vision_flow_suffixes():
    src = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")

    assert "const normalizeMihomoVlessFlow = (value) => {" in src
    assert "flow.startsWith('xtls-rprx-vision-')" in src
    assert "flow: normalizeMihomoVlessFlow(params.flow)" in src
    assert "flow: normalizeMihomoVlessFlow(settings.flow)" in src


def test_frontend_mihomo_import_reads_reality_short_id_aliases():
    src = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")

    assert "const realityParam = (params, ...keys) => {" in src
    assert "realityParam(params, 'sid', 'shortId', 'short-id', 'short_id', 'shortid')" in src
    assert "realityParam(params, 'pbk', 'publicKey', 'public-key', 'public_key')" in src


def test_frontend_mihomo_import_does_not_force_mlkem_reality_support():
    src = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")

    assert "supportX25519MLKEM768: boolMaybe(" in src
    assert "'support-x25519mlkem768': supportX25519MLKEM768 === true ? true : undefined" in src
    assert "'support-x25519mlkem768': true," not in src


def test_frontend_mihomo_import_preserves_reality_spider_x():
    src = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")

    assert "spiderX: string(params.spx)" in src
    assert "'spider-x': reality.spiderX == null ? undefined : String(reality.spiderX)" in src
