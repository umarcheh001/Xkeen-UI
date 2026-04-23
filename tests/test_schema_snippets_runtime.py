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


def test_editor_schema_resolves_snippet_providers_for_supported_targets():
    payload = _run_node_json(
        """
import { resolveEditorSnippetProvider } from './xkeen-ui/static/js/ui/editor_schema.js';

const routingProvider = resolveEditorSnippetProvider({
  target: 'routing',
  file: '05_routing.jsonc',
  mode: 'jsonc',
});
const outboundsProvider = resolveEditorSnippetProvider({
  target: 'outbounds',
  file: '04_outbounds.json',
  mode: 'jsonc',
});
const mihomoProvider = resolveEditorSnippetProvider({
  target: 'mihomo',
  file: 'config.yaml',
  mode: 'yaml',
});

console.log(JSON.stringify({
  routing: routingProvider ? routingProvider({ pointer: '/routing/rules/0' }).map((item) => item.id) : [],
  outbounds: outboundsProvider ? outboundsProvider({ pointer: '/outbounds/0' }).map((item) => item.id) : [],
  mihomo: mihomoProvider ? mihomoProvider({ path: [] }).map((item) => item.id) : [],
}));
"""
    )

    assert "xray-rule-block-domain" in payload["routing"]
    assert "xray-rule-via-balancer" in payload["routing"]
    assert "xray-outbound-direct" in payload["outbounds"]
    assert "xray-outbound-vless-reality" in payload["outbounds"]
    assert "mihomo-dns-block" in payload["mihomo"]
    assert "mihomo-tun-block" in payload["mihomo"]
    assert "mihomo-sniffer-block" in payload["mihomo"]


def test_json_completion_runtime_surfaces_routing_rule_snippets_when_provider_is_wired():
    labels = _run_node_json(
        """
import fs from 'node:fs';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { json } from '@codemirror/lang-json';
import { stateExtensions, jsonCompletion } from './xkeen-ui/static/js/vendor/codemirror_json_schema.js';
import { resolveEditorSnippetProvider } from './xkeen-ui/static/js/ui/editor_schema.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/xray-routing.schema.json', 'utf8'));
const marker = '__CURSOR__';
const docWithMarker = [
  '{',
  '  "routing": {',
  '    "rules": [',
  '      {',
  '        __CURSOR__',
  '      }',
  '    ]',
  '  }',
  '}',
  '',
].join('\\n');
const pos = docWithMarker.indexOf(marker);
const doc = docWithMarker.replace(marker, '');
const provider = resolveEditorSnippetProvider({
  target: 'routing',
  file: '05_routing.jsonc',
  mode: 'jsonc',
});
const state = EditorState.create({
  doc,
  extensions: [json(), stateExtensions(schema)],
});
const result = await jsonCompletion({
  schemaKind: 'xray-routing',
  snippetProvider: provider,
})(new CompletionContext(state, pos, true));

console.log(JSON.stringify(result ? result.options.map((option) => option.label) : []));
"""
    )

    assert "📦 rule: block by domain" in labels
    assert "📦 rule: direct by domain" in labels


def test_xray_dns_snippet_points_to_keenetic_dns_over_vless_flow():
    payload = _run_node_json(
        """
import { getXraySnippets } from './xkeen-ui/static/js/ui/schema_snippets.js';

const dnsSnippet = getXraySnippets({
  schemaKind: 'xray-config',
  pointer: '/',
}).find((item) => item && item.id === 'xray-config-dns');

console.log(JSON.stringify({
  label: dnsSnippet ? dnsSnippet.label : '',
  warning: dnsSnippet ? dnsSnippet.warning : '',
  documentation: dnsSnippet ? dnsSnippet.documentation : '',
  insertText: dnsSnippet ? dnsSnippet.insertText : '',
}));
"""
    )

    assert "jameszero.net/3398.htm" in payload["warning"]
    assert "dns-out outbound" in payload["warning"]
    assert '"tag": "dns-in"' in payload["insertText"]
    assert '"queryStrategy": "UseIP"' in payload["insertText"]


def test_feature_editors_wire_schema_snippet_providers():
    routing_src = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "routing.js").read_text(encoding="utf-8")
    mihomo_src = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_panel.js").read_text(encoding="utf-8")
    modal_src = (ROOT / "xkeen-ui" / "static" / "js" / "ui" / "json_editor_modal.js").read_text(encoding="utf-8")
    schema_src = (ROOT / "xkeen-ui" / "static" / "js" / "ui" / "editor_schema.js").read_text(encoding="utf-8")

    assert "snippetProvider: getRoutingSnippetProvider()," in routing_src
    assert "snippetProvider: getMihomoSnippetProvider()," in mihomo_src
    assert "snippetProvider: getJsonEditorSnippetProvider()," in modal_src
    assert "export function resolveEditorSnippetProvider(ctx)" in schema_src
    assert "setEditorSnippetProvider(target, snippetProvider, o);" in schema_src
