from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def test_routing_schema_completion_supports_rule_value_enum_inside_array_items():
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    script = """
import fs from 'node:fs';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { json } from '@codemirror/lang-json';
import { stateExtensions, jsonCompletion } from './xkeen-ui/static/js/vendor/codemirror_json_schema.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/xray-routing.schema.json', 'utf8'));
const doc = [
  '{',
  '  "routing": {',
  '    "domainStrategy": "",',
  '    "rules": [',
  '      {',
  '        "network": "u"',
  '      }',
  '    ]',
  '  }',
  '}',
  ''
].join('\\n');

const pos = doc.indexOf('"u"') + 2;
const state = EditorState.create({
  doc,
  extensions: [json(), stateExtensions(schema)],
});
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
    labels = json.loads(result.stdout.strip())
    assert labels is not None
    assert "udp" in labels
