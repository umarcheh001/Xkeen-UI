from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest
from flask import Flask

from services import mihomo_dns as dns


BASE = """log-level: silent
allow-lan: true
redir-port: 5000
tproxy-port: 5001
profile: { store-selected: true, store-fake-ip: true }

proxy-groups:
  - name: Заблок. сервисы
    type: select
    include-all: true

rules:
  - MATCH,DIRECT
"""

XKEEN_MANGLE_OK = """-P PREROUTING ACCEPT
-N xkeen
-A PREROUTING -p udp -m connmark --mark 0xffffaaa -j xkeen
-A xkeen -p udp -m comment --comment xkeen_rule -j TPROXY --on-ip 127.0.0.1 --on-port 5001 --tproxy-mark 0x111
"""

XKEEN_NAT_OK = """-P PREROUTING ACCEPT
-N xkeen
-A PREROUTING -p tcp -m connmark --mark 0xffffaaa -j xkeen
-A xkeen -p tcp -m comment --comment xkeen_rule -j REDIRECT --to-ports 5000
"""

XKEEN_INIT_LEGACY = """#!/bin/sh
name_app="XKeen"
name_chain="xkeen"
ipv4_exclude="255.255.255.255/32 10.0.0.0/8 198.18.0.0/15 224.0.0.0/4"
proxy_dns="off"
"""


def _fake_ip_firewall(monkeypatch, *, mangle=XKEEN_MANGLE_OK, nat=XKEEN_NAT_OK):
    monkeypatch.setattr(
        dns,
        "_iptables_table_rules",
        lambda table: ((mangle if table == "mangle" else nat), ""),
    )


def _live_fake_ip_firewall(monkeypatch, init_script: Path):
    def read_rules(table):
        mangle = XKEEN_MANGLE_OK
        if dns.LEGACY_FAKE_IP_EXCLUSION in init_script.read_text(encoding="utf-8"):
            mangle = mangle.replace(
                "-A xkeen -p udp",
                "-A xkeen -d 198.18.0.0/15 -m comment --comment xkeen_rule -j RETURN\n-A xkeen -p udp",
            )
        return (mangle if table == "mangle" else XKEEN_NAT_OK), ""

    monkeypatch.setattr(dns, "_iptables_table_rules", read_rules)
    monkeypatch.setattr(dns, "resolve_xkeen_init_script", lambda: str(init_script))


def test_iptables_dump_uses_wait_syntax_supported_by_keenetic(monkeypatch):
    calls = []

    class Proc:
        returncode = 0
        stdout = XKEEN_MANGLE_OK
        stderr = ""

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return Proc()

    monkeypatch.setattr(dns.subprocess, "run", run)

    rules, error = dns._iptables_table_rules("mangle")

    assert error == ""
    assert rules == XKEEN_MANGLE_OK
    assert calls == [
        (
            ["/opt/sbin/iptables", "-w", "-t", "mangle", "-S"],
            {"capture_output": True, "text": True, "timeout": 4},
        )
    ]


def test_build_enabled_config_is_additive_routed_and_router_safe():
    content, group = dns.build_enabled_config(BASE)

    assert group == "Заблок. сервисы"
    assert "allow-lan: true" in content
    assert "redir-port: 5000" in content
    assert "tproxy-port: 5001" in content
    assert content.count("dns:") == 1
    assert "listen: 0.0.0.0:53" in content
    assert "enhanced-mode: redir-host" in content
    assert "prefer-h3: false" in content
    assert "store-fake-ip" not in content
    assert "profile: { store-selected: true }" in content
    assert "https://8.8.8.8/dns-query#Заблок. сервисы&name-cert-verify=dns.google" in content
    assert "https://1.1.1.1/dns-query#Заблок. сервисы&name-cert-verify=cloudflare-dns.com" in content
    # The managed block is kept with the top-level runtime settings rather
    # than appended after providers/groups/rules.
    assert content.index("profile:") < content.index(dns.MANAGED_BEGIN) < content.index("proxy-groups:")


def test_build_enabled_config_adds_geosite_ru_filters_for_fake_ip_geodata():
    content, _ = dns.build_enabled_config(BASE, mode="fake-ip", geodata=True)

    lines = content.splitlines()
    start = lines.index("  fake-ip-filter:")
    assert lines[start + 1] == "    - 'geosite:private'"
    assert lines[start + 2] == "    - 'geosite:category-ru'"
    assert lines[start + 3] == "    - '+.tsarea.tv'  # TorrServer"
    assert "*.lan" not in content
    assert "*.local" not in content


def test_build_enabled_config_adds_domain_rule_providers_without_geodata():
    content, _ = dns.build_enabled_config(
        BASE,
        mode="fake-ip",
        fake_ip={"range": "198.18.0.1/16", "filter_mode": "blacklist"},
        geodata=False,
        rule_providers=["category-ru", "private"],
    )

    assert "geodata-mode: true" not in content
    assert "rule-providers:" in content
    assert "category_ru@domain" in content
    assert "geosite_private@domain" in content
    assert "rule-set:category_ru@domain" in content
    assert "rule-set:geosite_private@domain" in content
    assert "geosite:private" not in content


def test_build_enabled_config_can_add_a_dns_route_selector():
    content, group = dns.build_enabled_config(BASE, dns_selector=True)

    assert group == "Заблок. сервисы"
    assert content.count("proxy-groups:") == 1
    assert "  - name: 'DNS Proxy'\n" in content
    assert "    type: select\n" in content
    assert "    icon: 'https://img.icons8.com/fluency/96/dns.png'\n" in content
    assert "    proxies:\n      - 'Заблок. сервисы'\n      - DIRECT\n" in content
    assert "https://8.8.8.8/dns-query#DNS Proxy&name-cert-verify=dns.google" in content


def test_dns_route_selector_never_overwrites_an_existing_group():
    source = BASE.replace("proxy-groups:\n", "proxy-groups:\n  - name: DNS Proxy\n    type: select\n    proxies: [DIRECT]\n")

    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.build_enabled_config(source, group="Заблок. сервисы", dns_selector=True)

    assert captured.value.code == "dns_selector_conflict"
    assert "не будет её перезаписывать" in str(captured.value)


def test_dns_route_selector_is_opt_in():
    content, _ = dns.build_enabled_config(BASE)

    assert "name: 'DNS Proxy'" not in content
    assert "#DNS Proxy&" not in content


def test_an_existing_dns_proxy_group_can_be_selected_without_recreating_it():
    source = BASE.replace("proxy-groups:\n", "proxy-groups:\n  - name: DNS Proxy\n    type: select\n    proxies: [DIRECT]\n")

    content, group = dns.build_enabled_config(source, group="DNS Proxy")

    assert group == "DNS Proxy"
    assert content.count("name: DNS Proxy") == 1
    assert "#DNS Proxy&name-cert-verify=dns.google" in content


def test_build_enabled_config_adds_recommended_fake_ip_profile_by_default():
    content, _ = dns.build_enabled_config(BASE, mode="fake-ip")

    expected_filters = (
        "    - 'rule-set:category_ru@domain'  # Российские сайты\n"
        "    - 'rule-set:geosite_private@domain'  # Локальные устройства и приватные доменные зоны\n"
        "    - 'rule-set:category-ai@domain'  # Список доменов AI-сервисов\n"
        "    - '+.tsarea.tv'  # TorrServer\n"
    )
    assert expected_filters in content
    assert "category-ai-chat-!cn.mrs" in content
    assert "    - 77.88.8.8\n    - 77.88.8.1" in content
    for nameserver in (
        "https://geohide.ru/dns-query",
        "quic://dns.comss.one",
        "https://dns.alidns.com/dns-query",
        "https://xbox-dns.ru/dns-query",
        "https://cloudflare-dns.com/dns-query#Заблок. сервисы&name-cert-verify=cloudflare-dns.com",
        "https://dns.google/dns-query#Заблок. сервисы&name-cert-verify=dns.google",
        "tls://8.8.8.8#Заблок. сервисы&name-cert-verify=dns.google",
        "tls://1.1.1.1#Заблок. сервисы&name-cert-verify=cloudflare-dns.com",
    ):
        assert nameserver in content
    assert "  nameserver-policy:\n" in content
    assert (
        "    'rule-set:category_ru@domain':\n"
        "      - 77.88.8.8\n"
        "      - 77.88.8.1\n"
        "    'rule-set:category-ai@domain':\n"
        "      - 'https://xbox-dns.ru/dns-query'\n"
    ) in content


def test_fake_ip_status_defaults_match_the_generated_resolver_profile():
    options = dns._normalize_dns_options(mode="fake-ip")

    assert options["tunnel"] == [item[0] for item in dns.DEFAULT_FAKE_IP_ROUTED_NAMESERVERS]
    assert options["tunnel"] != list(dns.DEFAULT_DNS_OPTIONS["tunnel"])


def test_fake_ip_route_rejects_legacy_xkeen_rfc2544_return(monkeypatch):
    legacy = XKEEN_MANGLE_OK.replace(
        "-A xkeen -p udp",
        "-A xkeen -d 198.18.0.0/15 -m comment --comment xkeen_rule -j RETURN\n-A xkeen -p udp",
    )
    _fake_ip_firewall(monkeypatch, mangle=legacy)

    route = dns._fake_ip_route_info(BASE, "198.18.0.1/16")

    assert route["available"] is False
    assert route["confidence"] == "blocked"
    assert route["firewall"] == {
        "table": "mangle",
        "chain": "xkeen",
        "protocol": "udp",
        "exclusion": "198.18.0.0/15",
    }
    assert "чистую установку актуальной версии" in route["message"]


def test_fake_ip_route_rejects_a_return_that_overlaps_part_of_the_range(monkeypatch):
    legacy = XKEEN_MANGLE_OK.replace(
        "-A xkeen -p udp",
        "-A xkeen -d 198.18.0.0/15 -m comment --comment xkeen_rule -j RETURN\n-A xkeen -p udp",
    )
    _fake_ip_firewall(monkeypatch, mangle=legacy)

    route = dns._fake_ip_route_info(BASE, "198.16.0.1/14")

    assert route["available"] is False
    assert route["confidence"] == "blocked"
    assert route["firewall"]["exclusion"] == "198.18.0.0/15"


def test_fake_ip_route_confirms_complete_hybrid_firewall_path(monkeypatch):
    _fake_ip_firewall(monkeypatch)

    route = dns._fake_ip_route_info(BASE, "198.18.0.1/16")

    assert route["available"] is True
    assert route["confidence"] == "confirmed"
    assert route["mode"] == "hybrid"
    assert "TCP → REDIRECT 5000" in route["message"]
    assert "UDP → TProxy 5001" in route["message"]


def test_fake_ip_route_does_not_accept_listener_without_firewall_path(monkeypatch):
    _fake_ip_firewall(monkeypatch, mangle="", nat="")

    route = dns._fake_ip_route_info(BASE, "198.18.0.1/16")

    assert route["available"] is False
    assert route["confidence"] == "unverified"
    assert route["missing_paths"] == ["UDP (mangle)", "TCP (nat)"]
    assert "TProxy-порт 5001 указан" in route["message"]


def test_fake_ip_route_reports_unreadable_firewall_without_claiming_success(monkeypatch):
    monkeypatch.setattr(dns, "_iptables_table_rules", lambda _table: ("", "iptables не найден"))

    route = dns._fake_ip_route_info(BASE, "198.18.0.1/16")

    assert route["available"] is False
    assert route["confidence"] == "unknown"
    assert route["firewall_error"] == "iptables не найден"


def test_legacy_xkeen_repair_plan_removes_only_exact_exclusion(tmp_path: Path):
    script = tmp_path / "S05xkeen"
    script.write_text(XKEEN_INIT_LEGACY, encoding="utf-8", newline="\n")
    script.chmod(0o751)
    original_mode = stat.S_IMODE(script.stat().st_mode)

    plan = dns._legacy_xkeen_repair_plan(str(script))

    patched = plan["patched"].decode("utf-8")
    assert dns.LEGACY_FAKE_IP_EXCLUSION not in patched
    assert 'ipv4_exclude="255.255.255.255/32 10.0.0.0/8 224.0.0.0/4"' in patched
    assert patched.replace(" 224.0.0.0/4", " 198.18.0.0/15 224.0.0.0/4") == XKEEN_INIT_LEGACY
    assert plan["mode"] == original_mode
    assert script.read_text(encoding="utf-8") == XKEEN_INIT_LEGACY


@pytest.mark.parametrize(
    "source",
    [
        XKEEN_INIT_LEGACY.replace('ipv4_exclude="', 'ipv4_exclude="$custom '),
        XKEEN_INIT_LEGACY + 'ipv4_exclude="198.18.0.0/15"\n',
        XKEEN_INIT_LEGACY.replace('name_chain="xkeen"\n', ""),
    ],
)
def test_legacy_xkeen_repair_refuses_unknown_script_format(tmp_path: Path, source: str):
    script = tmp_path / "S05xkeen"
    script.write_text(source, encoding="utf-8", newline="\n")
    before = script.read_bytes()

    with pytest.raises(dns.MihomoDnsError) as captured:
        dns._legacy_xkeen_repair_plan(str(script))

    assert captured.value.code == "fake_ip_repair_script_unsupported"
    assert script.read_bytes() == before


def test_redir_host_keeps_the_existing_resolver_profile():
    content, _ = dns.build_enabled_config(BASE, mode="redir-host")

    assert "    - 77.88.8.8\n    - 1.1.1.1" in content
    assert "https://8.8.8.8/dns-query#Заблок. сервисы&name-cert-verify=dns.google" in content
    assert "https://1.1.1.1/dns-query#Заблок. сервисы&name-cert-verify=cloudflare-dns.com" in content
    assert "geohide.ru" not in content
    assert "nameserver-policy" not in content


def test_mihomo_dns_can_carry_xray_local_and_direct_resolver_zones():
    content, _ = dns.build_enabled_config(
        BASE,
        dns_options={
            "tunnel": ["https://8.8.8.8/dns-query", "https://1.1.1.1/dns-query"],
            "local_resolvers": ["192.168.1.1"],
            "local_domains": ["lan", "home.arpa"],
            "direct_resolvers": ["https://9.9.9.9/dns-query"],
            "direct_domains": ["cdn.example.org"],
        },
    )

    assert "https://8.8.8.8/dns-query#Заблок. сервисы&name-cert-verify=dns.google" in content
    assert "'+.lan':" in content
    assert "'+.home.arpa':" in content
    assert "- '192.168.1.1'" in content
    assert "'+.cdn.example.org':" in content
    assert "- 'https://9.9.9.9/dns-query#DIRECT'" in content


@pytest.mark.parametrize(
    "dns_options",
    [
        {"tunnel": ["https://9.9.9.9/dns-query#DIRECT"]},
        {
            "local_resolvers": ["192.168.1.1#DIRECT"],
            "local_domains": ["lan"],
        },
        {
            "direct_resolvers": ["https://9.9.9.9/dns-query#Заблок. сервисы"],
            "direct_domains": ["example.org"],
        },
    ],
)
def test_mihomo_dns_portable_resolvers_cannot_override_the_selected_route(dns_options):
    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.build_enabled_config(BASE, dns_options=dns_options)

    assert captured.value.code == "dns_servers_invalid"


def test_mihomo_dns_rejects_incomplete_local_policy():
    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.build_enabled_config(
            BASE,
            dns_options={"local_resolvers": ["192.168.1.1"]},
        )
    assert captured.value.code == "dns_policy_incomplete"


@pytest.mark.parametrize("resolver", ["127.0.0.1", "127.0.0.1:53", "[::1]:53", "localhost"])
def test_mihomo_dns_rejects_policy_resolver_loop_into_its_port_53(resolver):
    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.build_enabled_config(
            BASE,
            dns_options={
                "local_resolvers": [resolver],
                "local_domains": ["lan"],
            },
        )
    assert captured.value.code == "dns_resolver_loop"


def test_mihomo_dns_allows_loopback_resolver_on_an_explicit_non_dns_port():
    content, _ = dns.build_enabled_config(
        BASE,
        dns_options={
            "local_resolvers": ["127.0.0.1:41100"],
            "local_domains": ["lan"],
        },
    )
    assert "- '127.0.0.1:41100'" in content


def test_mihomo_dns_rejects_the_router_lan_address_on_port_53(monkeypatch):
    monkeypatch.setattr(dns, "_address_is_ours", lambda _address: True)

    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.build_enabled_config(
            BASE,
            dns_options={
                "local_resolvers": ["192.168.1.1"],
                "local_domains": ["lan"],
            },
        )

    assert captured.value.code == "dns_resolver_loop"


def test_mihomo_dns_custom_policy_replaces_duplicate_fake_ip_policy_key():
    content, _ = dns.build_enabled_config(
        BASE,
        mode="fake-ip",
        dns_options={
            "direct_resolvers": ["https://9.9.9.9/dns-query"],
            "direct_domains": ["rule-set:category_ru@domain"],
        },
    )
    assert content.count("'rule-set:category_ru@domain':") == 1
    assert "- 'https://9.9.9.9/dns-query#DIRECT'" in content


def test_build_refuses_existing_user_dns_without_rewriting_it():
    source = BASE + "\ndns:\n  enable: true\n  nameserver: [system]\n"

    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.build_enabled_config(source)

    assert captured.value.code == "dns_conflict"


def test_soft_release_disables_only_the_dns_switch():
    source = BASE + """
dns:
  enable: true # chosen by user
  listen: 0.0.0.0:53
  nameserver:
    - https://resolver.example/dns-query
"""

    parked, changed = dns._with_dns_disabled(source)

    assert changed is True
    assert "  enable: false # chosen by user" in parked
    assert "  listen: 0.0.0.0:53" in parked
    assert "https://resolver.example/dns-query" in parked
    assert parked.replace("enable: false", "enable: true") == source


def test_proxy_group_selection_uses_first_real_group_as_fallback():
    source = BASE.replace("Заблок. сервисы", "Мой маршрут")
    content, group = dns.build_enabled_config(source)

    assert group == "Мой маршрут"
    assert "#Мой маршрут&name-cert-verify=dns.google" in content


def test_geodata_status_warns_when_private_source_is_missing():
    result = dns._geodata_runtime_config(BASE)

    assert result["private_available"] is False
    assert "geosite:private" in result["notice"]
    assert "v2fly/domain-list-community" in result["notice"]


def test_geodata_status_detects_domain_private_provider():
    source = BASE + """
rule-providers:
  geosite-private:
    type: http
    behavior: domain
    format: mrs
    url: https://example.invalid/private.mrs
"""

    result = dns._geodata_runtime_config(source)

    assert result["private_provider"] == "geosite-private"
    assert result["private_filter"] == "rule-set:geosite-private"
    assert result["private_available"] is True


def test_geodata_status_detects_v2fly_geox_url():
    source = BASE + """
geodata-mode: true
geox-url:
  geosite: https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat
"""

    result = dns._geodata_runtime_config(source)

    assert result["enabled"] is True
    assert result["geosite_url"].endswith("/dlc.dat")
    assert result["private_filter"] == "geosite:private"


def test_geodata_status_requires_explicit_mode_with_geox_url():
    source = BASE + """
geox-url:
  geosite: https://example.invalid/geosite.dat
"""

    result = dns._geodata_runtime_config(source)

    assert result["private_available"] is False
    assert "geodata-mode: true" in result["notice"]


def _status_ready(tmp_path: Path, monkeypatch):
    config = tmp_path / "config.yaml"
    config.write_text(BASE, encoding="utf-8")
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setattr(dns, "detect_running_core", lambda: "mihomo")
    monkeypatch.setattr(dns, "_mihomo_selected_for_restart", lambda: True)
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    return config, state


def test_status_exposes_safe_one_click_plan(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)

    result = dns.get_status(config_file=str(config), ui_state_dir=str(state))

    assert result["can_enable"] is True
    assert result["proxy_group"] == "Заблок. сервисы"
    assert result["dns_selector"] == {
        "enabled": False,
        "name": "DNS Proxy",
        "icon": "https://img.icons8.com/fluency/96/dns.png",
        "upstream": "Заблок. сервисы",
        "can_create": True,
        "conflict": False,
        "missing": False,
    }
    assert result["listen"] == "0.0.0.0:53"
    assert result["mode"] == "redir-host"
    assert result["safety"] == {
        "preflight": True,
        "backup": True,
        "rollback": True,
        "dns_probe": True,
        "routed_doh": True,
    }


def test_status_exposes_the_live_xkeen_fake_ip_exclusion(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    init_script = tmp_path / "S05xkeen"
    init_script.write_text(XKEEN_INIT_LEGACY, encoding="utf-8", newline="\n")
    init_script.chmod(0o755)
    monkeypatch.setattr(dns, "resolve_xkeen_init_script", lambda: str(init_script))
    legacy = XKEEN_MANGLE_OK.replace(
        "-A xkeen -p udp",
        "-A xkeen -d 198.18.0.0/15 -m comment --comment xkeen_rule -j RETURN\n-A xkeen -p udp",
    )
    _fake_ip_firewall(monkeypatch, mangle=legacy)

    result = dns.get_status(config_file=str(config), ui_state_dir=str(state))

    assert result["fake_ip_available"] is False
    assert result["fake_ip_route"]["confidence"] == "blocked"
    assert result["fake_ip_route"]["network"] == "198.18.0.0/16"
    assert "правило RETURN для 198.18.0.0/15" in result["fake_ip_route"]["message"]
    assert result["fake_ip_repair"]["needed"] is True
    assert result["fake_ip_repair"]["can_repair"] is True
    assert result["fake_ip_repair"]["requires_confirmation"] is True


def test_existing_user_dns_can_be_returned_to_keenetic_without_a_snapshot(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    config.write_text(BASE + "\ndns:\n  enable: true\n  listen: 0.0.0.0:53\n", encoding="utf-8")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    result = dns.get_status(config_file=str(config), ui_state_dir=str(state))

    assert result["enabled"] is True
    assert result["dns_listener_configured"] is True
    assert result["can_enable"] is False
    assert result["can_release"] is True
    assert any("пользовательский DNS Mihomo" in message for message in result["blockers"])


def test_enable_validates_saves_switches_restarts_and_probes(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    calls: list[object] = []
    override = {"value": False}

    monkeypatch.setattr(dns, "_dns_override_status", lambda: (override["value"], "test"))
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: (calls.append(("override", enabled)), override.update(value=enabled)))
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda **kwargs: calls.append(("port", kwargs["should_be_free"])) or True)
    monkeypatch.setattr(dns, "_wait_for_mihomo", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda: {"ok": True, "latency_ms": 42})

    def validate_config(*, new_content):
        calls.append(("validate", new_content))
        return "[exit code: 0]"

    def save_config(content):
        calls.append(("save", content))
        config.write_text(content, encoding="utf-8")
        return type("Backup", (), {"filename": "before.yaml"})()

    result = dns.apply_action(
        "enable",
        config_file=str(config),
        ui_state_dir=str(state),
        validate_config=validate_config,
        save_config=save_config,
        restart_xkeen=lambda **kwargs: calls.append(("restart", kwargs["source"])) or True,
    )

    assert result["ok"] is True
    assert result["enabled"] is True
    assert dns.MANAGED_BEGIN in config.read_text(encoding="utf-8")
    assert calls[0][0] == "validate"
    assert [item[0] for item in calls] == ["validate", "save", "override", "port", "restart", "port"]
    assert calls[3] == ("port", True)
    assert calls[5] == ("port", False)
    saved_state = json.loads((state / "mihomo-dns" / dns.STATE_FILENAME).read_text(encoding="utf-8"))
    assert saved_state["proxy_group"] == "Заблок. сервисы"
    assert Path(saved_state["original_config"]).read_text(encoding="utf-8") == BASE


def test_enable_probe_failure_rolls_back_config_and_dns_override(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    calls: list[object] = []
    override = {"value": False}

    monkeypatch.setattr(dns, "_dns_override_status", lambda: (override["value"], "test"))
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: (calls.append(("override", enabled)), override.update(value=enabled)))
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda **_kwargs: True)
    monkeypatch.setattr(dns, "_wait_for_mihomo", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda: {"ok": False, "error": "timeout"})

    def save_config(content):
        calls.append(("save", content))
        config.write_text(content, encoding="utf-8")
        return type("Backup", (), {"filename": "before.yaml"})()

    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.apply_action(
            "enable",
            config_file=str(config),
            ui_state_dir=str(state),
            validate_config=lambda **_kwargs: "[exit code: 0]",
            save_config=save_config,
            restart_xkeen=lambda **kwargs: calls.append(("restart", kwargs["source"])) or True,
        )

    assert captured.value.code == "dns_probe_failed"
    assert config.read_text(encoding="utf-8") == BASE
    assert override["value"] is False
    assert calls[-3:] == [("save", BASE), ("override", False), ("restart", "mihomo-dns-rollback")]


def test_enable_persists_the_optional_dns_selector_state(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    override = {"value": False}
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (override["value"], "test"))
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: override.update(value=enabled))
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda **_kwargs: True)
    monkeypatch.setattr(dns, "_wait_for_mihomo", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda: {"ok": True, "latency_ms": 3})

    def save_config(content):
        config.write_text(content, encoding="utf-8")
        return type("Backup", (), {"filename": "before.yaml"})()

    result = dns.apply_action(
        "enable",
        config_file=str(config),
        ui_state_dir=str(state),
        validate_config=lambda **_kwargs: "[exit code: 0]",
        save_config=save_config,
        restart_xkeen=lambda **_kwargs: True,
        dns_selector=True,
    )

    saved_state = json.loads((state / "mihomo-dns" / dns.STATE_FILENAME).read_text(encoding="utf-8"))
    assert saved_state["dns_selector"] == {
        "enabled": True,
        "name": "DNS Proxy",
        "upstream": "Заблок. сервисы",
    }
    assert result["dns_selector"] == saved_state["dns_selector"]
    assert "name: 'DNS Proxy'" in config.read_text(encoding="utf-8")
    status = dns.get_status(config_file=str(config), ui_state_dir=str(state))
    assert status["dns_selector"]["enabled"] is True
    assert status["dns_selector"]["upstream"] == "Заблок. сервисы"


def test_fake_ip_enable_stops_before_writing_when_xkeen_excludes_range(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    legacy = XKEEN_MANGLE_OK.replace(
        "-A xkeen -p udp",
        "-A xkeen -d 198.18.0.0/15 -m comment --comment xkeen_rule -j RETURN\n-A xkeen -p udp",
    )
    _fake_ip_firewall(monkeypatch, mangle=legacy)
    calls: list[str] = []

    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.apply_action(
            "enable",
            config_file=str(config),
            ui_state_dir=str(state),
            validate_config=lambda **_kwargs: calls.append("validate") or "[exit code: 0]",
            save_config=lambda _content: calls.append("save"),
            restart_xkeen=lambda **_kwargs: calls.append("restart") or True,
            mode="fake-ip",
            fake_ip={"range": "198.18.0.1/16", "filters": ["*.lan"]},
        )

    assert captured.value.code == "fake_ip_firewall_excluded"
    assert captured.value.details["firewall"]["exclusion"] == "198.18.0.0/15"
    assert calls == []
    assert config.read_text(encoding="utf-8") == BASE


def test_fake_ip_enable_requires_explicit_repair_confirmation(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    init_script = tmp_path / "S05xkeen"
    init_script.write_text(XKEEN_INIT_LEGACY, encoding="utf-8", newline="\n")
    init_script.chmod(0o755)
    _live_fake_ip_firewall(monkeypatch, init_script)
    calls: list[str] = []

    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.apply_action(
            "enable",
            config_file=str(config),
            ui_state_dir=str(state),
            validate_config=lambda **_kwargs: calls.append("validate") or "[exit code: 0]",
            save_config=lambda _content: calls.append("save"),
            restart_xkeen=lambda **_kwargs: calls.append("restart") or True,
            mode="fake-ip",
            fake_ip={"range": "198.18.0.1/16", "filters": ["*.lan"]},
        )

    assert captured.value.code == "fake_ip_repair_confirmation_required"
    assert captured.value.details["repair"]["can_repair"] is True
    assert calls == []
    assert init_script.read_text(encoding="utf-8") == XKEEN_INIT_LEGACY
    assert config.read_text(encoding="utf-8") == BASE


def test_fake_ip_enable_repairs_legacy_exclusion_then_activates(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    init_script = tmp_path / "S05xkeen"
    init_script.write_text(XKEEN_INIT_LEGACY, encoding="utf-8", newline="\n")
    init_script.chmod(0o755)
    original_mode = stat.S_IMODE(init_script.stat().st_mode)
    _live_fake_ip_firewall(monkeypatch, init_script)
    override = {"value": False}
    calls: list[object] = []
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (override["value"], "test"))
    monkeypatch.setattr(dns, "_set_dns_override", lambda value: (calls.append(("override", value)), override.update(value=value)))
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda **kwargs: calls.append(("port", kwargs["should_be_free"])) or True)
    monkeypatch.setattr(dns, "_wait_for_mihomo", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda: {"ok": True, "latency_ms": 7})

    def save_config(content):
        calls.append(("save", content))
        config.write_text(content, encoding="utf-8")
        return type("Backup", (), {"filename": "before.yaml"})()

    result = dns.apply_action(
        "enable",
        config_file=str(config),
        ui_state_dir=str(state),
        validate_config=lambda **_kwargs: "[exit code: 0]",
        save_config=save_config,
        restart_xkeen=lambda **kwargs: calls.append(("restart", kwargs["source"])) or True,
        mode="fake-ip",
        fake_ip={"range": "198.18.0.1/16", "filters": ["*.lan"]},
        repair_legacy_exclusion=True,
    )

    assert result["ok"] is True
    assert result["mode"] == "fake-ip"
    assert result["fake_ip_route"]["available"] is True
    assert result["xkeen_repair"]["applied"] is True
    assert Path(result["xkeen_repair"]["backup"]).read_text(encoding="utf-8") == XKEEN_INIT_LEGACY
    assert dns.LEGACY_FAKE_IP_EXCLUSION not in init_script.read_text(encoding="utf-8")
    assert stat.S_IMODE(init_script.stat().st_mode) == original_mode
    assert [item for item in calls if item[0] == "restart"] == [
        ("restart", "mihomo-dns-fake-ip-repair"),
        ("restart", "mihomo-dns"),
    ]
    saved_state = json.loads((state / "mihomo-dns" / dns.STATE_FILENAME).read_text(encoding="utf-8"))
    assert saved_state["xkeen_repair"]["backup"] == result["xkeen_repair"]["backup"]


def test_fake_ip_enable_restores_xkeen_script_when_later_probe_fails(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    init_script = tmp_path / "S05xkeen"
    init_script.write_text(XKEEN_INIT_LEGACY, encoding="utf-8", newline="\n")
    init_script.chmod(0o755)
    _live_fake_ip_firewall(monkeypatch, init_script)
    override = {"value": False}
    calls: list[object] = []
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (override["value"], "test"))
    monkeypatch.setattr(dns, "_set_dns_override", lambda value: override.update(value=value))
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda **_kwargs: True)
    monkeypatch.setattr(dns, "_wait_for_mihomo", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda: {"ok": False, "error": "timeout"})

    def save_config(content):
        config.write_text(content, encoding="utf-8")
        return type("Backup", (), {"filename": "before.yaml"})()

    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.apply_action(
            "enable",
            config_file=str(config),
            ui_state_dir=str(state),
            validate_config=lambda **_kwargs: "[exit code: 0]",
            save_config=save_config,
            restart_xkeen=lambda **kwargs: calls.append(("restart", kwargs["source"])) or True,
            mode="fake-ip",
            fake_ip={"range": "198.18.0.1/16", "filters": ["*.lan"]},
            repair_legacy_exclusion=True,
        )

    assert captured.value.code == "dns_probe_failed"
    assert config.read_text(encoding="utf-8") == BASE
    assert init_script.read_text(encoding="utf-8") == XKEEN_INIT_LEGACY
    assert override["value"] is False
    assert calls == [
        ("restart", "mihomo-dns-fake-ip-repair"),
        ("restart", "mihomo-dns"),
        ("restart", "mihomo-dns-rollback"),
    ]


def test_fake_ip_repair_restart_failure_restores_script_before_dns_write(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    init_script = tmp_path / "S05xkeen"
    init_script.write_text(XKEEN_INIT_LEGACY, encoding="utf-8", newline="\n")
    _live_fake_ip_firewall(monkeypatch, init_script)
    calls: list[object] = []

    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.apply_action(
            "enable",
            config_file=str(config),
            ui_state_dir=str(state),
            validate_config=lambda **_kwargs: "[exit code: 0]",
            save_config=lambda _content: calls.append("save"),
            restart_xkeen=lambda **kwargs: calls.append(("restart", kwargs["source"])) or kwargs["source"].endswith("rollback"),
            mode="fake-ip",
            fake_ip={"range": "198.18.0.1/16", "filters": ["*.lan"]},
            repair_legacy_exclusion=True,
        )

    assert captured.value.code == "fake_ip_repair_restart_failed"
    assert captured.value.rolled_back is True
    assert init_script.read_text(encoding="utf-8") == XKEEN_INIT_LEGACY
    assert config.read_text(encoding="utf-8") == BASE
    assert calls == [
        ("restart", "mihomo-dns-fake-ip-repair"),
        ("restart", "mihomo-dns-rollback"),
    ]


def test_disable_restores_exact_snapshot_then_firmware_dns(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    prepared, group = dns.build_enabled_config(BASE)
    config.write_text(prepared, encoding="utf-8")
    snapshot = tmp_path / "before.yaml"
    snapshot.write_text(BASE, encoding="utf-8")
    dns._save_state(str(state), str(config), {
        "original_config": str(snapshot),
        "original_sha256": dns._sha256(BASE),
        "applied_sha256": dns._sha256(prepared),
        "original_dns_override": False,
        "proxy_group": group,
    })
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))
    monkeypatch.setattr(dns, "_wait_for_mihomo", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda **_kwargs: True)
    calls: list[object] = []
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: calls.append(("override", enabled)))

    def save_config(content):
        calls.append(("save", content))
        config.write_text(content, encoding="utf-8")
        return type("Backup", (), {"filename": "managed.yaml"})()

    result = dns.apply_action(
        "disable",
        config_file=str(config),
        ui_state_dir=str(state),
        validate_config=lambda **_kwargs: "[exit code: 0]",
        save_config=save_config,
        restart_xkeen=lambda **kwargs: calls.append(("restart", kwargs["source"])) or True,
    )

    assert result["restored"] is True
    assert config.read_text(encoding="utf-8") == BASE
    assert calls == [("save", BASE), ("restart", "mihomo-dns"), ("override", False)]
    assert not (state / "mihomo-dns" / dns.STATE_FILENAME).exists()


def test_tampering_stops_automatic_disable(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    prepared, group = dns.build_enabled_config(BASE)
    config.write_text(prepared + "# user edit\n", encoding="utf-8")
    snapshot = tmp_path / "before.yaml"
    snapshot.write_text(BASE, encoding="utf-8")
    dns._save_state(str(state), str(config), {
        "original_config": str(snapshot),
        "original_sha256": dns._sha256(BASE),
        "applied_sha256": dns._sha256(prepared),
        "proxy_group": group,
    })
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    status = dns.get_status(config_file=str(config), ui_state_dir=str(state))

    assert status["tampered"] is True
    assert status["can_disable"] is False
    assert status["can_release"] is True


def test_soft_release_preserves_an_edited_dns_block_and_returns_firmware_dns(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    prepared, group = dns.build_enabled_config(BASE)
    edited = prepared.replace("prefer-h3: false", "prefer-h3: true") + "# user's routing edit\n"
    config.write_text(edited, encoding="utf-8")
    snapshot = tmp_path / "before.yaml"
    snapshot.write_text(BASE, encoding="utf-8")
    dns._save_state(str(state), str(config), {
        "enabled": True,
        "original_config": str(snapshot),
        "original_sha256": dns._sha256(BASE),
        "applied_sha256": dns._sha256(prepared),
        "original_dns_override": False,
        "proxy_group": group,
    })
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda **_kwargs: True)
    calls: list[object] = []
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: calls.append(("override", enabled)))

    def save_config(content):
        calls.append(("save", content))
        config.write_text(content, encoding="utf-8")
        return type("Backup", (), {"filename": "edited.yaml"})()

    result = dns.apply_action(
        "release",
        config_file=str(config),
        ui_state_dir=str(state),
        validate_config=lambda **kwargs: calls.append(("validate", kwargs["new_content"])) or "[exit code: 0]",
        save_config=save_config,
        restart_xkeen=lambda **kwargs: calls.append(("restart", kwargs["source"])) or True,
    )

    parked = config.read_text(encoding="utf-8")
    assert result["released"] is True
    assert result["dns_block_preserved"] is True
    assert "  enable: false" in parked
    assert "prefer-h3: true" in parked
    assert "# user's routing edit" in parked
    assert BASE != parked
    assert calls[-3][0] == "save"
    assert calls[-2] == ("restart", "mihomo-dns-soft-release")
    assert calls[-1] == ("override", False)
    assert not (state / "mihomo-dns" / dns.STATE_FILENAME).exists()
    trace = dns.read_release(config_file=str(config), ui_state_dir=str(state))
    assert trace and trace["source"] == "user"


def test_soft_release_rolls_the_file_back_when_mihomo_cannot_restart(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    prepared, group = dns.build_enabled_config(BASE)
    edited = prepared + "# keep this user edit\n"
    config.write_text(edited, encoding="utf-8")
    snapshot = tmp_path / "before.yaml"
    snapshot.write_text(BASE, encoding="utf-8")
    dns._save_state(str(state), str(config), {
        "enabled": True,
        "original_config": str(snapshot),
        "original_sha256": dns._sha256(BASE),
        "applied_sha256": dns._sha256(prepared),
        "original_dns_override": False,
        "proxy_group": group,
    })
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))
    overrides: list[bool] = []
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: overrides.append(enabled))
    restarts: list[str] = []

    def save_config(content):
        config.write_text(content, encoding="utf-8")
        return type("Backup", (), {"filename": "edited.yaml"})()

    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.apply_action(
            "release",
            config_file=str(config),
            ui_state_dir=str(state),
            validate_config=lambda **_kwargs: "[exit code: 0]",
            save_config=save_config,
            restart_xkeen=lambda **kwargs: restarts.append(kwargs["source"]) or kwargs["source"].endswith("rollback"),
        )

    assert captured.value.code == "dns_soft_release_restart_failed"
    assert config.read_text(encoding="utf-8") == edited
    assert overrides == []
    assert restarts == ["mihomo-dns-soft-release", "mihomo-dns-soft-release-rollback"]
    assert (state / "mihomo-dns" / dns.STATE_FILENAME).exists()


def test_manually_edited_config_keeps_runtime_dns_status_without_managed_comments(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    prepared, group = dns.build_enabled_config(BASE)
    # A formatter/manual save can remove comments and change unrelated YAML
    # while retaining the complete DNS mapping created by the assistant.
    edited = prepared.replace(dns.MANAGED_BEGIN + "\n", "").replace(dns.MANAGED_END + "\n", "")
    edited += "# user's later routing edit\n"
    config.write_text(edited, encoding="utf-8")
    snapshot = tmp_path / "before.yaml"
    snapshot.write_text(BASE, encoding="utf-8")
    dns._save_state(str(state), str(config), {
        "original_config": str(snapshot),
        "original_sha256": dns._sha256(BASE),
        "applied_sha256": dns._sha256(prepared),
        "original_dns_override": False,
        "proxy_group": group,
    })
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    status = dns.get_status(config_file=str(config), ui_state_dir=str(state))

    assert status["enabled"] is True
    assert status["dns_present"] is True
    assert status["dns_enabled"] is True
    assert status["dns_listener_configured"] is True
    assert status["listen"] == "0.0.0.0:53"
    assert status["tampered"] is True
    assert status["prepared"] is False
    assert status["can_disable"] is False


def test_removed_dns_block_can_clear_stale_state_without_restoring_snapshot(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    prepared, group = dns.build_enabled_config(BASE)
    config.write_text(BASE, encoding="utf-8")
    snapshot = tmp_path / "before.yaml"
    snapshot.write_text(BASE + "# before enable\n", encoding="utf-8")
    dns._save_state(str(state), str(config), {
        "original_config": str(snapshot),
        "original_sha256": dns._sha256(snapshot.read_text(encoding="utf-8")),
        "applied_sha256": dns._sha256(prepared),
        "original_dns_override": False,
        "proxy_group": group,
    })
    calls: list[object] = []
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns, "_wait_for_core", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda **_kwargs: True)

    status = dns.get_status(config_file=str(config), ui_state_dir=str(state))
    assert status["tampered"] is True
    assert status["can_disable"] is False
    assert status["can_recover"] is True

    result = dns.apply_action(
        "disable",
        config_file=str(config),
        ui_state_dir=str(state),
        validate_config=lambda **kwargs: calls.append(("validate", kwargs["new_content"])) or "[exit code: 0]",
        save_config=lambda content: calls.append(("save", content)) or type("Backup", (), {"filename": "current.yaml"})(),
        restart_xkeen=lambda **kwargs: calls.append(("restart", kwargs["source"])) or True,
    )

    assert result["recovered"] is True
    assert result["preserved_current"] is True
    assert config.read_text(encoding="utf-8") == BASE
    assert calls == [("validate", BASE), ("save", BASE), ("restart", "mihomo-dns-recover")]
    assert not (state / "mihomo-dns" / dns.STATE_FILENAME).exists()


def test_http_contract_and_frontend(tmp_path: Path, monkeypatch):
    import routes.mihomo as mihomo_routes
    from routes.mihomo import create_mihomo_blueprint

    config, state = _status_ready(tmp_path, monkeypatch)
    monkeypatch.setattr(mihomo_routes, "get_mihomo_dns_status", dns.get_status)
    app = Flask("mihomo-dns")
    app.register_blueprint(create_mihomo_blueprint(
        MIHOMO_CONFIG_FILE=str(config),
        MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
        MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "templates" / "default.yaml"),
        restart_xkeen=lambda **_kwargs: True,
        ui_state_dir=str(state),
    ))

    response = app.test_client().get("/api/mihomo/dns")
    assert response.status_code == 200
    assert response.get_json()["can_enable"] is True

    root = Path(__file__).resolve().parents[1]
    template = (root / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
    script = (root / "xkeen-ui/static/js/features/mihomo_dns.js").read_text(encoding="utf-8")
    bundle = (root / "xkeen-ui/static/js/pages/panel.mihomo.bundle.js").read_text(encoding="utf-8")
    assert 'id="mihomo-dns-btn"' in template
    assert 'id="mihomo-dns-modal"' in template
    assert 'id="mihomo-dns-selector-enable"' in template
    assert "Создать переключатель DNS Proxy" in template
    assert "Mihomo preflight" in template
    assert "Полный снимок" in template
    assert "Автооткат" in template
    assert "один <code>no opkg dns-override</code> не отключает слушатель Mihomo" in template
    assert "Keenetic автоматически направляет запросы в Mihomo" in template
    assert "192.168.1.1:1054" not in template
    assert "'/api/mihomo/dns'" in script
    assert "Включить защищённый DNS" in script
    assert "Вернуть DNS Keenetic" in script
    assert "const action = softRelease ? 'release'" in script
    assert "geosite:category-ru" in script
    assert "TUN/TProxy обнаружен" not in script
    assert "Маршрут Fake-IP через TUN/TProxy не подтверждён" in script
    assert "dns_selector: !!$(IDS.dnsSelectorEnable)?.checked" in script
    assert "repair_legacy_exclusion = true" in script
    assert "Исправить и включить Fake-IP" in script
    assert "mihomo_dns.js" in bundle


def test_http_contract_forwards_rule_providers(tmp_path: Path, monkeypatch):
    import routes.mihomo as mihomo_routes
    from routes.mihomo import create_mihomo_blueprint

    config, state = _status_ready(tmp_path, monkeypatch)
    monkeypatch.setattr(mihomo_routes, "get_mihomo_dns_status", dns.get_status)
    captured: dict[str, object] = {}

    def fake_apply(action, **kwargs):
        captured["action"] = action
        captured.update(kwargs)
        return {"ok": True, "enabled": True, "probe": {"ok": True, "latency_ms": 1}}

    monkeypatch.setattr(mihomo_routes, "apply_mihomo_dns_action", fake_apply)
    app = Flask("mihomo-dns")
    app.register_blueprint(create_mihomo_blueprint(
        MIHOMO_CONFIG_FILE=str(config),
        MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
        MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "templates" / "default.yaml"),
        restart_xkeen=lambda **_kwargs: True,
        ui_state_dir=str(state),
    ))

    response = app.test_client().post("/api/mihomo/dns", json={
        "confirmed": True,
        "action": "enable",
        "mode": "fake-ip",
        "geodata": False,
        "fake_ip": {"range": "198.18.0.1/16", "filter_mode": "blacklist", "filters": ["*.lan"]},
        "rule_providers": ["category_ru@domain", "private"],
        "dns_selector": True,
        "repair_legacy_exclusion": True,
    })

    assert response.status_code == 200
    assert captured["action"] == "enable"
    assert captured["rule_providers"] == ["category_ru@domain", "private"]
    assert captured["geodata"] is False
    assert captured["dns_selector"] is True
    assert captured["repair_legacy_exclusion"] is True


def test_http_contract_forwards_portable_dns_options(tmp_path: Path, monkeypatch):
    import routes.mihomo as mihomo_routes
    from routes.mihomo import create_mihomo_blueprint

    config, state = _status_ready(tmp_path, monkeypatch)
    monkeypatch.setattr(mihomo_routes, "get_mihomo_dns_status", dns.get_status)
    captured: dict[str, object] = {}

    def fake_apply(action, **kwargs):
        captured.update(kwargs)
        return {"ok": True, "enabled": True}

    monkeypatch.setattr(mihomo_routes, "apply_mihomo_dns_action", fake_apply)
    app = Flask("mihomo-dns-options")
    app.register_blueprint(create_mihomo_blueprint(
        MIHOMO_CONFIG_FILE=str(config),
        MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
        MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "templates" / "default.yaml"),
        restart_xkeen=lambda **_kwargs: True,
        ui_state_dir=str(state),
    ))

    response = app.test_client().post("/api/mihomo/dns", json={
        "confirmed": True,
        "action": "enable",
        "dns_options": {
            "tunnel": ["https://9.9.9.9/dns-query"],
            "local_resolvers": ["192.168.1.1"],
            "local_domains": ["lan"],
        },
    })

    assert response.status_code == 200
    assert captured["dns_options"]["tunnel"] == ["https://9.9.9.9/dns-query"]
