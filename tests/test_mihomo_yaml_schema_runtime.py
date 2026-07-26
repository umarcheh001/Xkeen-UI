from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _run_mihomo_yaml_schema(doc: str) -> dict[str, object]:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    script = f"""
import fs from 'node:fs';
import {{ validateYamlTextAgainstSchema }} from './xkeen-ui/static/js/ui/yaml_schema.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/mihomo-config.schema.json', 'utf8'));
const result = validateYamlTextAgainstSchema({json.dumps(doc)}, schema, {{ maxErrors: 12 }});
console.log(JSON.stringify({{
  ok: !!result.ok,
  parseOk: result.parseOk !== false,
  summary: result.summary || '',
  line: result.line ?? null,
  column: result.column ?? null,
  diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics.map((item) => ({{
    line: item.line,
    column: item.column,
    path: item.path || '',
    message: item.message,
  }})) : [],
}}));
"""

    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        cwd=str(ROOT),
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip())


def test_mihomo_yaml_schema_runtime_accepts_basic_valid_config():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "mode: rule",
            "dns:",
            "  enable: true",
            "rules:",
            "  - MATCH,DIRECT",
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_yaml_schema_runtime_accepts_sniffer_protocol_shorthand_with_empty_yaml_nodes():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "sniffer:",
            "  enable: true",
            "  sniff:",
            "    HTTP:",
            "    TLS:",
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_yaml_schema_runtime_accepts_xhttp_and_reuse_settings():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxies:",
            "  - name: xhttp-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    network: xhttp",
            "    tls: true",
            "    xhttp-opts:",
            "      path: /gateway",
            "      mode: auto",
            "      reuse-settings:",
            "        max-connections: 0",
            '        max-concurrency: "16-32"',
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_yaml_schema_runtime_accepts_documented_vless_tls_reality_fields():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxies:",
            "  - name: reality-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    flow: xtls-rprx-vision",
            '    encryption: ""',
            "    packet-encoding: xudp",
            "    network: tcp",
            "    udp: true",
            "    tls: true",
            "    servername: www.microsoft.com",
            "    alpn: [h2, http/1.1]",
            "    client-fingerprint: random",
            "    reality-opts:",
            "      public-key: z7ObaBEwG9lXYX2JPQsFNWIXcH25ywpLIf4_g9LqSX4",
            "      short-id: 2c7282bf6de028b8",
            "      support-x25519mlkem768: true",
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_yaml_schema_runtime_accepts_raw_transport_and_lowercase_ios_fingerprint():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxies:",
            "  - name: reality-raw",
            "    type: vless",
            "    server: 192.0.2.10",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    flow: xtls-rprx-vision",
            "    network: raw",
            "    tls: true",
            "    servername: example.com",
            "    client-fingerprint: ios",
            "    reality-opts:",
            "      public-key: z7ObaBEwG9lXYX2JPQsFNWIXcH25ywpLIf4_g9LqSX4",
            "      short-id: 2c7282bf6de028b8",
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_semantic_validation_accepts_http_alias_for_h2_opts():
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    script = """
import { validateMihomoConfigSemantics } from './xkeen-ui/static/js/ui/schema_semantic_validation.js';
const result = validateMihomoConfigSemantics({
  proxies: [{
    name: 'h2-node',
    type: 'vless',
    server: 'edge.example.com',
    port: 443,
    uuid: '11111111-1111-1111-1111-111111111111',
    network: 'http',
    tls: true,
    'h2-opts': { host: ['edge.example.com'], path: '/' }
  }]
});
console.log(JSON.stringify(result));
"""
    completed = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        cwd=str(ROOT),
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    diagnostics = json.loads(completed.stdout.strip())
    assert not any(item.get("code") == "proxy-network-h2-opts" for item in diagnostics)


def test_mihomo_yaml_schema_runtime_accepts_openvpn_auth_user_pass_proxy():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxies:",
            "  - name: openvpn",
            "    type: openvpn",
            "    server: vpn.example.com",
            "    port: 1194",
            "    proto: udp",
            "    cipher: AES-256-GCM",
            "    auth: SHA256",
            "    username: user",
            "    password: secret",
            "    ca: |",
            "      -----BEGIN CERTIFICATE-----",
            "      MIIBexample",
            "      -----END CERTIFICATE-----",
            "    tls-crypt: |",
            "      -----BEGIN OpenVPN Static key V1-----",
            "      00000000000000000000000000000000",
            "      -----END OpenVPN Static key V1-----",
            "    udp: true",
            "    remote-dns-resolve: true",
            "    dns: [1.1.1.1, 8.8.8.8]",
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_yaml_schema_runtime_accepts_tailscale_proxy_without_server_port():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxies:",
            "  - name: tailscale",
            "    type: tailscale",
            "    hostname: xkeen",
            "    state-dir: ./tailscale",
            "    udp: true",
            "    accept-routes: true",
            "    exit-node: auto:any",
            "    exit-node-allow-lan-access: true",
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_yaml_schema_runtime_accepts_documented_xhttp_extended_fields():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxies:",
            "  - name: xhttp-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    network: xhttp",
            "    tls: true",
            "    servername: edge.example.com",
            "    alpn: [h2]",
            '    encryption: ""',
            "    xhttp-opts:",
            "      path: /gateway",
            "      host: edge.example.com",
            "      mode: auto",
            "      x-padding-obfs-mode: true",
            "      x-padding-key: x_padding",
            "      x-padding-header: Referer",
            "      x-padding-placement: queryInHeader",
            "      x-padding-method: tokenish",
            "      uplink-http-method: PATCH",
            "      session-placement: path",
            "      session-key: sid",
            "      seq-placement: path",
            "      seq-key: seq",
            "      uplink-data-placement: header",
            "      uplink-data-key: x-up",
            "      uplink-chunk-size: 4096",
            "      sc-min-posts-interval-ms: 30",
            "      reuse-settings:",
            "        h-keep-alive-period: 0",
            "      download-settings:",
            "        server: dl.example.com",
            "        port: 443",
            "        tls: true",
            "        alpn: [h2]",
            "        reality-opts:",
            "          public-key: z7ObaBEwG9lXYX2JPQsFNWIXcH25ywpLIf4_g9LqSX4",
            "          short-id: 2c7282bf6de028b8",
            "          support-x25519mlkem768: true",
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_yaml_schema_runtime_accepts_grpc_multiplexing_fields():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxies:",
            "  - name: grpc-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    network: grpc",
            "    tls: true",
            "    grpc-opts:",
            "      grpc-service-name: api",
            "      max-connections: 2",
            "      min-streams: 4",
            "      max-streams: 16",
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_yaml_schema_runtime_accepts_grpc_without_opts_block():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxies:",
            "  - name: grpc-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    network: grpc",
            "    tls: true",
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_yaml_schema_runtime_reports_enum_and_type_errors_with_paths():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "mode: random",
            "dns:",
            '  enable: "yes"',
            "",
        ])
    )

    assert result["ok"] is False
    assert result["parseOk"] is True
    messages = [str(item["message"]) for item in result["diagnostics"]]
    assert any("mode" in message and "random" in message for message in messages)
    assert any("dns.enable" in message and "boolean" in message for message in messages)

    first = result["diagnostics"][0]
    assert first["line"] == 1
    assert first["path"] == "mode"


def test_mihomo_yaml_schema_runtime_reports_required_fields_for_proxy_groups():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxy-groups:",
            "  - proxies: [DIRECT]",
            "",
        ])
    )

    assert result["ok"] is False
    messages = [str(item["message"]) for item in result["diagnostics"]]
    assert any("`name`" in message for message in messages)
    assert any("`type`" in message for message in messages)
    assert all(item["path"] == "proxy-groups[0]" for item in result["diagnostics"][:2])
    assert result["diagnostics"][0]["line"] == 2


def test_mihomo_yaml_schema_runtime_still_requires_server_port_for_regular_proxy():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxies:",
            "  - name: vless-node",
            "    type: vless",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "",
        ])
    )

    assert result["ok"] is False
    messages = [str(item["message"]) for item in result["diagnostics"]]
    assert any("`server`" in message for message in messages)
    assert any("`port`" in message for message in messages)


def test_mihomo_yaml_schema_runtime_requires_provider_url_for_http_proxy_provider():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxy-providers:",
            "  sample:",
            "    type: http",
            "",
        ])
    )

    assert result["ok"] is False
    messages = [str(item["message"]) for item in result["diagnostics"]]
    assert any("`url`" in message for message in messages)
    assert any(str(item["path"]) == "proxy-providers.sample" for item in result["diagnostics"])


def test_mihomo_yaml_schema_runtime_accepts_hwid_proxy_provider_headers():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxy-providers:",
            "  premium:",
            "    type: http",
            "    url: https://sub.example.com/clash",
            "    interval: 3600",
            "    header:",
            "      x-hwid:",
            "      - F85E3CEE1A15",
            "      x-device-os:",
            "      - Keenetic OS",
            "      x-ver-os:",
            "      - 5.0.3",
            "      x-device-model:",
            "      - Z8102AX",
            "      User-Agent:",
            "      - mihomo/v26.2",
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_yaml_schema_runtime_requires_url_for_url_test_group():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxy-groups:",
            "  - name: Auto",
            "    type: url-test",
            "    proxies: [DIRECT]",
            "",
        ])
    )

    assert result["ok"] is False
    messages = [str(item["message"]) for item in result["diagnostics"]]
    assert any("`url`" in message for message in messages)
    assert any(str(item["path"]) == "proxy-groups[0]" for item in result["diagnostics"])


def test_mihomo_yaml_schema_runtime_requires_matching_network_for_ws_opts():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxies:",
            "  - name: ws-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    ws-opts:",
            "      path: /",
            "",
        ])
    )

    assert result["ok"] is False
    messages = [str(item["message"]) for item in result["diagnostics"]]
    assert any("`network`" in message for message in messages)
    assert any(str(item["path"]) == "proxies[0]" for item in result["diagnostics"])


def test_mihomo_yaml_schema_runtime_requires_reality_companion_fields():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "proxies:",
            "  - name: reality-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    tls: true",
            "    reality-opts:",
            "      public-key: abcdefghijklmnop",
            "",
        ])
    )

    assert result["ok"] is False
    messages = [str(item["message"]) for item in result["diagnostics"]]
    assert any("`client-fingerprint`" in message for message in messages)
    assert any("`servername`" in message for message in messages)
    assert any(str(item["path"]) == "proxies[0]" for item in result["diagnostics"])


def test_mihomo_yaml_schema_runtime_accepts_http_rule_provider_without_path():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "anchors:",
            "  a1: &domain { type: http, format: mrs, behavior: domain, interval: 86400 }",
            "proxy-groups:",
            "  - name: GitHub",
            "    type: select",
            "    proxies: [DIRECT]",
            "rule-providers:",
            "  github@domain: { <<: *domain, url: https://example.invalid/github.mrs }",
            "rules:",
            "  - RULE-SET,github@domain,GitHub",
            "  - MATCH,DIRECT",
            "",
        ])
    )

    assert result["ok"] is True
    assert result["parseOk"] is True
    assert result["diagnostics"] == []


def test_mihomo_yaml_schema_runtime_reports_yaml_parser_location():
    result = _run_mihomo_yaml_schema(
        "\n".join([
            "dns: [1,",
            "",
        ])
    )

    assert result["ok"] is False
    assert result["parseOk"] is False
    assert result["line"] == 2
    assert result["column"] == 1
    assert "flow collection" in str(result["summary"])
