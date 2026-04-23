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
            "      mode: stream-up",
            "      reuse-settings:",
            "        max-connections: 0",
            '        max-concurrency: "16-32"',
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
