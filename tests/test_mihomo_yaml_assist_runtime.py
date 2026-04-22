from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _run_completion(doc_with_marker: str) -> dict[str, object] | None:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    script = f"""
import fs from 'node:fs';
import {{ completeYamlTextFromSchema }} from './xkeen-ui/static/js/ui/yaml_schema.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/mihomo-config.schema.json', 'utf8'));
const marker = '__CURSOR__';
const docWithMarker = {json.dumps(doc_with_marker)};
const offset = docWithMarker.indexOf(marker);
const doc = docWithMarker.replace(marker, '');
const result = completeYamlTextFromSchema(doc, schema, {{ offset }});
console.log(JSON.stringify(result ? {{
  from: result.from,
  to: result.to,
  context: result.context,
  labels: result.options.map((item) => item.label),
}} : null));
"""

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


def _apply_completion(doc_with_marker: str, label: str) -> dict[str, object] | None:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    script = f"""
import fs from 'node:fs';
import {{ completeYamlTextFromSchema }} from './xkeen-ui/static/js/ui/yaml_schema.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/mihomo-config.schema.json', 'utf8'));
const marker = '__CURSOR__';
const targetLabel = {json.dumps(label)};
const docWithMarker = {json.dumps(doc_with_marker)};
const offset = docWithMarker.indexOf(marker);
const doc = docWithMarker.replace(marker, '');
const result = completeYamlTextFromSchema(doc, schema, {{ offset }});
if (!result) {{
  console.log('null');
}} else {{
  const item = (result.options || []).find((entry) => entry.label === targetLabel) || null;
  if (!item) {{
    console.log('null');
  }} else {{
    const insertText = item.insertText || item.label;
    const applied = doc.slice(0, result.from) + insertText + doc.slice(result.to);
    console.log(JSON.stringify({{
      from: result.from,
      to: result.to,
      insertText,
      applied,
      context: result.context,
    }}));
  }}
}}
"""

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


def _run_hover(doc_with_marker: str) -> dict[str, object] | None:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    script = f"""
import fs from 'node:fs';
import {{ hoverYamlTextFromSchema }} from './xkeen-ui/static/js/ui/yaml_schema.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/mihomo-config.schema.json', 'utf8'));
const marker = '__CURSOR__';
const docWithMarker = {json.dumps(doc_with_marker)};
const offset = docWithMarker.indexOf(marker);
const doc = docWithMarker.replace(marker, '');
const result = hoverYamlTextFromSchema(doc, schema, {{ offset }});
console.log(JSON.stringify(result));
"""

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


def test_custom_template_proxy_group_key_completion_suggests_include_all_variants():
    template = (ROOT / "xkeen-ui" / "opt" / "etc" / "mihomo" / "templates" / "custom.yaml").read_text(encoding="utf-8")
    doc = template.replace("    include-all: true", "    incl__CURSOR__", 1)

    result = _run_completion(doc)

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert "include-all" in result["labels"]
    assert "include-all-providers" in result["labels"]


def test_hwid_subscription_template_completion_suggests_rule_provider_format_enum():
    template = (ROOT / "xkeen-ui" / "opt" / "etc" / "mihomo" / "templates" / "hwid_subscription_template.yaml").read_text(encoding="utf-8")
    doc = template.replace("    format: mrs", "    format: m__CURSOR__", 1)

    result = _run_completion(doc)

    assert result is not None
    assert result["context"]["kind"] == "value"
    assert "mrs" in result["labels"]


def test_key_completion_reuses_existing_yaml_mapping_delimiter_without_duplicating_colon():
    result = _apply_completion("log-lev__CURSOR__: silent\n", "log-level")

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert result["insertText"] == "log-level"
    assert result["applied"] == "log-level: silent\n"


def test_key_completion_reuses_existing_yaml_mapping_delimiter_without_duplicating_empty_value_colon():
    result = _apply_completion("log-lev__CURSOR__:\n", "log-level")

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert result["insertText"] == "log-level"
    assert result["applied"] == "log-level:\n"


def test_zkeen_template_hover_exposes_description_and_default_for_geodata_mode():
    template = (ROOT / "xkeen-ui" / "opt" / "etc" / "mihomo" / "templates" / "zkeen.yaml").read_text(encoding="utf-8")
    doc = template.replace("geodata-mode", "geo__CURSOR__data-mode", 1)

    result = _run_hover(doc)

    assert result is not None
    assert result["path"] == "geodata-mode"
    assert "Использовать .dat файлы вместо mmdb" in result["plain"]
    assert "По умолчанию: false." in result["plain"]
