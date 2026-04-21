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
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip())


def _run_linter_messages(doc: str, schema_path: str = "./xkeen-ui/static/schemas/xray-routing.schema.json") -> list[str]:
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
console.log(JSON.stringify(diagnostics.map((item) => item.message)));
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
