from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCHEMAS_DIR = Path(__file__).resolve().parents[1] / "xkeen-ui" / "static" / "schemas"


def _load(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _run_node_json(script: str) -> object:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        cwd=str(ROOT),
        text=True,
        encoding="utf-8",
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip())


REQUIRED_KEYS = ("x-ui-explain", "x-ui-use-case", "x-ui-example", "x-ui-warning")


def _assert_beginner_meta(node: dict, label: str) -> None:
    missing = [k for k in REQUIRED_KEYS if not isinstance(node.get(k), str) or not node[k].strip()]
    assert not missing, f"{label}: missing/empty x-ui-* keys: {missing}"


# ---------- Mihomo ----------


@pytest.mark.parametrize(
    "key",
    [
        "mixed-port",
        "redir-port",
        "tproxy-port",
        "allow-lan",
        "proxies",
        "proxy-providers",
        "proxy-groups",
        "rule-providers",
        "rules",
        "tun",
        "sniffer",
    ],
)
def test_mihomo_top_level_field_has_beginner_metadata(key):
    schema = _load(SCHEMAS_DIR / "mihomo-config.schema.json")
    props = schema.get("properties") or {}
    assert key in props, f"mihomo schema missing top-level property `{key}`"
    _assert_beginner_meta(props[key], f"mihomo.{key}")


# ---------- Xray routing ----------


@pytest.mark.parametrize(
    "definition",
    [
        "routingRule",
        "balancer",
        "observatory",
        "inbound",
        "outbound",
        "streamSettings",
    ],
)
def test_xray_routing_definition_has_beginner_metadata(definition):
    schema = _load(SCHEMAS_DIR / "xray-routing.schema.json")
    defs = schema.get("definitions") or {}
    assert definition in defs, f"xray-routing schema missing definition `{definition}`"
    _assert_beginner_meta(defs[definition], f"xray-routing.{definition}")


# ---------- Auxiliary inbounds/outbounds schemas keep parity ----------


@pytest.mark.parametrize(
    "schema_name,definition",
    [
        ("xray-inbounds.schema.json", "inbound"),
        ("xray-inbounds.schema.json", "outbound"),
        ("xray-inbounds.schema.json", "streamSettings"),
        ("xray-outbounds.schema.json", "inbound"),
        ("xray-outbounds.schema.json", "outbound"),
        ("xray-outbounds.schema.json", "streamSettings"),
    ],
)
def test_xray_aux_schema_definition_has_beginner_metadata(schema_name, definition):
    schema = _load(SCHEMAS_DIR / schema_name)
    defs = schema.get("definitions") or {}
    assert definition in defs, f"{schema_name} missing definition `{definition}`"
    _assert_beginner_meta(defs[definition], f"{schema_name}#{definition}")


@pytest.mark.parametrize("key", ["dns", "observatory"])
def test_xray_config_top_level_field_has_beginner_metadata(key):
    schema = _load(SCHEMAS_DIR / "xray-config.schema.json")
    props = schema.get("properties") or {}
    assert key in props, f"xray-config schema missing top-level property `{key}`"
    _assert_beginner_meta(props[key], f"xray-config.{key}")


@pytest.mark.parametrize(
    "definition",
    [
        "streamSettings",
    ],
)
def test_xray_config_definition_has_beginner_metadata(definition):
    schema = _load(SCHEMAS_DIR / "xray-config.schema.json")
    defs = schema.get("definitions") or {}
    assert definition in defs, f"xray-config schema missing definition `{definition}`"
    _assert_beginner_meta(defs[definition], f"xray-config.{definition}")


@pytest.mark.parametrize(
    "schema_name,property_name",
    [
        ("xray-config.schema.json", "security"),
        ("xray-config.schema.json", "tlsSettings"),
        ("xray-config.schema.json", "realitySettings"),
        ("xray-config.schema.json", "xhttpSettings"),
        ("xray-routing.schema.json", "security"),
        ("xray-routing.schema.json", "tlsSettings"),
        ("xray-routing.schema.json", "realitySettings"),
        ("xray-routing.schema.json", "xhttpSettings"),
        ("xray-inbounds.schema.json", "security"),
        ("xray-inbounds.schema.json", "tlsSettings"),
        ("xray-inbounds.schema.json", "realitySettings"),
        ("xray-inbounds.schema.json", "xhttpSettings"),
        ("xray-outbounds.schema.json", "security"),
        ("xray-outbounds.schema.json", "tlsSettings"),
        ("xray-outbounds.schema.json", "realitySettings"),
        ("xray-outbounds.schema.json", "xhttpSettings"),
    ],
)
def test_xray_stream_settings_nested_nodes_have_beginner_metadata(schema_name, property_name):
    schema = _load(SCHEMAS_DIR / schema_name)
    defs = schema.get("definitions") or {}
    node = ((((defs.get("streamSettings") or {}).get("properties")) or {}).get(property_name))
    assert node is not None, f"{schema_name}.definitions.streamSettings.properties.{property_name}: missing schema node"
    _assert_beginner_meta(node, f"{schema_name}.streamSettings.{property_name}")


# ---------- Mihomo nested/high-impact definitions ----------


@pytest.mark.parametrize(
    "definition",
    [
        "proxy",
        "proxyProvider",
        "proxyGroup",
        "ruleProvider",
    ],
)
def test_mihomo_definition_has_beginner_metadata(definition):
    schema = _load(SCHEMAS_DIR / "mihomo-config.schema.json")
    defs = schema.get("definitions") or {}
    assert definition in defs, f"mihomo schema missing definition `{definition}`"
    _assert_beginner_meta(defs[definition], f"mihomo#{definition}")


@pytest.mark.parametrize(
    "definition,property_name",
    [
        ("proxy", "network"),
        ("proxy", "reality-opts"),
        ("proxyProvider", "health-check"),
        ("proxyGroup", "proxies"),
        ("proxyGroup", "use"),
        ("ruleProvider", "behavior"),
    ],
)
def test_mihomo_nested_beginner_metadata_covers_confusing_fields(definition, property_name):
    schema = _load(SCHEMAS_DIR / "mihomo-config.schema.json")
    defs = schema.get("definitions") or {}
    node = (((defs.get(definition) or {}).get("properties")) or {}).get(property_name)
    assert node is not None, f"mihomo.{definition}.{property_name}: missing schema node"
    _assert_beginner_meta(node, f"mihomo.{definition}.{property_name}")


# ---------- Runtime hover assembly ----------


@pytest.mark.parametrize(
    "doc_with_marker,expected_pointer,expected_substring",
    [
        (
            "\n".join([
                "{",
                '  "outbounds": [',
                "    {",
                '      "tag": "proxy-a",',
                '      "protocol": "vless",',
                '      "stream__CURSOR__Settings": {',
                '        "network": "xhttp",',
                '        "security": "tls",',
                '        "tlsSettings": { "serverName": "edge.example.com" },',
                '        "xhttpSettings": { "path": "/gateway", "mode": "stream-up" }',
                "      }",
                "    }",
                "  ]",
                "}",
            ]),
            "/outbounds/0/streamSettings",
            "как именно Xray устанавливает соединение",
        ),
        (
            "\n".join([
                "{",
                '  "outbounds": [',
                "    {",
                '      "tag": "proxy-a",',
                '      "protocol": "vless",',
                '      "streamSettings": {',
                '        "network": "xhttp",',
                '        "security": "tls",',
                '        "xhttp__CURSOR__Settings": { "path": "/gateway", "mode": "stream-up" }',
                "      }",
                "    }",
                "  ]",
                "}",
            ]),
            "/outbounds/0/streamSettings/xhttpSettings",
            "современного HTTP-based транспорта XHTTP",
        ),
    ],
)
def test_xray_json_hover_uses_beginner_metadata_for_transport_blocks(doc_with_marker, expected_pointer, expected_substring):
    script = f"""
import fs from 'node:fs';
import {{ buildJsonSchemaHoverInfo }} from './xkeen-ui/static/js/vendor/codemirror_json_schema.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/xray-outbounds.schema.json', 'utf8'));
const marker = '__CURSOR__';
const docWithMarker = {json.dumps(doc_with_marker)};
const offset = docWithMarker.indexOf(marker);
const doc = docWithMarker.replace(marker, '');
const result = buildJsonSchemaHoverInfo(doc, schema, offset, {{ beginnerMode: true }});
console.log(JSON.stringify(result));
"""

    payload = _run_node_json(script)
    assert payload is not None
    assert payload["pointer"] == expected_pointer
    assert "Простыми словами:" in payload["plain"]
    assert expected_substring in payload["plain"]
