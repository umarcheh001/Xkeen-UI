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


def test_mihomo_yaml_runtime_reports_name_collisions_reserved_names_and_info_diagnostics():
    doc = "\n".join([
        "proxies:",
        "  - name: DIRECT",
        "    type: vless",
        "    server: 198.51.100.10",
        "    port: 443",
        "    uuid: 11111111-1111-1111-1111-111111111111",
        "    tls: true",
        "  - name: Auto",
        "    type: vless",
        "    server: edge.example.com",
        "    port: 443",
        "    uuid: 22222222-2222-2222-2222-222222222222",
        "proxy-groups:",
        "  - name: Auto",
        "    type: select",
        "    proxies: [DIRECT]",
        "",
    ])

    script = f"""
import fs from 'node:fs';
import {{ validateYamlTextAgainstSchema }} from './xkeen-ui/static/js/ui/yaml_schema.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/mihomo-config.schema.json', 'utf8'));
const result = validateYamlTextAgainstSchema({json.dumps(doc)}, schema, {{ maxErrors: 16 }});
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
    messages = [str(item["message"]) for item in payload["diagnostics"]]
    severities = [str(item["severity"]) for item in payload["diagnostics"]]
    paths = [str(item["path"]) for item in payload["diagnostics"]]

    assert any("спец-именем Mihomo" in message for message in messages)
    assert any("используется и в `proxies`, и в `proxy-groups`" in message for message in messages)
    assert "info" in severities
    assert "proxies[0].servername" in paths


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


def test_xray_config_semantic_validation_reports_transport_and_reference_gaps():
    script = """
import { validateXrayConfigSemantics } from './xkeen-ui/static/js/ui/schema_semantic_validation.js';

const result = validateXrayConfigSemantics({
  inbounds: [
    {
      tag: 'vless-in',
      protocol: 'trojan',
      streamSettings: {
        security: 'reality',
        realitySettings: {
          serverName: 'edge.example.com'
        }
      }
    }
  ],
  outbounds: [
    {
      tag: 'dup',
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: 'cdn.example.com',
            port: 443,
            users: [
              { id: '11111111-1111-1111-1111-111111111111', encryption: 'none', flow: 'xtls-rprx-vision' }
            ]
          }
        ]
      },
      streamSettings: {
        network: 'xhttp',
        security: 'tls',
        tlsSettings: {}
      },
      proxySettings: { tag: 'ghost-upstream' },
      mux: { enabled: true }
    },
    {
      tag: 'dup',
      protocol: 'trojan',
      settings: {
        servers: [{ address: 'edge.example.com', port: 443, password: 'secret' }]
      },
      streamSettings: {
        security: 'reality',
        realitySettings: {}
      }
    }
  ],
  routing: {
    balancers: [
      {
        tag: 'proxy',
        selector: ['missing-'],
        fallbackTag: 'ghost-fallback',
        strategy: { type: 'leastPing' }
      }
    ],
    rules: [
      { outboundTag: 'dup' }
    ]
  }
}, {
  kind: 'xray-config'
});

console.log(JSON.stringify(result.map((item) => ({
  pointer: item.pointer || '',
  severity: item.severity || '',
  code: item.code || '',
  message: item.message || '',
}))));
"""

    payload = _run_node_json(script)
    pointers = [str(item["pointer"]) for item in payload]
    codes = [str(item["code"]) for item in payload]
    messages = [str(item["message"]) for item in payload]

    assert "/inbounds/0/streamSettings/realitySettings" in pointers
    assert "/outbounds/0/proxySettings/tag" in pointers
    assert "/outbounds/0/mux/enabled" in pointers
    assert "/outbounds/0/streamSettings/network" in pointers
    assert "/outbounds/1/tag" in pointers
    assert "/routing/balancers/0/selector/0" in pointers
    assert "/routing/balancers/0/fallbackTag" in pointers
    assert "/routing/balancers/0/strategy/type" in pointers
    assert "outbound-mux-network-incompatible" in codes
    assert "outbound-flow-network-incompatible" in codes
    assert any("ghost-upstream" in message for message in messages)
    assert any("leastPing" in message for message in messages)


def test_xray_semantic_validation_reports_protocol_specific_settings_gaps():
    script = """
import { validateXrayConfigSemantics } from './xkeen-ui/static/js/ui/schema_semantic_validation.js';

const result = validateXrayConfigSemantics({
  inbounds: [
    {
      tag: 'vless-in',
      protocol: 'vless',
      settings: {
        clients: [
          { email: 'user@example.com', encryption: 'aes-128-gcm' }
        ]
      }
    },
    {
      tag: 'trojan-in',
      protocol: 'trojan',
      settings: {}
    }
  ],
  outbounds: [
    {
      tag: 'vless-out',
      protocol: 'vless',
      settings: {
        vnext: [
          {
            port: 443,
            users: [
              { encryption: 'aes-128-gcm' }
            ]
          }
        ]
      }
    },
    {
      tag: 'ss-out',
      protocol: 'shadowsocks',
      settings: {
        servers: [
          {
            address: 'ss.example.com',
            port: 8388,
            method: 'chacha20-ietf-poly1305'
          }
        ]
      }
    },
    {
      tag: 'http-out',
      protocol: 'http',
      settings: {}
    },
    {
      tag: 'trojan-out',
      protocol: 'trojan',
      settings: {
        servers: [
          {
            address: 'edge.example.com',
            port: 443
          }
        ]
      }
    }
  ]
}, {
  kind: 'xray-config'
});

console.log(JSON.stringify(result.map((item) => ({
  pointer: item.pointer || '',
  severity: item.severity || '',
  code: item.code || '',
  message: item.message || '',
}))));
"""

    payload = _run_node_json(script)
    pointers = [str(item["pointer"]) for item in payload]
    codes = [str(item["code"]) for item in payload]
    messages = [str(item["message"]) for item in payload]

    assert "/inbounds/0/settings/clients/0/id" in pointers
    assert "/inbounds/0/settings/clients/0/encryption" in pointers
    assert "/inbounds/1/settings/clients" in pointers
    assert "/outbounds/0/settings/vnext/0/address" in pointers
    assert "/outbounds/0/settings/vnext/0/users/0/id" in pointers
    assert "/outbounds/0/settings/vnext/0/users/0/encryption" in pointers
    assert "/outbounds/1/settings/servers/0/password" in pointers
    assert "/outbounds/2/settings/servers" in pointers
    assert "/outbounds/3/settings/servers/0/password" in pointers
    assert "inbound-vless-clients-id-missing" in codes
    assert "outbound-vless-vnext-address-missing" in codes
    assert "outbound-shadowsocks-servers-password-missing" in codes
    assert any("protocol: vless" in message for message in messages)


def test_mihomo_semantic_validation_reports_proxy_group_cycles():
    script = """
import { validateMihomoConfigSemantics } from './xkeen-ui/static/js/ui/schema_semantic_validation.js';

const result = validateMihomoConfigSemantics({
  'proxy-groups': [
    { name: 'Auto', type: 'select', proxies: ['Fallback'] },
    { name: 'Fallback', type: 'select', proxies: ['Auto'] }
  ]
});

console.log(JSON.stringify(result.map((item) => ({
  path: Array.isArray(item.path) ? item.path.join('.') : '',
  severity: item.severity || '',
  code: item.code || '',
  message: item.message || '',
}))));
"""

    payload = _run_node_json(script)
    paths = [str(item["path"]) for item in payload]
    codes = [str(item["code"]) for item in payload]
    messages = [str(item["message"]) for item in payload]

    assert "proxy-group-cycle" in codes
    assert "proxy-groups.0.proxies.0" in paths
    assert "proxy-groups.1.proxies.0" in paths
    assert any("Auto -> Fallback -> Auto" in message for message in messages)


def test_mihomo_semantic_validation_uses_suggestion_severity_for_soft_protocol_mismatches():
    script = """
import { validateMihomoConfigSemantics } from './xkeen-ui/static/js/ui/schema_semantic_validation.js';

const result = validateMihomoConfigSemantics({
  proxies: [
    {
      name: 'trojan-node',
      type: 'trojan',
      server: 'edge.example.com',
      port: 443,
      password: 'secret',
      tls: true,
      alterId: 0,
      flow: 'xtls-rprx-vision'
    }
  ]
});

console.log(JSON.stringify(result.map((item) => ({
  path: Array.isArray(item.path) ? item.path.join('.') : '',
  severity: item.severity || '',
  code: item.code || '',
  hint: item.hint || '',
  message: item.message || '',
}))));
"""

    payload = _run_node_json(script)
    by_code = {str(item["code"]): item for item in payload}

    assert "proxy-type-alterid" in by_code
    assert "proxy-type-flow" in by_code
    assert by_code["proxy-type-alterid"]["severity"] == "info"
    assert by_code["proxy-type-flow"]["severity"] == "info"
    assert "можно просто удалить" in str(by_code["proxy-type-alterid"]["hint"])
    assert "VLESS Reality / TLS-сценариев" in str(by_code["proxy-type-flow"]["hint"])


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


def test_codemirror_json_schema_linter_supports_xray_outbounds_semantic_validation():
    doc = "\n".join([
        "{",
        '  "outbounds": [',
        "    {",
        '      "tag": "proxy-a",',
        '      "protocol": "vless",',
        '      "settings": {',
        '        "vnext": [',
        "          {",
        '            "address": "cdn.example.com",',
        '            "port": 443,',
        '            "users": [',
        '              { "id": "11111111-1111-1111-1111-111111111111", "encryption": "none" }',
        "            ]",
        "          }",
        "        ]",
        "      },",
        '      "proxySettings": { "tag": "ghost-upstream" },',
        '      "streamSettings": {',
        '        "security": "tls",',
        '        "tlsSettings": {}',
        "      }",
        "    }",
        "  ]",
        "}",
        "",
    ])

    script = f"""
import fs from 'node:fs';
import {{ EditorState }} from '@codemirror/state';
import {{ json }} from '@codemirror/lang-json';
import {{ jsonSchemaLinter, stateExtensions }} from './xkeen-ui/static/js/vendor/codemirror_json_schema.js';

const schema = JSON.parse(fs.readFileSync('./xkeen-ui/static/schemas/xray-outbounds.schema.json', 'utf8'));
const state = EditorState.create({{
  doc: {json.dumps(doc)},
  extensions: [json(), stateExtensions(schema)],
}});
const diagnostics = jsonSchemaLinter({{
  semanticValidation: {{
    kind: 'xray-outbounds',
    options: {{}},
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
    severities = [str(item["severity"]) for item in payload]
    sources = [str(item["source"]) for item in payload]

    assert any("ghost-upstream" in message for message in messages)
    assert any("serverName" in message for message in messages)
    assert any(source == "xray-semantic" for source in sources)
    assert any(severity == "info" for severity in severities)


def test_editor_schema_resolves_semantic_validation_for_xray_targets():
    payload = _run_node_json(
        """
import { resolveEditorSemanticValidation } from './xkeen-ui/static/js/ui/editor_schema.js';

const routingValidation = resolveEditorSemanticValidation({
  target: 'routing',
  file: '05_routing.jsonc',
  mode: 'jsonc',
});
const outboundsValidation = resolveEditorSemanticValidation({
  target: 'outbounds',
  file: '04_outbounds.json',
  mode: 'json',
});
const mihomoValidation = resolveEditorSemanticValidation({
  target: 'mihomo',
  file: 'config.yaml',
  mode: 'yaml',
});

console.log(JSON.stringify({
  routingKind: routingValidation ? routingValidation.kind : null,
  outboundsKind: outboundsValidation ? outboundsValidation.kind : null,
  mihomoKind: mihomoValidation ? mihomoValidation.kind : null,
}));
"""
    )

    assert payload == {
        "routingKind": "xray-routing",
        "outboundsKind": "xray-outbounds",
        "mihomoKind": None,
    }


def test_xray_semantic_validation_runtime_warns_on_grpc_transport_deprecation():
    payload = _run_node_json(
        """
import { validateXrayConfigSemantics } from './xkeen-ui/static/js/ui/schema_semantic_validation.js';

const result = validateXrayConfigSemantics({
  outbounds: [
    {
      tag: 'grpc-node',
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: 'edge.example.com',
            port: 443,
            users: [{ id: '11111111-1111-1111-1111-111111111111', encryption: 'none' }]
          }
        ]
      },
      streamSettings: {
        network: 'grpc',
        security: 'tls',
        tlsSettings: { serverName: 'edge.example.com' },
        grpcSettings: { serviceName: 'grpc-svc' }
      }
    }
  ]
}, { kind: 'xray-outbounds' });

console.log(JSON.stringify(result.map((item) => ({
  path: Array.isArray(item.path) ? item.path.join('.') : '',
  severity: item.severity || '',
  code: item.code || '',
  message: item.message || '',
}))));
"""
    )

    codes = [str(item["code"]) for item in payload]
    messages = [str(item["message"]) for item in payload]
    severities = [str(item["severity"]) for item in payload]
    paths = [str(item["path"]) for item in payload]

    assert "outbound-stream-network-grpc-deprecated" in codes
    assert "warning" in severities
    assert "outbounds.0.streamSettings.network" in paths
    assert any("gRPC" in message and "XHTTP" in message for message in messages)


def test_xray_routing_semantics_respects_external_observatory_and_flags_local_duplicate():
    payload = _run_node_json(
        """
import { validateXrayRoutingSemantics } from './xkeen-ui/static/js/ui/schema_semantic_validation.js';

const result = validateXrayRoutingSemantics({
  routing: {
    balancers: [
      {
        tag: 'proxy',
        selector: ['cdn.pecan.run--'],
        strategy: { type: 'leastPing' }
      }
    ]
  },
  observatory: {
    subjectSelector: ['cdn.pecan.run--'],
    probeUrl: 'http://www.gstatic.com/generate_204',
    probeInterval: '60s'
  }
}, {
  externalObservatory: {
    subjectSelector: ['cdn.pecan.run--'],
    probeUrl: 'http://www.gstatic.com/generate_204',
    probeInterval: '60s'
  }
});

console.log(JSON.stringify(result.map((item) => ({
  pointer: item.pointer || '',
  severity: item.severity || '',
  code: item.code || '',
  hint: item.hint || '',
  message: item.message || '',
}))));
"""
    )

    codes = [str(item["code"]) for item in payload]
    pointers = [str(item["pointer"]) for item in payload]
    hints = [str(item["hint"]) for item in payload]

    assert "balancer-observatory-missing" not in codes
    assert "observatory-duplicates-external" in codes
    assert "/observatory" in pointers
    assert any("07_observatory.json" in hint for hint in hints)
