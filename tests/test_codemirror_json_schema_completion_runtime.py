from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _run_completion_labels(doc_with_marker: str, schema_path: str = "./xkeen-ui/static/schemas/xray-routing.schema.json") -> list[str] | None:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    script = f"""
import fs from 'node:fs';
import {{ EditorState }} from '@codemirror/state';
import {{ CompletionContext }} from '@codemirror/autocomplete';
import {{ json }} from '@codemirror/lang-json';
import {{ stateExtensions, jsonCompletion }} from './xkeen-ui/static/js/vendor/codemirror_json_schema.js';

const schema = JSON.parse(fs.readFileSync({json.dumps(schema_path)}, 'utf8'));
const marker = '__CURSOR__';
const docWithMarker = {json.dumps(doc_with_marker)};
const pos = docWithMarker.indexOf(marker);
const doc = docWithMarker.replace(marker, '');
const state = EditorState.create({{
  doc,
  extensions: [json(), stateExtensions(schema)],
}});
const result = await jsonCompletion()(new CompletionContext(state, pos, true));
console.log(JSON.stringify(result ? result.options.map((option) => option.label) : null));
"""

    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        cwd=str(ROOT),
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip())


def _run_linter_diagnostics(doc: str, schema_path: str = "./xkeen-ui/static/schemas/xray-routing.schema.json") -> list[dict[str, object]]:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    script = f"""
import fs from 'node:fs';
import {{ EditorState }} from '@codemirror/state';
import {{ json }} from '@codemirror/lang-json';
import {{ jsonSchemaLinter, stateExtensions }} from './xkeen-ui/static/js/vendor/codemirror_json_schema.js';

const schema = JSON.parse(fs.readFileSync({json.dumps(schema_path)}, 'utf8'));
const doc = {json.dumps(doc)};
const state = EditorState.create({{
  doc,
  extensions: [json(), stateExtensions(schema)],
}});
const diagnostics = jsonSchemaLinter()({{ state }});
console.log(JSON.stringify(diagnostics.map((item) => {{
  const line = state.doc.lineAt(item.from);
  return {{
    message: item.message,
    line: line.number,
    column: item.from - line.from + 1,
    text: doc.slice(item.from, item.to),
  }};
}})));
"""

    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        cwd=str(ROOT),
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip())


def _run_linter_messages(doc: str, schema_path: str = "./xkeen-ui/static/schemas/xray-routing.schema.json") -> list[str]:
    return [str(item["message"]) for item in _run_linter_diagnostics(doc, schema_path)]


def _run_hover_info(doc_with_marker: str, schema_path: str = "./xkeen-ui/static/schemas/xray-routing.schema.json") -> dict[str, object] | None:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    script = f"""
import fs from 'node:fs';
import {{ buildJsonSchemaHoverInfo }} from './xkeen-ui/static/js/vendor/codemirror_json_schema.js';

const schema = JSON.parse(fs.readFileSync({json.dumps(schema_path)}, 'utf8'));
const marker = '__CURSOR__';
const docWithMarker = {json.dumps(doc_with_marker)};
const offset = docWithMarker.indexOf(marker);
const doc = docWithMarker.replace(marker, '');
const result = buildJsonSchemaHoverInfo(doc, schema, offset, {{}});
console.log(JSON.stringify(result));
"""

    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        cwd=str(ROOT),
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip())


def test_routing_schema_completion_supports_rule_value_enum_inside_array_items():
    labels = _run_completion_labels(
        "\n".join([
            "{",
            '  "routing": {',
            '    "domainStrategy": "",',
            '    "rules": [',
            "      {",
            '        "network": "u__CURSOR__"',
            "      }",
            "    ]",
            "  }",
            "}",
            "",
        ])
    )

    assert labels is not None
    assert "udp" in labels


def test_routing_schema_completion_supports_example_tags_for_outbound_rules():
    labels = _run_completion_labels(
        "\n".join([
            "{",
            '  "routing": {',
            '    "rules": [',
            "      {",
            '        "outboundTag": "d__CURSOR__"',
            "      }",
            "    ]",
            "  }",
            "}",
            "",
        ])
    )

    assert labels is not None
    assert "direct" in labels


def test_routing_schema_completion_supports_example_tags_for_inbound_arrays():
    labels = _run_completion_labels(
        "\n".join([
            "{",
            '  "routing": {',
            '    "rules": [',
            "      {",
            '        "inboundTag": ["t__CURSOR__"]',
            "      }",
            "    ]",
            "  }",
            "}",
            "",
        ])
    )

    assert labels is not None
    assert "tproxy" in labels


def test_routing_schema_completion_supports_quic_for_protocol_arrays():
    labels = _run_completion_labels(
        "\n".join([
            "{",
            '  "routing": {',
            '    "rules": [',
            "      {",
            '        "protocol": ["q__CURSOR__"]',
            "      }",
            "    ]",
            "  }",
            "}",
            "",
        ])
    )

    assert labels is not None
    assert "quic" in labels


def test_inbounds_schema_completion_supports_inbound_object_keys():
    labels = _run_completion_labels(
        "\n".join([
            "{",
            '  "inbounds": [',
            "    {",
            "      __CURSOR__",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-inbounds.schema.json",
    )

    assert labels is not None
    assert "protocol" in labels
    assert "port" in labels
    assert "settings" in labels


def test_outbounds_schema_completion_supports_outbound_object_keys():
    labels = _run_completion_labels(
        "\n".join([
            "{",
            '  "outbounds": [',
            "    {",
            "      __CURSOR__",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-outbounds.schema.json",
    )

    assert labels is not None
    assert "protocol" in labels
    assert "tag" in labels
    assert "streamSettings" in labels


def test_outbounds_schema_completion_supports_protocol_specific_nested_keys():
    labels = _run_completion_labels(
        "\n".join([
            "{",
            '  "outbounds": [',
            "    {",
            '      "protocol": "vless",',
            '      "settings": {',
            '        "vnext": [',
            "          {",
            '            __CURSOR__',
            "          }",
            "        ]",
            "      }",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-outbounds.schema.json",
    )

    assert labels is not None
    assert "address" in labels
    assert "port" in labels
    assert "users" in labels


def test_outbounds_schema_completion_supports_vnext_user_identity_fields():
    labels = _run_completion_labels(
        "\n".join([
            "{",
            '  "outbounds": [',
            "    {",
            '      "protocol": "vless",',
            '      "settings": {',
            '        "vnext": [',
            "          {",
            '            "users": [',
            "              {",
            '                __CURSOR__',
            "              }",
            "            ]",
            "          }",
            "        ]",
            "      }",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-outbounds.schema.json",
    )

    assert labels is not None
    assert "id" in labels
    assert "encryption" in labels
    assert "level" in labels
    assert "flow" in labels


def test_outbounds_schema_completion_supports_reality_shortid_and_blackhole_response():
    reality_labels = _run_completion_labels(
        "\n".join([
            "{",
            '  "outbounds": [',
            "    {",
            '      "protocol": "vless",',
            '      "streamSettings": {',
            '        "security": "reality",',
            '        "realitySettings": {',
            '          "short__CURSOR__"',
            "        }",
            "      }",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-outbounds.schema.json",
    )

    response_labels = _run_completion_labels(
        "\n".join([
            "{",
            '  "outbounds": [',
            "    {",
            '      "protocol": "blackhole",',
            '      "settings": {',
            '        "r__CURSOR__"',
            "      }",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-outbounds.schema.json",
    )

    assert reality_labels is not None
    assert "shortId" in reality_labels
    assert response_labels is not None
    assert "response" in response_labels


def test_outbounds_schema_hover_supports_nested_protocol_specific_fields():
    vnext_hover = _run_hover_info(
        "\n".join([
            "{",
            '  "outbounds": [',
            "    {",
            '      "protocol": "vless",',
            '      "settings": {',
            '        "vne__CURSOR__xt": [',
            "          {",
            '            "address": "umarwelder.xyz",',
            '            "port": 443,',
            '            "users": [',
            '              { "id": "f3131569-259f-4c4e-8fd9-67daf2212223", "encryption": "none", "level": 0, "flow": "xtls-rprx-vision-udp443" }',
            "            ]",
            "          }",
            "        ]",
            "      }",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-outbounds.schema.json",
    )

    shortid_hover = _run_hover_info(
        "\n".join([
            "{",
            '  "outbounds": [',
            "    {",
            '      "protocol": "vless",',
            '      "streamSettings": {',
            '        "security": "reality",',
            '        "realitySettings": {',
            '          "short__CURSOR__Id": "ff5f69b37fd16f"',
            "        }",
            "      }",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-outbounds.schema.json",
    )

    response_type_hover = _run_hover_info(
        "\n".join([
            "{",
            '  "outbounds": [',
            "    {",
            '      "protocol": "blackhole",',
            '      "settings": {',
            '        "response": {',
            '          "ty__CURSOR__pe": "http"',
            "        }",
            "      }",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-outbounds.schema.json",
    )

    assert vnext_hover is not None
    assert vnext_hover["pointer"] == "/outbounds/0/settings/vnext"
    assert "legacy/распространённой схеме" in str(vnext_hover["plain"])

    assert shortid_hover is not None
    assert shortid_hover["pointer"] == "/outbounds/0/streamSettings/realitySettings/shortId"
    assert "один из `shortids`" in str(shortid_hover["plain"]).lower()

    assert response_type_hover is not None
    assert response_type_hover["pointer"] == "/outbounds/0/settings/response/type"
    assert "http 403" in str(response_type_hover["plain"]).lower()


def test_routing_schema_linter_prefers_nested_anyof_branch_errors_over_root_mismatch():
    messages = _run_linter_messages(
        "\n".join([
            "{",
            '  "routing": {',
            '    "rules": [',
            "      {",
            '        "IP": ["1.1.1.1/32"]',
            "      }",
            "    ],",
            '    "balancers": [',
            "      {",
            '        "Tag": "proxy",',
            '        "selector": []',
            "      }",
            "    ]",
            "  }",
            "}",
            "",
        ])
    )

    assert all("`routing`" not in message for message in messages)
    assert any("`IP`" in message for message in messages)
    assert any("`tag`" in message for message in messages)


def test_routing_schema_linter_reports_jsonc_line_path_and_case_hint():
    diagnostics = _run_linter_diagnostics(
        "\n".join([
            "{",
            "  // JSONC comment before routing",
            '  "routing": {',
            '    "rules": [',
            "      {",
            '        "IP": ["1.1.1.1/32"]',
            "      }",
            "    ],",
            '    "balancers": [',
            "      {",
            '        "Tag": "proxy",',
            '        "selector": []',
            "      }",
            "    ]",
            "  }",
            "}",
            "",
        ])
    )

    ip_diag = next(item for item in diagnostics if "`IP`" in str(item["message"]))
    assert ip_diag["line"] == 6
    assert ip_diag["column"] == 9
    assert ip_diag["text"] == '"IP"'
    assert "строка 6, столбец 9" in str(ip_diag["message"])
    assert "путь routing.rules[0].IP" in str(ip_diag["message"])
    assert "используйте `ip`" in str(ip_diag["message"])

    tag_diag = next(item for item in diagnostics if "`Tag`" in str(item["message"]))
    assert tag_diag["line"] == 11
    assert tag_diag["column"] == 9
    assert tag_diag["text"] == '"Tag"'
    assert "путь routing.balancers[0].Tag" in str(tag_diag["message"])
    assert "используйте `tag`" in str(tag_diag["message"])


def test_routing_schema_linter_accepts_quic_protocol_matcher():
    diagnostics = _run_linter_diagnostics(
        "\n".join([
            "{",
            '  "routing": {',
            '    "rules": [',
            "      {",
            '        "protocol": ["quic"],',
            '        "outboundTag": "direct"',
            "      }",
            "    ]",
            "  }",
            "}",
            "",
        ])
    )

    assert not any(str(item["text"]) == '"quic"' for item in diagnostics)


def test_outbounds_schema_linter_warns_when_grpc_transport_is_used():
    messages = _run_linter_messages(
        "\n".join([
            "{",
            '  "outbounds": [',
            "    {",
            '      "protocol": "vless",',
            '      "settings": {',
            '        "vnext": [',
            "          {",
            '            "address": "grpc.example.com",',
            '            "port": 443,',
            '            "users": [',
            '              { "id": "11111111-1111-1111-1111-111111111111", "encryption": "none" }',
            "            ]",
            "          }",
            "        ]",
            "      },",
            '      "streamSettings": {',
            '        "network": "grpc"',
            "      }",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-outbounds.schema.json",
    )

    assert any("gRPC" in message or "XHTTP" in message for message in messages)


def test_json_schema_linter_supports_dependent_required(tmp_path: Path):
    schema_path = tmp_path / "dependent-required.schema.json"
    schema_path.write_text(
        json.dumps(
            {
                "type": "object",
                "properties": {
                    "mode": {"type": "string"},
                    "client-fingerprint": {"type": "string"},
                },
                "dependentRequired": {
                    "mode": ["client-fingerprint"],
                },
            }
        ),
        encoding="utf-8",
    )

    messages = _run_linter_messages(
        '{"mode":"reality"}',
        schema_path=str(schema_path),
    )

    assert any("`mode`" in message and "`client-fingerprint`" in message for message in messages)


def test_outbounds_schema_linter_requires_matching_network_for_xhttp_settings():
    messages = _run_linter_messages(
        "\n".join([
            "{",
            '  "outbounds": [',
            "    {",
            '      "protocol": "vless",',
            '      "tag": "proxy-xhttp",',
            '      "settings": {',
            '        "vnext": [',
            "          {",
            '            "address": "edge.example.com",',
            '            "port": 443,',
            '            "users": [',
            '              { "id": "11111111-1111-1111-1111-111111111111", "encryption": "none" }',
            "            ]",
            "          }",
            "        ]",
            "      },",
            '      "streamSettings": {',
            '        "network": "ws",',
            '        "xhttpSettings": {',
            '          "path": "/"',
            "        }",
            "      }",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-outbounds.schema.json",
    )

    assert any('"xhttp"' in message for message in messages)


def test_outbounds_schema_linter_requires_tls_security_for_tls_settings():
    messages = _run_linter_messages(
        "\n".join([
            "{",
            '  "outbounds": [',
            "    {",
            '      "protocol": "trojan",',
            '      "tag": "proxy-tls",',
            '      "settings": {',
            '        "servers": [',
            "          {",
            '            "address": "edge.example.com",',
            '            "port": 443,',
            '            "password": "secret"',
            "          }",
            "        ]",
            "      },",
            '      "streamSettings": {',
            '        "security": "none",',
            '        "tlsSettings": {',
            '          "serverName": "edge.example.com"',
            "        }",
            "      }",
            "    }",
            "  ]",
            "}",
            "",
        ]),
        schema_path="./xkeen-ui/static/schemas/xray-outbounds.schema.json",
    )

    assert any('"tls"' in message for message in messages)
