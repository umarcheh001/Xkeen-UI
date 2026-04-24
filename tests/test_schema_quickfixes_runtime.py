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


def test_editor_schema_resolves_quickfix_providers_for_supported_targets():
    payload = _run_node_json(
        """
import { resolveEditorQuickFixProvider } from './xkeen-ui/static/js/ui/editor_schema.js';

const routingProvider = resolveEditorQuickFixProvider({
  target: 'routing',
  file: '05_routing.jsonc',
  mode: 'jsonc',
});
const mihomoProvider = resolveEditorQuickFixProvider({
  target: 'mihomo',
  file: 'config.yaml',
  mode: 'yaml',
});

console.log(JSON.stringify({
  routing: !!routingProvider && typeof routingProvider.getQuickFixes === 'function',
  mihomo: !!mihomoProvider && typeof mihomoProvider.getQuickFixes === 'function',
}));
"""
    )

    assert payload == {"routing": True, "mihomo": True}


def test_xray_quickfix_adds_missing_outbound_tag_for_rule_without_target():
    payload = _run_node_json(
        """
import fs from 'node:fs';
import { applyQuickFixText, createXrayQuickFixProvider } from './xkeen-ui/static/js/ui/schema_quickfixes.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/xray-routing.schema.json', 'utf8'));
const provider = createXrayQuickFixProvider({
  semanticOptions: { knownOutboundTags: ['direct', 'proxy'] },
});
const text = [
  '{',
  '  "routing": {',
  '    "rules": [',
  '      {',
  '        "domain": ["example.com"]',
  '      }',
  '    ]',
  '  }',
  '}',
  '',
].join('\\n');
const fixes = provider.getQuickFixes({ text, schema });
const next = fixes.length ? applyQuickFixText(text, fixes[0]) : text;
console.log(JSON.stringify({
  titles: fixes.map((item) => item.title),
  next,
}));
"""
    )

    assert "Добавить `outboundTag: direct`" in payload["titles"]
    assert '"outboundTag": "direct"' in payload["next"]


def test_xray_quickfix_wraps_scalar_when_schema_expects_array():
    payload = _run_node_json(
        """
import fs from 'node:fs';
import { applyQuickFixText, createXrayQuickFixProvider } from './xkeen-ui/static/js/ui/schema_quickfixes.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/xray-routing.schema.json', 'utf8'));
const provider = createXrayQuickFixProvider();
const text = [
  '{',
  '  "routing": {',
  '    "balancers": [',
  '      {',
  '        "tag": "auto",',
  '        "selector": "proxy"',
  '      }',
  '    ]',
  '  }',
  '}',
  '',
].join('\\n');
const fixes = provider.getQuickFixes({ text, schema });
const wrapFix = fixes.find((item) => item.title === 'Обернуть значение в массив');
const next = wrapFix ? applyQuickFixText(text, wrapFix) : text;
console.log(JSON.stringify({ next, titles: fixes.map((item) => item.title) }));
"""
    )

    assert "Обернуть значение в массив" in payload["titles"]
    assert '"selector": [' in payload["next"]
    assert '"proxy"' in payload["next"]


def test_xray_quickfix_offers_transport_settings_block_for_ws_network():
    titles = _run_node_json(
        """
import fs from 'node:fs';
import { createXrayQuickFixProvider } from './xkeen-ui/static/js/ui/schema_quickfixes.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/xray-routing.schema.json', 'utf8'));
const provider = createXrayQuickFixProvider();
const text = [
  '{',
  '  "outbounds": [',
  '    {',
  '      "streamSettings": {',
  '        "network": "ws"',
  '      }',
  '    }',
  '  ]',
  '}',
  '',
].join('\\n');
const fixes = provider.getQuickFixes({ text, schema });
console.log(JSON.stringify(fixes.map((item) => item.title)));
"""
    )

    assert "Добавить блок `wsSettings`" in titles


def test_mihomo_quickfix_adds_default_proxies_list_for_empty_group():
    payload = _run_node_json(
        """
import fs from 'node:fs';
import { applyQuickFixText, createMihomoQuickFixProvider } from './xkeen-ui/static/js/ui/schema_quickfixes.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/mihomo-config.schema.json', 'utf8'));
const provider = createMihomoQuickFixProvider();
const text = [
  'proxy-groups:',
  '  - name: Auto',
  '    type: select',
  '',
].join('\\n');
const fixes = provider.getQuickFixes({ text, schema });
const next = fixes.length ? applyQuickFixText(text, fixes[0]) : text;
console.log(JSON.stringify({ titles: fixes.map((item) => item.title), next }));
"""
    )

    assert "Добавить `proxies: [DIRECT]`" in payload["titles"]
    assert "proxies:" in payload["next"]
    assert "DIRECT" in payload["next"]


def test_mihomo_quickfix_creates_missing_rule_provider_block():
    payload = _run_node_json(
        """
import { applyQuickFixText, createMihomoQuickFixProvider } from './xkeen-ui/static/js/ui/schema_quickfixes.js';

const provider = createMihomoQuickFixProvider();
const text = [
  'rules:',
  '  - RULE-SET,github@domain,GitHub',
  '  - MATCH,DIRECT',
  '',
].join('\\n');
const fixes = provider.getQuickFixes({ text });
const createFix = fixes.find((item) => item.title === 'Создать rule-provider `github@domain`');
const next = createFix ? applyQuickFixText(text, createFix) : text;
console.log(JSON.stringify({ titles: fixes.map((item) => item.title), next }));
"""
    )

    assert "Создать rule-provider `github@domain`" in payload["titles"]
    assert "rule-providers:" in payload["next"]
    assert "github@domain:" in payload["next"]


def test_mihomo_quickfix_offers_xhttp_opts_block_for_xhttp_proxy():
    titles = _run_node_json(
        """
import fs from 'node:fs';
import { createMihomoQuickFixProvider } from './xkeen-ui/static/js/ui/schema_quickfixes.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/mihomo-config.schema.json', 'utf8'));
const provider = createMihomoQuickFixProvider();
const text = [
  'proxies:',
  '  - name: node1',
  '    type: vless',
  '    server: edge.example.com',
  '    port: 443',
  '    uuid: 11111111-1111-1111-1111-111111111111',
  '    network: xhttp',
  '    tls: true',
  '',
].join('\\n');
const fixes = provider.getQuickFixes({ text, schema });
console.log(JSON.stringify(fixes.map((item) => item.title)));
"""
    )

    assert "Добавить блок `xhttp-opts`" in titles


def test_phase4_quickfix_runtime_is_wired_into_editors():
    schema_src = (ROOT / "xkeen-ui" / "static" / "js" / "ui" / "editor_schema.js").read_text(encoding="utf-8")
    quickfix_src = (ROOT / "xkeen-ui" / "static" / "js" / "ui" / "schema_quickfixes.js").read_text(encoding="utf-8")
    monaco_src = (ROOT / "xkeen-ui" / "static" / "js" / "ui" / "monaco_shared.js").read_text(encoding="utf-8")
    cm_src = (ROOT / "xkeen-ui" / "static" / "js" / "ui" / "codemirror6_boot.js").read_text(encoding="utf-8")
    toolbar_src = (ROOT / "xkeen-ui" / "static" / "js" / "ui" / "editor_toolbar.js").read_text(encoding="utf-8")
    routing_src = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "routing.js").read_text(encoding="utf-8")
    mihomo_src = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_panel.js").read_text(encoding="utf-8")

    assert "export function resolveEditorQuickFixProvider(ctx)" in schema_src
    assert "setEditorQuickFixProvider(target, quickFixProvider, o);" in schema_src
    assert "export function createXrayQuickFixProvider(options = {})" in quickfix_src
    assert "export function createMihomoQuickFixProvider(options = {})" in quickfix_src
    assert "registerCodeActionProvider('json'" in monaco_src
    assert "registerCodeActionProvider('yaml'" in monaco_src
    assert "editor.setQuickFixProvider = (provider) => {" in monaco_src
    assert "getQuickFixes(request)" in cm_src
    assert "applyQuickFix(fix)" in cm_src
    assert "quickFix:" in toolbar_src
    assert "quickFixProvider: getRoutingQuickFixProvider()," in routing_src
    assert "quickFixProvider: getMihomoQuickFixProvider()," in mihomo_src
    assert "icons.quickFix" in routing_src
    assert "icons.quickFix" in mihomo_src


def test_xray_semantic_flags_private_ip_rule_after_negated_geoip():
    payload = _run_node_json(
        """
import { validateXrayRoutingSemantics } from './xkeen-ui/static/js/ui/schema_semantic_validation.js';

const data = {
  routing: {
    rules: [
      { port: '443', network: 'udp', outboundTag: 'block' },
      { network: 'udp', ip: ['ext:zkeenip.dat:!ru'], outboundTag: 'proxy' },
      { ip: ['127.0.0.0/8', '10.0.0.0/8', '192.168.0.0/16'], outboundTag: 'direct' }
    ]
  }
};
const diags = validateXrayRoutingSemantics(data, {});
const match = diags.find((item) => item.code === 'private-ip-rule-not-first');
console.log(JSON.stringify({
  hasMatch: !!match,
  pointer: match ? match.pointer : null,
  severity: match ? match.severity : null,
  hint: match ? match.hint : null,
}));
"""
    )

    assert payload["hasMatch"] is True
    assert payload["pointer"] == "/routing/rules/2"
    assert payload["severity"] == "warning"
    assert "Перенесите правило" in payload["hint"]


def test_xray_semantic_quiet_when_private_ip_rule_is_first():
    payload = _run_node_json(
        """
import { validateXrayRoutingSemantics } from './xkeen-ui/static/js/ui/schema_semantic_validation.js';

const data = {
  routing: {
    rules: [
      { ip: ['127.0.0.0/8', '10.0.0.0/8', '192.168.0.0/16'], outboundTag: 'direct' },
      { port: '443', network: 'udp', outboundTag: 'block' },
      { network: 'udp', ip: ['ext:zkeenip.dat:!ru'], outboundTag: 'proxy' }
    ]
  }
};
const diags = validateXrayRoutingSemantics(data, {});
console.log(JSON.stringify({
  codes: diags.map((item) => item.code),
}));
"""
    )

    assert "private-ip-rule-not-first" not in payload["codes"]


def test_xray_semantic_quiet_when_no_negated_geoip_earlier():
    payload = _run_node_json(
        """
import { validateXrayRoutingSemantics } from './xkeen-ui/static/js/ui/schema_semantic_validation.js';

const data = {
  routing: {
    rules: [
      { port: '443', network: 'udp', outboundTag: 'block' },
      { protocol: ['bittorrent'], outboundTag: 'direct' },
      { ip: ['127.0.0.0/8', '10.0.0.0/8', '192.168.0.0/16'], outboundTag: 'direct' }
    ]
  }
};
const diags = validateXrayRoutingSemantics(data, {});
console.log(JSON.stringify({
  codes: diags.map((item) => item.code),
}));
"""
    )

    assert "private-ip-rule-not-first" not in payload["codes"]


def test_xray_quickfix_moves_private_ip_rule_to_first_position():
    payload = _run_node_json(
        """
import { applyQuickFixText, createXrayQuickFixProvider } from './xkeen-ui/static/js/ui/schema_quickfixes.js';

const provider = createXrayQuickFixProvider();
const text = [
  '{',
  '  "routing": {',
  '    "rules": [',
  '      { "port": "443", "network": "udp", "outboundTag": "block" },',
  '      { "network": "udp", "ip": ["ext:zkeenip.dat:!ru"], "outboundTag": "proxy" },',
  '      { "ip": ["127.0.0.0/8", "10.0.0.0/8", "192.168.0.0/16"], "outboundTag": "direct" }',
  '    ]',
  '  }',
  '}',
  '',
].join('\\n');
const fixes = provider.getQuickFixes({ text });
const move = fixes.find((item) => item.code === 'private-ip-rule-not-first');
const next = move ? applyQuickFixText(text, move) : text;
const parsed = JSON.parse(next);
const first = parsed && parsed.routing && parsed.routing.rules && parsed.routing.rules[0];
console.log(JSON.stringify({
  hasFix: !!move,
  title: move ? move.title : null,
  ruleCount: parsed && parsed.routing && parsed.routing.rules && parsed.routing.rules.length,
  firstIp: first && first.ip,
  firstOutbound: first && first.outboundTag,
}));
"""
    )

    assert payload["hasFix"] is True
    assert "LAN" in payload["title"]
    assert payload["ruleCount"] == 3
    assert payload["firstIp"] == ["127.0.0.0/8", "10.0.0.0/8", "192.168.0.0/16"]
    assert payload["firstOutbound"] == "direct"
