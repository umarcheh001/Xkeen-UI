"""Tests for multi-proxy YAML-kind support in the Mihomo generator.

Driven by the Xray-JSON subscription import flow: a converted subscription is
fed in as a single ``kind: yaml`` proxy item, but the YAML payload contains N
proxies that must each be registered in proxy-groups.
"""

from __future__ import annotations

import urllib.parse

import yaml
from pathlib import Path

from mihomo_config_generator import build_full_config
from services import mihomo_generator_meta as generator_meta
from services.mihomo_generator_proxies import (
    _split_multi_proxy_yaml,
    insert_proxies_from_state,
)


def test_split_multi_proxy_yaml_handles_single_proxy():
    block = (
        "- name: A\n"
        "  type: vless\n"
        "  server: 1.1.1.1\n"
        "  port: 443\n"
    )
    parts = _split_multi_proxy_yaml(block)
    assert len(parts) == 1
    assert parts[0].lstrip().startswith("- name: A")


def test_split_multi_proxy_yaml_separates_top_level_dashes():
    block = (
        "- name: A\n"
        "  type: vless\n"
        "  alpn:\n"
        "    - h2\n"
        "    - http/1.1\n"
        "- name: B\n"
        "  type: vless\n"
    )
    parts = _split_multi_proxy_yaml(block)
    assert len(parts) == 2
    assert "- name: A" in parts[0] and "- name: B" not in parts[0]
    assert "- name: B" in parts[1]
    # Inner list dashes (alpn) must stay with the first block, not split it.
    assert "- h2" in parts[0]
    assert "- http/1.1" in parts[0]


def test_split_multi_proxy_yaml_returns_empty_on_blank_input():
    assert _split_multi_proxy_yaml("") == []
    assert _split_multi_proxy_yaml("   \n\n") == []


def test_yaml_kind_with_multi_proxy_registers_every_proxy_in_group():
    template = (
        "proxy-groups:\n"
        "  - name: Selector\n"
        "    type: select\n"
        "    include-all: true\n"
        "\n"
        "rule-providers:\n"
        "  some: ~\n"
    )
    multi = (
        "- name: A\n"
        "  type: vless\n"
        "  server: 1.1.1.1\n"
        "  port: 443\n"
        "  uuid: aaaa\n"
        "- name: B\n"
        "  type: vless\n"
        "  server: 2.2.2.2\n"
        "  port: 443\n"
        "  uuid: bbbb\n"
        "- name: C\n"
        "  type: vless\n"
        "  server: 3.3.3.3\n"
        "  port: 443\n"
        "  uuid: cccc\n"
    )
    state = {
        "proxies": [
            {"kind": "yaml", "yaml": multi, "groups": ["Selector"]},
        ]
    }
    result = insert_proxies_from_state(template, state)
    parsed = yaml.safe_load(result)

    assert {p["name"] for p in parsed["proxies"]} == {"A", "B", "C"}
    assert "uuid: aaaa\n\n  - name: B" in result
    assert "uuid: bbbb\n\n  - name: C" in result
    selector = next(g for g in parsed["proxy-groups"] if g["name"] == "Selector")
    assert selector.get("include-all") is True
    assert "proxies" not in selector


def test_yaml_kind_with_single_proxy_still_works_after_split_helper():
    """Regression: single-proxy yaml-kind should not change behaviour."""
    template = (
        "proxy-groups:\n"
        "  - name: G\n"
        "    type: select\n"
        "    include-all: true\n"
        "\n"
        "rule-providers:\n"
        "  some: ~\n"
    )
    single = (
        "- name: Solo\n"
        "  type: vless\n"
        "  server: 9.9.9.9\n"
        "  port: 443\n"
        "  uuid: dddd\n"
    )
    state = {"proxies": [{"kind": "yaml", "yaml": single, "groups": ["G"]}]}
    result = insert_proxies_from_state(template, state)
    parsed = yaml.safe_load(result)

    assert [p["name"] for p in parsed["proxies"]] == ["Solo"]
    g = next(g for g in parsed["proxy-groups"] if g["name"] == "G")
    assert g.get("include-all") is True
    assert "proxies" not in g


def test_yaml_kind_with_multi_proxy_registers_every_proxy_in_explicit_group_without_include_all():
    template = (
        "proxy-groups:\n"
        "  - name: Selector\n"
        "    type: select\n"
        "    proxies: [DIRECT]\n"
        "\n"
        "rule-providers:\n"
        "  some: ~\n"
    )
    multi = (
        "- name: A\n"
        "  type: vless\n"
        "  server: 1.1.1.1\n"
        "  port: 443\n"
        "  uuid: aaaa\n"
        "- name: B\n"
        "  type: vless\n"
        "  server: 2.2.2.2\n"
        "  port: 443\n"
        "  uuid: bbbb\n"
    )
    state = {"proxies": [{"kind": "yaml", "yaml": multi, "groups": ["Selector"]}]}
    result = insert_proxies_from_state(template, state)
    parsed = yaml.safe_load(result)

    assert {p["name"] for p in parsed["proxies"]} == {"A", "B"}
    selector = next(g for g in parsed["proxy-groups"] if g["name"] == "Selector")
    assert set(selector.get("proxies") or []) == {"DIRECT", "A", "B"}


def test_router_custom_xray_json_import_does_not_duplicate_include_all_group_entries():
    multi = (
        "- name: A\n"
        "  type: vless\n"
        "  server: 1.1.1.1\n"
        "  port: 443\n"
        "  uuid: aaaa\n"
        "- name: B\n"
        "  type: vless\n"
        "  server: 2.2.2.2\n"
        "  port: 443\n"
        "  uuid: bbbb\n"
    )
    cfg = build_full_config({
        "profile": "router_custom",
        "enabledRuleGroups": ["Blocked", "YouTube"],
        "proxies": [
            {"kind": "yaml", "yaml": multi, "groups": ["Заблок. сервисы"]},
        ],
    })
    parsed = yaml.safe_load(cfg)

    assert {p["name"] for p in parsed["proxies"]} == {"A", "B"}
    blocked = next(g for g in parsed["proxy-groups"] if g["name"] == "Заблок. сервисы")
    assert blocked.get("include-all") is True
    assert "proxies" not in blocked or set(blocked["proxies"]) >= {"Fallback", "Fastest"}


def test_router_custom_keeps_sniffer_rule_provider_when_telegram_group_is_disabled(monkeypatch):
    bundled_templates = Path("xkeen-ui/opt/etc/mihomo/templates").resolve()
    monkeypatch.setattr(generator_meta, "TEMPLATES_DIR", bundled_templates)

    cfg = build_full_config({
        "profile": "router_custom",
        "enabledRuleGroups": [],
        "subscriptions": [],
        "proxies": [],
    })
    parsed = yaml.safe_load(cfg)

    assert parsed["sniffer"]["skip-dst-address"] == ["rule-set:telegram@ipcidr"]
    assert "telegram@ipcidr" in parsed["rule-providers"]
    assert all(group.get("name") != "Telegram" for group in parsed.get("proxy-groups") or [])
    assert "RULE-SET,telegram@ipcidr" not in cfg


def test_router_custom_routes_http_subscriptions_through_provider_adapter(monkeypatch):
    bundled_templates = Path("xkeen-ui/opt/etc/mihomo/templates").resolve()
    monkeypatch.setattr(generator_meta, "TEMPLATES_DIR", bundled_templates)

    cfg = build_full_config({
        "profile": "router_custom",
        "enabledRuleGroups": [],
        "subscriptions": ["https://provider.example/sub?a=1"],
        "proxies": [],
        "_xk_mihomo_provider_adapter_base": "http://127.0.0.1:18088",
    })
    parsed = yaml.safe_load(cfg)

    url = parsed["proxy-providers"]["proxy-sub"]["url"]
    assert url.startswith("http://127.0.0.1:18088/mihomo/provider.yaml?")
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    assert query["url"] == ["https://provider.example/sub?a=1"]
    assert query["insecure"] == ["0"]
    assert 'url: "https://provider.example/sub' not in cfg


def test_router_custom_keeps_new_community_rule_sets_when_enabled(monkeypatch):
    bundled_templates = Path("xkeen-ui/opt/etc/mihomo/templates").resolve()
    monkeypatch.setattr(generator_meta, "TEMPLATES_DIR", bundled_templates)

    cfg = build_full_config({
        "profile": "router_custom",
        "enabledRuleGroups": ["Speedtest", "CDN"],
        "subscriptions": [],
        "proxies": [],
    })
    parsed = yaml.safe_load(cfg)

    assert "speedtest@domain" in parsed["rule-providers"]
    assert "vodafone@ipcidr" in parsed["rule-providers"]
    assert "quic@inline" in parsed["rule-providers"]
    assert any(group.get("name") == "Speedtest" for group in parsed["proxy-groups"])
    assert "RULE-SET,speedtest@domain,Speedtest" in cfg
    assert "RULE-SET,vodafone@ipcidr,CDN" in cfg
    assert "RULE-SET,quic@inline,REJECT" in cfg
    assert "Пример VLESS подключения" not in cfg
    assert "Пример подключения С использованием подписки" not in cfg


def test_router_custom_removes_new_optional_rule_sets_when_disabled(monkeypatch):
    bundled_templates = Path("xkeen-ui/opt/etc/mihomo/templates").resolve()
    monkeypatch.setattr(generator_meta, "TEMPLATES_DIR", bundled_templates)

    cfg = build_full_config({
        "profile": "router_custom",
        "enabledRuleGroups": [],
        "subscriptions": [],
        "proxies": [],
    })
    parsed = yaml.safe_load(cfg)

    assert "speedtest@domain" not in parsed["rule-providers"]
    assert "vodafone@ipcidr" not in parsed["rule-providers"]
    assert all(group.get("name") != "Speedtest" for group in parsed.get("proxy-groups") or [])
    assert "RULE-SET,speedtest@domain,Speedtest" not in cfg
    assert "RULE-SET,vodafone@ipcidr,CDN" not in cfg


def test_router_zkeen_keeps_geodata_urls_and_new_geo_rules(monkeypatch):
    bundled_templates = Path("xkeen-ui/opt/etc/mihomo/templates").resolve()
    monkeypatch.setattr(generator_meta, "TEMPLATES_DIR", bundled_templates)

    cfg = build_full_config({
        "profile": "router_zkeen",
        "enabledRuleGroups": ["Telegram", "CDN", "YouTube", "Speedtest"],
        "subscriptions": [],
        "proxies": [],
    })
    parsed = yaml.safe_load(cfg)

    assert parsed["geodata-mode"] is True
    assert parsed["geox-url"]["geosite"] == "https://github.com/jameszeroX/zkeen-domains/releases/latest/download/zkeen.dat"
    assert parsed["geox-url"]["geoip"] == "https://github.com/jameszeroX/zkeen-ip/releases/latest/download/zkeenip.dat"
    assert "telegram@ipcidr" in parsed["rule-providers"]
    assert "speedtest@domain" in parsed["rule-providers"]
    assert "vodafone@ipcidr" not in parsed["rule-providers"]
    assert "RULE-SET,speedtest@domain,Speedtest" in cfg
    assert "GEOIP,TELEGRAM,Telegram" in cfg
    assert "GEOIP,VODAFONE,CDN" in cfg
    assert "RULE-SET,telegram@ipcidr,Telegram" not in cfg
    assert any(str(rule).startswith("GEOSITE,") for rule in parsed["rules"])
    assert any(str(rule).startswith("GEOIP,") for rule in parsed["rules"])


def test_yaml_kind_multi_proxy_raises_on_duplicate_names():
    template = (
        "proxy-groups:\n"
        "  - name: G\n"
        "    type: select\n"
        "    include-all: true\n"
        "\n"
        "rule-providers:\n"
        "  some: ~\n"
    )
    dup = (
        "- name: Dup\n"
        "  type: vless\n"
        "  server: 1.1.1.1\n"
        "  port: 443\n"
        "  uuid: aaaa\n"
        "- name: Dup\n"
        "  type: vless\n"
        "  server: 2.2.2.2\n"
        "  port: 443\n"
        "  uuid: bbbb\n"
    )
    state = {"proxies": [{"kind": "yaml", "yaml": dup, "groups": ["G"]}]}
    try:
        insert_proxies_from_state(template, state)
    except ValueError as exc:
        assert "Дублирующееся имя" in str(exc)
    else:
        raise AssertionError("expected ValueError for duplicate names")
