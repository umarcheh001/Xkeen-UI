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
