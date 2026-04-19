from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

import pytest

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
    assert "max-connections: 0" in result.yaml
    assert "c-max-reuse-times: 0" in result.yaml
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
    assert "X-Download: 1" in result.yaml
    assert "no-grpc-header: false" in result.yaml
    assert "x-padding-bytes: 10-20" in result.yaml
    assert "sc-max-each-post-bytes: 131072" in result.yaml
    assert "max-connections: 2" in result.yaml
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


def test_non_vless_xhttp_is_still_rejected_for_mihomo():
    link = "trojan://secret@example.com:443?type=xhttp&sni=edge.example.com"

    with pytest.raises(ValueError, match="only for VLESS"):
        parse_trojan(link)


def test_frontend_mihomo_import_has_xhttp_generation_path():
    src = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")

    assert "const cleanDownloadSettings = (download) => {" in src
    assert "const normalizeXhttpSettings = (params) => {" in src
    assert "output.xhttpSettings = normalizeXhttpSettings(params);" in src
    assert "common['xhttp-opts']" in src
    assert "xhttp['download-settings'] = downloadSettings;" in src
    assert "'download-settings': streamSettings.xhttpSettings?.['download-settings']" in src
    assert "Keep xhttp synchronous in the shared parser API used by import and proxy tools." in src
