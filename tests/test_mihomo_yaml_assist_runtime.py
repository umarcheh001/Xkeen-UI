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
  const item = (result.options || []).find((entry) => entry.label === targetLabel)
    || (result.options || []).find((entry) => String(entry.label || '').endsWith(targetLabel))
    || null;
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
    template = (ROOT / "xkeen-ui" / "opt" / "etc" / "mihomo" / "templates" / "template.yaml").read_text(encoding="utf-8")
    doc = template.replace("    format: mrs", "    format: m__CURSOR__", 1)

    result = _run_completion(doc)

    assert result is not None
    assert result["context"]["kind"] == "value"
    assert "mrs" in result["labels"]


def test_proxy_provider_header_completion_suggests_hwid_headers():
    result = _run_completion(
        "\n".join([
            "proxy-providers:",
            "  premium:",
            "    type: http",
            "    url: https://sub.example.com/clash",
            "    header:",
            "      x-__CURSOR__",
            "",
        ])
    )

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert "x-hwid" in result["labels"]
    assert "x-device-os" in result["labels"]
    assert "x-ver-os" in result["labels"]
    assert "x-device-model" in result["labels"]

    result = _run_completion(
        "\n".join([
            "proxy-providers:",
            "  premium:",
            "    type: http",
            "    url: https://sub.example.com/clash",
            "    header:",
            "      User-__CURSOR__",
            "",
        ])
    )

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert "User-Agent" in result["labels"]


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


def test_proxy_key_completion_suggests_documented_vless_tls_fields():
    result = _run_completion(
        "\n".join([
            "proxies:",
            "  - name: reality-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    e__CURSOR__",
            "",
        ])
    )

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert "encryption" in result["labels"]

    result = _run_completion(
        "\n".join([
            "proxies:",
            "  - name: reality-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    pa__CURSOR__",
            "",
        ])
    )

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert "packet-encoding" in result["labels"]

    result = _run_completion(
        "\n".join([
            "proxies:",
            "  - name: xhttp-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    a__CURSOR__",
            "",
        ])
    )

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert "alpn" in result["labels"]


def test_trusttunnel_proxy_snippet_and_keys_are_available():
    result = _run_completion("proxies:\n  - __CURSOR__\n")

    assert result is not None
    assert any("trusttunnel" in label for label in result["labels"])

    applied = _apply_completion("proxies:\n  - __CURSOR__\n", "proxy: trusttunnel")
    assert applied is not None
    assert "type: trusttunnel" in applied["applied"]
    assert "health-check: true" in applied["applied"]
    assert "quic: true" in applied["applied"]

    result = _run_completion(
        "\n".join([
            "proxies:",
            "  - name: trusttunnel",
            "    type: trusttunnel",
            "    server: 1.2.3.4",
            "    port: 443",
            "    username: username",
            "    password: password",
            "    n__CURSOR__",
            "",
        ])
    )

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert "name-cert-verify" in result["labels"]

    result = _run_completion(
        "\n".join([
            "proxies:",
            "  - name: trusttunnel",
            "    type: trusttunnel",
            "    server: 1.2.3.4",
            "    port: 443",
            "    username: username",
            "    password: password",
            "    q__CURSOR__",
            "",
        ])
    )

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert "quic" in result["labels"]


def test_reality_opts_completion_suggests_support_x25519mlkem768():
    result = _run_completion(
        "\n".join([
            "proxies:",
            "  - name: reality-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    tls: true",
            "    servername: www.microsoft.com",
            "    client-fingerprint: random",
            "    reality-opts:",
            "      support-__CURSOR__",
            "",
        ])
    )

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert "support-x25519mlkem768" in result["labels"]


def test_amnezia_wg_v31_schema_completion_and_hover():
    result = _run_completion(
        "\n".join([
            "proxies:",
            "  - name: awg-v31",
            "    type: wireguard",
            "    server: awg.example.com",
            "    port: 443",
            "    ip: 10.8.0.2",
            "    private-key: client-key",
            "    public-key: server-key",
            "    amnezia-wg-option:",
            "      random-__CURSOR__",
            "",
        ])
    )

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert "random-trailers" in result["labels"]

    result = _run_completion(
        "\n".join([
            "proxies:",
            "  - name: awg-v31",
            "    type: wireguard",
            "    amnezia-wg-option:",
            "      disable-__CURSOR__",
            "",
        ])
    )

    assert result is not None
    assert "disable-cookies" in result["labels"]

    hover = _run_hover(
        "\n".join([
            "proxies:",
            "  - name: awg-v31",
            "    type: wireguard",
            "    amnezia-wg-option:",
            "      ver__CURSOR__sion: 3",
            "",
        ])
    )

    assert hover is not None
    assert hover["path"] == "proxies[0].amnezia-wg-option.version"
    assert "3.1" in hover["plain"]
    assert "AWG 3.x" in hover["plain"]


def test_amnezia_wg_v31_proxy_snippet_is_available():
    result = _run_completion("proxies:\n  - __CURSOR__\n")

    assert result is not None
    assert any("AmneziaWG 3 / 3.1" in label for label in result["labels"])

    applied = _apply_completion("proxies:\n  - __CURSOR__\n", "proxy: AmneziaWG 3 / 3.1")
    assert applied is not None
    assert "type: wireguard" in applied["applied"]
    assert "amnezia-wg-option:" in applied["applied"]
    assert "version: 3" in applied["applied"]
    assert "random-trailers: true" in applied["applied"]


def test_proxy_hover_explains_documented_vless_tls_fields():
    result = _run_hover(
        "\n".join([
            "proxies:",
            "  - name: reality-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    packet-enc__CURSOR__oding: xudp",
            "",
        ])
    )

    assert result is not None
    assert result["path"] == "proxies[0].packet-encoding"
    assert "UDP packet encoding" in result["plain"]
    assert "xudp" in result["plain"]

    result = _run_hover(
        "\n".join([
            "proxies:",
            "  - name: reality-node",
            "    type: vless",
            "    server: edge.example.com",
            "    port: 443",
            "    uuid: 11111111-1111-1111-1111-111111111111",
            "    reality-opts:",
            "      support-x25519__CURSOR__mlkem768: true",
            "",
        ])
    )

    assert result is not None
    assert result["path"] == "proxies[0].reality-opts.support-x25519mlkem768"
    assert "X25519-MLKEM768" in result["plain"]


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


def test_zkeen_template_hover_exposes_description_for_routing_mark():
    template = (ROOT / "xkeen-ui" / "opt" / "etc" / "mihomo" / "templates" / "zkeen.yaml").read_text(encoding="utf-8")
    doc = template.replace("routing-mark", "routing-__CURSOR__mark", 1)

    result = _run_hover(doc)

    assert result is not None
    assert result["path"] == "routing-mark"
    assert "fwmark для исходящих соединений" in result["plain"]
    assert "Keenetic" in result["plain"]


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

def test_root_sniffer_snippet_replaces_stale_nested_block_without_breaking_following_section():
    result = _apply_completion(
        "\n".join([
            "log-level: silent",
            "sniffe__CURSOR__",
            "  enable: true",
            "  sniff:",
            "    HTTP:",
            "    TLS:",
            "anchors:",
            "  a1: &domain { type: http }",
            "",
        ]),
        "sniffer block",
    )

    assert result is not None
    assert result["context"]["kind"] == "key"
    assert result["applied"] == "\n".join([
        "log-level: silent",
        "sniffer:",
        "  enable: true",
        "  sniff:",
        "    HTTP:",
        "    TLS:",
        "anchors:",
        "  a1: &domain { type: http }",
        "",
    ])
    assert result["applied"].count("enable: true") == 1
    assert result["applied"].count("  sniff:") == 1


def test_root_sniffer_snippet_is_hidden_after_existing_sniffer_block():
    result = _run_completion(
        "\n".join([
            "sniffer:",
            "  enable: true",
            "  sniff:",
            "    HTTP:",
            "    TLS:",
            "__CURSOR__",
        ])
    )

    assert result is not None
    assert not any("sniffer block" in label for label in result["labels"])
    assert any("tun block" in label for label in result["labels"])


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
