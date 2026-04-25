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
import {{ createMihomoSnippetProvider }} from './xkeen-ui/static/js/ui/schema_snippets.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/mihomo-config.schema.json', 'utf8'));
const marker = '__CURSOR__';
const docWithMarker = {json.dumps(doc_with_marker)};
const offset = docWithMarker.indexOf(marker);
const doc = docWithMarker.replace(marker, '');
const result = completeYamlTextFromSchema(doc, schema, {{ offset, snippetProvider: createMihomoSnippetProvider() }});
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
import {{ createMihomoSnippetProvider }} from './xkeen-ui/static/js/ui/schema_snippets.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/mihomo-config.schema.json', 'utf8'));
const marker = '__CURSOR__';
const targetLabel = {json.dumps(label)};
const docWithMarker = {json.dumps(doc_with_marker)};
const offset = docWithMarker.indexOf(marker);
const doc = docWithMarker.replace(marker, '');
const result = completeYamlTextFromSchema(doc, schema, {{ offset, snippetProvider: createMihomoSnippetProvider() }});
  if (!result) {{
  console.log('null');
}} else {{
  const item = (result.options || []).find((entry) => entry.label === targetLabel) || null;
  if (!item) {{
    console.log('null');
  }} else {{
    const insertText = item.insertText || item.label;
    const from = Number.isFinite(item.from) ? item.from : result.from;
    const to = Number.isFinite(item.to) ? item.to : result.to;
    const applied = doc.slice(0, from) + insertText + doc.slice(to);
    console.log(JSON.stringify({{
      from,
      to,
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


def _run_hover(doc_with_marker: str, *, beginner_mode: bool = False) -> dict[str, object] | None:
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
const result = hoverYamlTextFromSchema(doc, schema, {{ offset, beginnerMode: {str(beginner_mode).lower()} }});
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


def test_proxy_network_completion_suggests_xhttp_transport():
    result = _run_completion(
        "\n".join([
            "proxies:",
            "  - name: xhttp-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    network: x__CURSOR__",
            "",
        ])
    )

    assert result is not None
    assert result["context"]["kind"] == "value"
    assert "xhttp" in result["labels"]


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


def test_beginner_hover_explains_proxy_group_use_as_provider_reference():
    result = _run_hover(
        "\n".join([
            "proxy-groups:",
            "  - name: Auto",
            "    type: url-test",
            "    u__CURSOR__se:",
            "      - my-subscription",
            "    url: https://www.gstatic.com/generate_204",
            "",
        ]),
        beginner_mode=True,
    )

    assert result is not None
    assert result["path"] == "proxy-groups[0].use"
    assert "Простыми словами:" in result["plain"]
    assert "список provider-ов" in result["plain"]
    assert "имена provider-ов" in result["plain"]


def test_beginner_hover_explains_rule_provider_behavior():
    result = _run_hover(
        "\n".join([
            "rule-providers:",
            "  youtube:",
            "    type: http",
            "    beha__CURSOR__vior: domain",
            "    format: mrs",
            "    url: https://example.com/youtube.mrs",
            "",
        ]),
        beginner_mode=True,
    )

    assert result is not None
    assert result["path"] == "rule-providers.youtube.behavior"
    assert "Простыми словами:" in result["plain"]
    assert "что именно лежит внутри rule-provider" in result["plain"]
    assert "Если `behavior` не совпадает" in result["plain"]


def test_root_sniffer_snippet_replaces_partial_key_with_colon_cleanly():
    result = _apply_completion("snif__CURSOR__:\n", "📦 sniffer block")

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert result["applied"] == "sniffer:\n  enable: true\n  sniff:\n    HTTP:\n    TLS:\n"


def test_proxy_snippet_keeps_nested_yaml_indent_inside_array_item():
    result = _apply_completion(
        "\n".join([
            "proxies:",
            "  - __CURSOR__",
            "",
        ]),
        "📦 proxy: vless",
    )

    assert result is not None
    assert result["context"]["kind"] == "array-item"
    assert result["applied"] == "\n".join([
        "proxies:",
        '  - name: "vless-proxy"',
        "    type: vless",
        "    server: example.com",
        "    port: 443",
        '    uuid: "00000000-0000-0000-0000-000000000000"',
        "    network: tcp",
        "    tls: true",
        "    servername: example.com",
        "    flow: xtls-rprx-vision",
        "    udp: true",
        "",
    ])
