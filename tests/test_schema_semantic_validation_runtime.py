from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


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
        errors="replace",
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip())


def test_mihomo_yaml_runtime_reports_semantic_reference_errors():
    doc = "\n".join([
        "proxy-groups:",
        "  - name: Auto",
        "    type: select",
        "    proxies: [ghost-node]",
        "rules:",
        "  - RULE-SET,missing-provider,Auto",
        "",
    ])

    script = f"""
import fs from 'node:fs';
import {{ validateYamlTextAgainstSchema }} from './xkeen-ui/static/js/ui/yaml_schema.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/mihomo-config.schema.json', 'utf8'));
const result = validateYamlTextAgainstSchema({json.dumps(doc)}, schema, {{ maxErrors: 12 }});
console.log(JSON.stringify({{
  ok: !!result.ok,
  diagnostics: (result.diagnostics || []).map((item) => ({{
    path: item.path || '',
    severity: item.severity || '',
    message: item.message || '',
  }})),
}}));
"""

    payload = _run_node_json(script)
    assert payload["ok"] is False
    paths = [str(item["path"]) for item in payload["diagnostics"]]
    messages = [str(item["message"]) for item in payload["diagnostics"]]

    assert "proxy-groups[0].proxies[0]" in paths
    assert "rules[0]" in paths
    assert any("ghost-node" in message for message in messages)
    assert any("missing-provider" in message for message in messages)


def test_xray_semantic_validation_runtime_reports_missing_refs_and_duplicates():
    script = """
import { validateXrayRoutingSemantics } from './xkeen-ui/static/js/ui/schema_semantic_validation.js';

const result = validateXrayRoutingSemantics({
  routing: {
    balancers: [
      { tag: 'proxy', selector: [] }
    ],
    rules: [
      { ruleTag: 'dup', outboundTag: 'ghost-out' },
      { ruleTag: 'dup', balancerTag: 'ghost-balancer' },
      { outboundTag: 'direct', balancerTag: 'proxy' }
    ]
  }
}, {
  knownOutboundTags: ['direct', 'block'],
  knownInboundTags: ['tproxy']
});

console.log(JSON.stringify(result.map((item) => ({
  pointer: item.pointer || '',
  severity: item.severity || '',
  message: item.message || '',
}))));
"""

    payload = _run_node_json(script)
    pointers = [str(item["pointer"]) for item in payload]
    messages = [str(item["message"]) for item in payload]

    assert "/routing/rules/0/outboundTag" in pointers
    assert "/routing/rules/1/ruleTag" in pointers
    assert "/routing/rules/1/balancerTag" in pointers
    assert "/routing/rules/2/balancerTag" in pointers
    assert any("ghost-out" in message for message in messages)
    assert any("ghost-balancer" in message for message in messages)
    assert any("dup" in message for message in messages)


def test_codemirror_json_schema_linter_supports_xray_semantic_validation():
    doc = "\n".join([
        "{",
        '  "routing": {',
        '    "rules": [',
        "      {",
        '        "outboundTag": "ghost-out"',
        "      }",
        "    ]",
        "  }",
        "}",
        "",
    ])

    script = f"""
import fs from 'node:fs';
import {{ EditorState }} from '@codemirror/state';
import {{ json }} from '@codemirror/lang-json';
import {{ jsonSchemaLinter, stateExtensions }} from './xkeen-ui/static/js/vendor/codemirror_json_schema.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/xray-routing.schema.json', 'utf8'));
const state = EditorState.create({{
  doc: {json.dumps(doc)},
  extensions: [json(), stateExtensions(schema)],
}});
const diagnostics = jsonSchemaLinter({{
  semanticValidation: {{
    kind: 'xray-routing',
    options: {{
      knownOutboundTags: ['direct', 'block'],
    }},
  }},
}})({{ state }});

console.log(JSON.stringify(diagnostics.map((item) => ({{
  severity: item.severity || '',
  source: item.source || '',
  message: item.message || '',
}}))));
"""

    payload = _run_node_json(script)
    messages = [str(item["message"]) for item in payload]
    sources = [str(item["source"]) for item in payload]

    assert any("ghost-out" in message for message in messages)
    assert any(source == "xray-semantic" for source in sources)
