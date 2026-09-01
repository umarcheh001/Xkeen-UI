from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict

import pytest
from flask import Flask

from services import dns_over_vless as dns


@pytest.fixture(autouse=True)
def _isolate_jsonc_sidecars(monkeypatch):
    monkeypatch.setattr(dns, "jsonc_path_for", lambda path: str(path) + "c")


def _write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _base_config(tmp_path: Path) -> tuple[Path, Path, Path]:
    configs = tmp_path / "configs"
    state = tmp_path / "state"
    configs.mkdir()
    state.mkdir()
    _write(
        configs / "03_inbounds.json",
        {"inbounds": [{"tag": "tproxy", "port": 61219, "protocol": "dokodemo-door"}]},
    )
    _write(
        configs / "04_outbounds.json",
        {
            "outbounds": [
                {"tag": "direct", "protocol": "freedom"},
                {"tag": "proxy-a", "protocol": "vless"},
                {"tag": "proxy-b", "protocol": "vless"},
            ]
        },
    )
    routing = configs / "05_routing.json"
    _write(
        routing,
        {
            "routing": {
                "rules": [{"type": "field", "outboundTag": "direct", "network": "tcp,udp"}],
                "balancers": [
                    {
                        "tag": "proxy",
                        "selector": ["proxy-a", "proxy-b"],
                        "strategy": {"type": "leastPing"},
                        "fallbackTag": "direct",
                    }
                ],
            }
        },
    )
    return configs, routing, state


def test_enable_plan_is_additive_and_dns_balancer_is_fail_closed(tmp_path: Path):
    configs, routing_path, _state = _base_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)
    target = dns._select_target(runtime, "proxy")
    planned = dns._build_enabled_routing(routing, target)

    assert target["kind"] == "balancer"
    assert target["tag"] == dns.BALANCER_TAG
    assert "fallbackTag" not in target["managed_balancer"]
    assert planned["routing"]["rules"][0] == {
        "type": "field",
        "inboundTag": [dns.DNS_IN_TAG],
        "ruleTag": dns.PROXY_RULE_TAG,
        "balancerTag": dns.BALANCER_TAG,
    }
    assert planned["routing"]["rules"][1]["port"] == "53"
    assert planned["routing"]["rules"][2] == routing["routing"]["rules"][0]
    assert planned["routing"]["balancers"][0] == routing["routing"]["balancers"][0]


def test_disable_removes_only_managed_objects(tmp_path: Path):
    configs, routing_path, _state = _base_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    target = dns._select_target(dns._collect_runtime(str(configs), routing), "proxy")
    enabled = dns._build_enabled_routing(routing, target)
    restored = dns._build_disabled_routing(enabled)

    assert restored == routing


def test_conflict_detection_refuses_existing_dns_configuration(tmp_path: Path):
    configs, routing_path, _state = _base_config(tmp_path)
    _write(configs / "02_dns.json", {"dns": {"servers": ["1.1.1.1"]}})
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    routing["routing"]["rules"].insert(0, {"port": 53, "outboundTag": "direct"})
    runtime = dns._collect_runtime(str(configs), routing)

    conflicts = dns._conflicts(runtime, routing)

    assert any("DNS-блок" in item for item in conflicts)
    assert any("port 53" in item for item in conflicts)


def test_runtime_routing_json_wins_over_stale_jsonc_sidecar(tmp_path: Path):
    configs, routing_path, _state = _base_config(tmp_path)
    stale = {
        "routing": {
            "balancers": [{"tag": "proxy", "selector": ["missing-prefix"]}],
            "rules": [],
        }
    }
    _write(Path(str(routing_path) + "c"), stale)

    routing, _raw = dns._read_routing_with_raw(str(routing_path))
    target = dns._select_target(dns._collect_runtime(str(configs), routing), "proxy")

    assert target["source"] == "proxy"


def test_status_requires_xray_and_exposes_safety_guards(tmp_path: Path, monkeypatch):
    configs, routing, state = _base_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "mihomo")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))

    result = dns.get_status(configs_dir=str(configs), routing_file=str(routing), ui_state_dir=str(state))

    assert result["enabled"] is False
    assert result["can_enable"] is False
    assert any("активное ядро" in item for item in result["blockers"])
    assert result["safety"] == {
        "preflight": True,
        "backup": True,
        "rollback": True,
        "dns_probe": True,
        "fail_closed": True,
    }


def test_apply_rolls_back_files_and_router_setting_after_probe_failure(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _base_config(tmp_path)
    before = routing_path.read_bytes()
    calls: list[object] = []
    override = {"value": False}

    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (override["value"], "test"))
    monkeypatch.setattr(dns, "_stage_and_test", lambda *_args, **_kwargs: {"ok": True})
    monkeypatch.setattr(dns, "_wait_for_xray", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda *_args, **_kwargs: {"ok": False, "error": "timeout"})
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj, **_kwargs: _write(Path(path), obj))

    def set_override(enabled: bool) -> None:
        calls.append(enabled)
        override["value"] = enabled

    monkeypatch.setattr(dns, "_set_dns_override", set_override)

    try:
        dns.apply_action(
            "enable",
            configs_dir=str(configs),
            routing_file=str(routing_path),
            ui_state_dir=str(state),
            restart_xkeen=lambda **kwargs: calls.append(kwargs.get("source")) or True,
            target_tag="proxy",
        )
        raise AssertionError("expected probe failure")
    except dns.DnsOverVlessError as exc:
        assert exc.code == "dns_probe_failed"

    assert routing_path.read_bytes() == before
    assert not (configs / dns.MANAGED_FRAGMENT).exists()
    assert override["value"] is False
    assert calls == [True, "dns-over-vless", False, "dns-over-vless-rollback"]


def test_disable_restores_firmware_dns_only_after_xray_restart(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _base_config(tmp_path)
    target = dns._select_target(
        dns._collect_runtime(str(configs), json.loads(routing_path.read_text(encoding="utf-8"))),
        "proxy",
    )
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment())
    _write(routing_path, dns._build_enabled_routing(json.loads(routing_path.read_text(encoding="utf-8")), target))
    _write(state / dns.STATE_FILENAME, {"enabled": True, "original_dns_override": False})
    calls: list[object] = []

    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))
    monkeypatch.setattr(dns, "_stage_and_test", lambda *_args, **_kwargs: {"ok": True})
    monkeypatch.setattr(dns, "_wait_for_xray", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda **kwargs: calls.append(("port", kwargs["should_be_free"])) or True)
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: calls.append(("override", enabled)))
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj, **_kwargs: _write(Path(path), obj))

    result = dns.apply_action(
        "disable",
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **kwargs: calls.append(("restart", kwargs.get("source"))) or True,
    )

    assert result["ok"] is True
    assert calls == [
        ("restart", "dns-over-vless"),
        ("override", False),
        ("port", False),
    ]


def test_partial_managed_config_can_be_disabled_from_status(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _base_config(tmp_path)
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment())
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    result = dns.get_status(configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state))

    assert result["enabled"] is False
    assert result["partial"] is True
    assert result["can_enable"] is False
    assert result["can_disable"] is True


def test_tampered_managed_rule_is_not_automatically_removed(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _base_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    routing["routing"]["rules"].insert(
        0,
        {"type": "field", "ruleTag": dns.PROXY_RULE_TAG, "outboundTag": "direct"},
    )
    _write(routing_path, routing)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))

    result = dns.get_status(configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state))

    assert result["tampered"] is True
    assert result["can_disable"] is False
    assert any("изменены вручную" in item for item in result["blockers"])


def test_http_contract_returns_guarded_status(tmp_path: Path, monkeypatch):
    from routes.routing import dns_over_vless as dns_routes

    configs, routing, state = _base_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns_routes, "get_status", dns.get_status)
    app = Flask(__name__)
    dns_routes.register_dns_over_vless_routes(
        app,
        xray_configs_dir=str(configs),
        routing_file=str(routing),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_kwargs: True,
    )

    result = app.test_client().get("/api/routing/dns-over-vless")

    assert result.status_code == 200
    payload = result.get_json()
    assert payload["ok"] is True
    assert payload["can_enable"] is True
    assert payload["target"]["source"] == "proxy"


def test_frontend_has_dns_button_modal_and_guard_copy():
    root = Path(__file__).resolve().parents[1]
    template = (root / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
    script = (root / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(encoding="utf-8")

    assert 'id="routing-dns-over-vless-btn"' in template
    assert '<span class="xk-action-label">DNS</span>' in template
    assert 'id="routing-dns-over-vless-modal"' in template
    assert "Xray preflight" in template
    assert "Полный снимок" in template
    assert "Автооткат" in template
    assert "'/api/routing/dns-over-vless'" in script
    assert "Включить безопасно" in script
    assert 'id="routing-dns-over-vless-target"' in template
    assert "Маршрут для DNS-запросов" in template
    assert "renderRoute" in script
    assert 'id="routing-dns-over-vless-route-fallback"' in template
    # The bypass group needs both halves in the markup, plus the button that
    # copies the domains from the routing rules instead of retyping them.
    assert 'id="routing-dns-over-vless-direct"' in template
    assert 'id="routing-dns-over-vless-direct-zones"' in template
    assert 'id="routing-dns-over-vless-direct-from-rules"' in template
    assert "direct_rule_domains" in script
    # The card prints the server's sentence as is: no wrapper written in
    # config language ("Резервирование не переносится: ...") around it.
    assert "plan.reason" in script
    assert "Резервирование сохранено" not in script
    # Про сторожа оба окна говорят одними словами, поэтому тексты — общий модуль.
    guard_copy = (root / "xkeen-ui/static/js/features/dns_guard_text.js").read_text(encoding="utf-8")
    mihomo = (root / "xkeen-ui/static/js/features/mihomo_dns.js").read_text(encoding="utf-8")
    assert "dns_guard_text.js" in script
    assert "dns_guard_text.js" in mihomo
    assert "guardNotice(data, enabled)" in script
    assert "guardNotice(data, enabled)" in mihomo
    assert "Сторож вернул DNS роутеру" in guard_copy
    assert "Сторож следит: проверяет разрешение имён каждые" in guard_copy
    # Ни одна фраза сторожа не называет ядро: механизм у обеих защит один.
    # Комментарии объясняют, откуда взялся модуль, поэтому проверяется код без них.
    guard_code = re.sub(r"/\*.*?\*/", "", guard_copy, flags=re.S)
    guard_code = re.sub(r"//.*", "", guard_code)
    assert "Xray" not in guard_code and "Mihomo" not in guard_code
    # Карточка объясняет состояние словами, а не только цветной меткой.
    assert "describeState" in script
    assert "конфигурация совместима, можно включать" in script
    assert "служебная конфигурация и настройка роутера согласованы" in script
    assert "осталась неполная настройка от прерванной операции" in script
    assert "GUARD_RELEASED_BADGE" in script
    assert 'id="routing-dns-over-vless-multi"' in template
    assert "Балансировать между несколькими прокси" in template
    assert 'id="routing-dns-over-vless-upstreams"' in template
    assert 'id="routing-dns-over-vless-local"' in template
    assert "local_resolver" in script
    assert 'id="routing-dns-over-vless-zones"' in template
    assert "Зоны, которые остаются в локальной сети" in template
    assert 'id="routing-dns-over-vless-zone-presets"' in template
    assert "togglePreset" in script


def _scenario_config(tmp_path: Path):
    """The panel's own mobile-whitelist scenario: three balancers, no ``proxy`` tag."""
    configs = tmp_path / "configs-scenario"
    state = tmp_path / "state-scenario"
    configs.mkdir()
    state.mkdir()
    _write(
        configs / "04_outbounds.json",
        {
            "outbounds": [
                {"tag": "direct", "protocol": "freedom"},
                {
                    "tag": "loopback_to_reserv",
                    "protocol": "loopback",
                    "settings": {"inboundTag": "loopback_to_reserv"},
                },
                {
                    "tag": "loopback_to_white",
                    "protocol": "loopback",
                    "settings": {"inboundTag": "loopback_to_white"},
                },
                {"tag": "my_proxy_1", "protocol": "vless"},
                {"tag": "my_proxy_2", "protocol": "vless"},
                {"tag": "reserve_proxy_1", "protocol": "vless"},
                {"tag": "white_list_1", "protocol": "vless"},
            ]
        },
    )
    routing = configs / "05_routing.json"
    _write(
        routing,
        {
            "routing": {
                "rules": [
                    {
                        "type": "field",
                        "inboundTag": ["loopback_to_reserv"],
                        "balancerTag": "balancer_reserv",
                    },
                    {
                        "type": "field",
                        "inboundTag": ["loopback_to_white"],
                        "balancerTag": "balancer_white_list",
                    },
                    {"type": "field", "outboundTag": "direct", "network": "tcp,udp"},
                ],
                "balancers": [
                    {
                        "tag": "balancer_main",
                        "selector": ["my_proxy"],
                        "strategy": {"type": "leastPing"},
                        "fallbackTag": "loopback_to_reserv",
                    },
                    {
                        "tag": "balancer_reserv",
                        "selector": ["reserve_proxy"],
                        "strategy": {"type": "leastPing"},
                        "fallbackTag": "loopback_to_white",
                    },
                    {
                        "tag": "balancer_white_list",
                        "selector": ["white_list"],
                        "strategy": {"type": "leastPing"},
                    },
                ],
            }
        },
    )
    return configs, routing, state


def test_several_balancers_refuse_to_pick_by_file_order(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)

    try:
        dns._select_target(runtime)
        raise AssertionError("expected an explicit choice to be required")
    except dns.DnsOverVlessError as exc:
        assert exc.code == "target_choice_required"
        tags = [item["tag"] for item in exc.details["candidates"]]
        assert tags[:3] == ["balancer_main", "balancer_reserv", "balancer_white_list"]
        # Loopback and freedom outbounds are never offered as a DNS route.
        assert "direct" not in tags and "loopback_to_reserv" not in tags


def test_chosen_balancer_is_cloned_verbatim(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)

    target = dns._select_target(runtime, "balancer_reserv", routing)

    assert target["source"] == "balancer_reserv"
    assert target["managed_balancer"]["selector"] == ["reserve_proxy"]
    assert target["managed_balancer"]["strategy"] == {"type": "leastPing"}
    # The chain reserve -> loopback -> white list never leaves the proxies, so
    # the user's redundancy is preserved instead of being dropped.
    assert target["managed_balancer"]["fallbackTag"] == "loopback_to_white"
    assert target["fallback"]["kept"] is True
    assert target["fallback"]["verdict"] == "safe"


def test_dead_selector_is_unusable_and_never_swapped_for_an_outbound(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    routing["routing"]["balancers"][0]["selector"] = ["gone_prefix"]
    runtime = dns._collect_runtime(str(configs), routing)

    candidates = dns.list_candidates(runtime)
    broken = next(item for item in candidates if item["tag"] == "balancer_main")
    assert broken["usable"] is False
    assert broken["reason"]

    try:
        dns._select_target(runtime, "balancer_main")
        raise AssertionError("expected the dead balancer to be refused")
    except dns.DnsOverVlessError as exc:
        assert exc.code == "target_unavailable"


def test_status_lists_candidates_and_marks_choice_required(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))

    result = dns.get_status(configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state))

    assert result["choice_required"] is True
    assert result["selected_target"] == ""
    assert result["default_target"] == "balancer_main"
    assert [item["tag"] for item in result["candidates"]][:3] == [
        "balancer_main",
        "balancer_reserv",
        "balancer_white_list",
    ]
    # A pending choice must not read as a reason the feature cannot be enabled.
    assert result["can_enable"] is True


def test_choice_saved_in_state_is_reused_when_request_omits_it(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    _write(state / dns.STATE_FILENAME, {"target": {"source": "balancer_white_list"}})

    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns, "_stage_and_test", lambda *_a, **_k: {"ok": True})
    monkeypatch.setattr(dns, "_wait_for_xray", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda *_a, **_k: {"ok": True, "answers": 1})
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: None)
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj, **_kwargs: _write(Path(path), obj))

    result = dns.apply_action(
        "enable",
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_kwargs: True,
    )

    assert result["target"]["source"] == "balancer_white_list"
    saved = json.loads((state / dns.STATE_FILENAME).read_text(encoding="utf-8"))
    assert saved["target"]["source"] == "balancer_white_list"
    written = json.loads(routing_path.read_text(encoding="utf-8"))
    managed = next(
        item for item in written["routing"]["balancers"] if item["tag"] == dns.BALANCER_TAG
    )
    assert managed["selector"] == ["white_list"]


def test_status_reports_a_clone_that_drifted_from_its_source(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    target = dns._select_target(dns._collect_runtime(str(configs), routing), "balancer_main", routing)
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment())
    _write(routing_path, dns._build_enabled_routing(routing, target))
    _write(state / dns.STATE_FILENAME, {"enabled": True, "target": {"source": "balancer_main"}})
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    unchanged = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )
    assert unchanged["enabled"] is True
    assert unchanged["route_drift"] is None

    # The user later widens the source balancer; the clone keeps the old snapshot.
    drifted = json.loads(routing_path.read_text(encoding="utf-8"))
    source = next(
        item for item in drifted["routing"]["balancers"] if item["tag"] == "balancer_main"
    )
    source["selector"] = ["my_proxy", "reserve_proxy"]
    _write(routing_path, drifted)

    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["route_drift"] == {
        "source": "balancer_main",
        "managed": ["my_proxy"],
        "current": ["my_proxy", "reserve_proxy"],
        "managed_fallback": "loopback_to_reserv",
        "current_fallback": "loopback_to_reserv",
    }


def test_fallback_into_direct_is_still_dropped(tmp_path: Path):
    configs, routing_path, _state = _base_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)

    target = dns._select_target(runtime, "proxy", routing)

    # The subscription auto-balancer falls back to a freedom outbound; keeping
    # it would leak DNS to the provider.
    assert "fallbackTag" not in target["managed_balancer"]
    assert target["fallback"]["kept"] is False
    assert target["fallback"]["verdict"] == "leak"

    # The user never asked for this decision, so the card has to explain it in
    # plain words: what happens, and why the spare path was not taken.
    reason = target["fallback"]["reason"]
    assert reason.startswith("Если все выбранные прокси разом откажут")
    assert "провайдер" in reason
    assert "fallback" not in reason.lower()


def test_unresolvable_fallback_is_dropped_rather_than_assumed_safe(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    source = next(
        item for item in routing["routing"]["balancers"] if item["tag"] == "balancer_main"
    )
    source["fallbackTag"] = "nothing_points_here"
    runtime = dns._collect_runtime(str(configs), routing)

    target = dns._select_target(runtime, "balancer_main", routing)

    assert "fallbackTag" not in target["managed_balancer"]
    assert target["fallback"]["verdict"] == "unknown"


def test_a_fallback_loop_terminates_and_stays_safe(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    # white list falls back into the loopback that leads back to reserve.
    white = next(
        item for item in routing["routing"]["balancers"] if item["tag"] == "balancer_white_list"
    )
    white["fallbackTag"] = "loopback_to_reserv"
    runtime = dns._collect_runtime(str(configs), routing)

    verdict = dns._fallback_verdict(runtime, routing, "loopback_to_reserv")

    assert verdict == "safe"


def test_clone_keeping_a_safe_fallback_is_not_treated_as_tampered(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    target = dns._select_target(dns._collect_runtime(str(configs), routing), "balancer_main", routing)
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment())
    _write(routing_path, dns._build_enabled_routing(routing, target))
    _write(state / dns.STATE_FILENAME, {"enabled": True, "target": {"source": "balancer_main"}})
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["tampered"] is False
    assert result["enabled"] is True
    assert result["can_disable"] is True


def test_clone_pointed_at_direct_by_hand_is_treated_as_tampered(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    target = dns._select_target(dns._collect_runtime(str(configs), routing), "balancer_main", routing)
    enabled = dns._build_enabled_routing(routing, target)
    clone = next(
        item for item in enabled["routing"]["balancers"] if item["tag"] == dns.BALANCER_TAG
    )
    clone["fallbackTag"] = "direct"
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment())
    _write(routing_path, enabled)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["tampered"] is True
    assert result["enabled"] is False
def test_status_reports_an_automatic_release(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    _write(
        state / dns.STATE_FILENAME,
        {"enabled": False, "watchdog": {"released_at": 1, "reason": "Xray не поднялся", "steps": []}},
    )
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))

    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["watchdog"]["reason"] == "Xray не поднялся"
    assert result["enabled"] is False
def test_status_exposes_the_effective_watchdog_settings(tmp_path: Path, monkeypatch):
    configs, routing, state = _base_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setenv("XKEEN_DNS_OVER_VLESS_WATCHDOG_INTERVAL", "45")

    result = dns.get_status(configs_dir=str(configs), routing_file=str(routing), ui_state_dir=str(state))

    # Карточка объясняет пользователю условия сторожа, поэтому берёт их из статуса.
    assert result["watchdog_settings"]["enabled"] is True
    assert result["watchdog_settings"]["interval"] == 45.0
    assert result["watchdog_settings"]["fail_threshold"] == dns.WATCHDOG_FAIL_THRESHOLD
    assert result["watchdog_settings"]["restart_attempts"] == dns.WATCHDOG_RESTART_ATTEMPTS


def test_watchdog_settings_follow_the_environment(monkeypatch):
    monkeypatch.setenv("XKEEN_DNS_OVER_VLESS_WATCHDOG_INTERVAL", "120")
    monkeypatch.setenv("XKEEN_DNS_OVER_VLESS_WATCHDOG_FAILS", "5")
    monkeypatch.setenv("XKEEN_DNS_OVER_VLESS_WATCHDOG_RESTARTS", "0")

    settings = dns.watchdog_settings()

    assert settings["enabled"] is True
    assert settings["interval"] == 120.0
    assert settings["fail_threshold"] == 5
    assert settings["restart_attempts"] == 0


def test_watchdog_settings_clamp_and_ignore_junk(monkeypatch):
    monkeypatch.setenv("XKEEN_DNS_OVER_VLESS_WATCHDOG_INTERVAL", "1")
    monkeypatch.setenv("XKEEN_DNS_OVER_VLESS_WATCHDOG_FAILS", "не число")
    monkeypatch.setenv("XKEEN_DNS_OVER_VLESS_WATCHDOG_RESTARTS", "999")

    settings = dns.watchdog_settings()

    # Слишком частая проверка прижата к нижней границе, мусор игнорируется.
    assert settings["interval"] == dns.WATCHDOG_INTERVAL_BOUNDS[0]
    assert settings["fail_threshold"] == dns.WATCHDOG_FAIL_THRESHOLD
    assert settings["restart_attempts"] == dns.WATCHDOG_RESTART_ATTEMPTS_BOUNDS[1]
def test_several_proxies_are_combined_into_an_own_balancer(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)

    target = dns._select_target(runtime, ["my_proxy_1", "reserve_proxy_1"], routing)

    assert target["kind"] == "balancer"
    assert target["sources"] == ["my_proxy_1", "reserve_proxy_1"]
    assert target["managed_balancer"]["selector"] == ["my_proxy_1", "reserve_proxy_1"]
    # No observatory in this fixture, so leastPing would never pick a node.
    assert target["managed_balancer"]["strategy"] == {"type": "random"}
    assert "fallbackTag" not in target["managed_balancer"]


def test_least_ping_is_used_only_when_observatory_probes_the_chosen_proxies(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    _write(configs / "07_observatory.json", {"observatory": {"subjectSelector": ["my_proxy"]}})
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)

    covered = dns._select_target(runtime, ["my_proxy_1", "my_proxy_2"], routing)
    partly = dns._select_target(runtime, ["my_proxy_1", "reserve_proxy_1"], routing)

    assert covered["managed_balancer"]["strategy"] == {"type": "leastPing"}
    # reserve_proxy_1 is not probed, so the whole set falls back to random.
    assert partly["managed_balancer"]["strategy"] == {"type": "random"}


def test_a_balancer_cannot_be_combined_with_other_routes(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)

    try:
        dns._select_target(runtime, ["balancer_main", "my_proxy_1"], routing)
        raise AssertionError("expected mixing to be refused")
    except dns.DnsOverVlessError as exc:
        assert exc.code == "mixed_target_selection"
        assert exc.details["balancers"] == ["balancer_main"]


def test_a_single_element_list_behaves_like_a_plain_choice(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)

    listed = dns._select_target(runtime, ["balancer_main"], routing)
    plain = dns._select_target(runtime, "balancer_main", routing)

    assert listed == plain


def test_combined_choice_is_saved_and_reused(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns, "_stage_and_test", lambda *_a, **_k: {"ok": True})
    monkeypatch.setattr(dns, "_wait_for_xray", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda *_a, **_k: {"ok": True, "answers": 1})
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: None)
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj, **_kwargs: _write(Path(path), obj))

    result = dns.apply_action(
        "enable",
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
        target_tag=["my_proxy_1", "my_proxy_2"],
    )

    assert result["target"]["sources"] == ["my_proxy_1", "my_proxy_2"]
    saved = json.loads((state / dns.STATE_FILENAME).read_text(encoding="utf-8"))
    assert saved["target"]["sources"] == ["my_proxy_1", "my_proxy_2"]
    written = json.loads(routing_path.read_text(encoding="utf-8"))
    managed = next(
        item for item in written["routing"]["balancers"] if item["tag"] == dns.BALANCER_TAG
    )
    assert managed["selector"] == ["my_proxy_1", "my_proxy_2"]


def test_status_reports_drift_when_a_combined_proxy_disappears(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    target = dns._select_target(
        dns._collect_runtime(str(configs), routing), ["my_proxy_1", "my_proxy_2"], routing
    )
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment())
    _write(routing_path, dns._build_enabled_routing(routing, target))
    _write(
        state / dns.STATE_FILENAME,
        {"enabled": True, "target": {"sources": ["my_proxy_1", "my_proxy_2"]}},
    )
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    steady = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )
    assert steady["route_drift"] is None
    # A balancer built here must pass the same integrity checks as a clone.
    assert steady["enabled"] is True
    assert steady["tampered"] is False

    outbounds = json.loads((configs / "04_outbounds.json").read_text(encoding="utf-8"))
    outbounds["outbounds"] = [
        item for item in outbounds["outbounds"] if item["tag"] != "my_proxy_2"
    ]
    _write(configs / "04_outbounds.json", outbounds)

    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["route_drift"]["managed"] == ["my_proxy_1", "my_proxy_2"]
    assert result["route_drift"]["current"] == ["my_proxy_1"]


def test_http_contract_accepts_a_list_of_targets(tmp_path: Path, monkeypatch):
    from routes.routing import dns_over_vless as dns_routes

    configs, routing_path, state = _scenario_config(tmp_path)
    seen: dict[str, Any] = {}

    def fake_apply(action, **kwargs):
        seen["action"] = action
        seen["target_tag"] = kwargs.get("target_tag")
        return {"ok": True, "action": action}

    monkeypatch.setattr(dns_routes, "apply_action", fake_apply)
    app = Flask(__name__)
    app.config["WTF_CSRF_ENABLED"] = False
    dns_routes.register_dns_over_vless_routes(
        app,
        xray_configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_kwargs: True,
    )

    response = app.test_client().post(
        "/api/routing/dns-over-vless",
        json={"action": "enable", "targets": ["my_proxy_1", "my_proxy_2"]},
    )

    assert response.status_code == 200
    assert seen["target_tag"] == ["my_proxy_1", "my_proxy_2"]
def test_install_enabled_before_the_picker_keeps_working(tmp_path: Path, monkeypatch):
    """An upgrade must not disturb a configuration enabled by the old code."""
    configs, routing_path, state = _base_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    # The old builder always dropped fallbackTag and never stored `sources`.
    legacy_target = {
        "kind": "balancer",
        "tag": dns.BALANCER_TAG,
        "source": "proxy",
        "label": "балансировщик proxy",
        "managed_balancer": {
            "tag": dns.BALANCER_TAG,
            "selector": ["proxy-a", "proxy-b"],
            "strategy": {"type": "leastPing"},
        },
    }
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment())
    _write(routing_path, dns._build_enabled_routing(routing, legacy_target))
    _write(
        state / dns.STATE_FILENAME,
        {"version": 1, "enabled": True, "original_dns_override": False, "target": {
            "kind": "balancer", "tag": dns.BALANCER_TAG, "source": "proxy", "label": "балансировщик proxy",
        }},
    )
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["enabled"] is True
    assert result["tampered"] is False
    assert result["selected_targets"] == ["proxy"]
    # The source balancer falls back to direct, so the old clone without a
    # fallback already matches what this version would build: no drift.
    assert result["route_drift"] is None


def test_upstreams_are_validated_against_loops_and_leaks():
    assert dns.validate_upstreams("") == ["8.8.8.8"]
    assert dns.validate_upstreams("1.1.1.1, 9.9.9.9") == ["1.1.1.1", "9.9.9.9"]
    assert dns.validate_upstreams(["https://8.8.8.8/dns-query"]) == ["https://8.8.8.8/dns-query"]

    too_many = " ".join(f"9.9.9.{n}" for n in range(dns.MAX_UPSTREAMS + 1))
    for bad in ("127.0.0.53", "192.168.1.1", "169.254.1.1", "dns.google", too_many):
        try:
            dns.validate_upstreams(bad)
            raise AssertionError(f"expected {bad!r} to be refused")
        except dns.DnsOverVlessError as exc:
            assert exc.code == "upstreams_invalid"


def test_several_upstreams_enable_fallback_between_them():
    single = dns._managed_fragment(["8.8.8.8"])
    several = dns._managed_fragment(["8.8.8.8", "1.1.1.1"])

    # One server has nothing to fall back to; several are listed precisely so
    # the next one is tried.
    assert single["dns"]["disableFallback"] is True
    assert several["dns"]["disableFallback"] is False
    assert several["dns"]["servers"] == ["8.8.8.8", "1.1.1.1"]


def test_local_resolver_takes_the_home_zones_out_of_the_tunnel(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)
    resolvers = dns._parse_local_resolvers("192.168.1.1:5353")

    fragment = dns._managed_fragment(["1.1.1.1"], resolvers)
    strict, delegated = fragment["dns"]["servers"][0], fragment["dns"]["servers"][1]

    assert strict["address"] == "192.168.1.1"
    assert strict["port"] == 5353
    assert "domain:lan" in strict["domains"]
    # Reverse lookups for private ranges must not reach a public resolver...
    assert "domain:10.in-addr.arpa" in strict["domains"]
    assert "domain:168.192.in-addr.arpa" in strict["domains"]
    # ...but a blanket in-addr.arpa would also grab PTR for public addresses.
    assert "domain:in-addr.arpa" not in strict["domains"]
    # None of these exists on the public internet, so a silent resolver is the
    # end of the story: retrying abroad would only hand over the LAN names.
    assert strict["skipFallback"] is True

    # The router's own zones are real delegated domains, listed only because the
    # box resolves them for itself.  They ride the same resolver, but a silent
    # one must not leave the local web interface or the DDNS name unresolvable.
    assert delegated["address"] == "192.168.1.1"
    assert delegated["port"] == 5353
    assert "domain:keenetic.net" in delegated["domains"]
    assert "domain:netcraze.net" in delegated["domains"]
    assert "domain:lan" not in delegated["domains"]
    assert delegated["skipFallback"] is False

    # A public upstream still follows for everything else.
    assert fragment["dns"]["servers"][2] == "1.1.1.1"

    rule = dns._local_rule(resolvers, dns._direct_outbound_tag(runtime))
    assert rule["outboundTag"] == "direct"
    assert rule["ip"] == ["192.168.1.1/32"]
    assert rule["inboundTag"] == [dns.DNS_IN_TAG]


def test_local_rule_is_matched_before_the_proxy_rule(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)
    target = dns._select_target(runtime, "balancer_main", routing)
    rule = dns._local_rule(dns._parse_local_resolvers("192.168.1.1"), "direct")

    planned = dns._build_enabled_routing(routing, target, rule)
    tags = [item.get("ruleTag") for item in planned["routing"]["rules"][:3]]

    # Otherwise a home name would already be travelling through the tunnel.
    assert tags == [dns.LOCAL_RULE_TAG, dns.PROXY_RULE_TAG, dns.CAPTURE_RULE_TAG]
    assert dns._build_disabled_routing(planned) == routing


def test_local_resolver_input_is_checked(tmp_path: Path):
    assert dns._parse_local_resolver("") is None
    assert dns._parse_local_resolver("10.0.0.1") == {"address": "10.0.0.1", "port": 53}

    for bad in ("router.lan", "192.168.1.1:port", "0.0.0.0"):
        try:
            dns._parse_local_resolver(bad)
            raise AssertionError(f"expected {bad!r} to be refused")
        except dns.DnsOverVlessError as exc:
            assert exc.code == "local_resolver_invalid"


def test_enable_stores_dns_settings_and_status_reports_them(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns, "_stage_and_test", lambda *_a, **_k: {"ok": True})
    monkeypatch.setattr(dns, "_wait_for_xray", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda *_a, **_k: {"ok": True, "answers": 1})
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: None)
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj, **_kwargs: _write(Path(path), obj))

    dns.apply_action(
        "enable",
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
        target_tag="balancer_main",
        upstreams=["1.1.1.1", "9.9.9.9"],
        local_resolver="192.168.1.1:5353",
    )

    fragment = json.loads((configs / dns.MANAGED_FRAGMENT).read_text(encoding="utf-8"))
    assert fragment["dns"]["servers"][0]["address"] == "192.168.1.1"
    assert fragment["dns"]["servers"][1]["address"] == "192.168.1.1"
    assert fragment["dns"]["servers"][2:] == ["1.1.1.1", "9.9.9.9"]

    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))
    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["enabled"] is True
    assert result["tampered"] is False
    assert result["upstreams"] == ["1.1.1.1", "9.9.9.9"]
    assert result["local_resolvers"] == ["192.168.1.1:5353"]


def test_bare_zone_entries_are_qualified_before_use():
    # A bare string is a substring match in Xray: "lan" would also catch
    # atlantic.com and send it to the LAN resolver.
    assert dns._local_domains("lan, home.arpa") == ["domain:lan", "domain:home.arpa"]
    assert dns._local_domains(["full:my.keenetic.net", "GEOSITE:private"]) == [
        "full:my.keenetic.net",
        "geosite:private",
    ]
    assert dns._local_domains("") == dns.DEFAULT_LOCAL_DOMAINS
    assert dns._local_domains(", ,") == dns.DEFAULT_LOCAL_DOMAINS


def test_custom_zones_reach_the_fragment(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns, "_stage_and_test", lambda *_a, **_k: {"ok": True})
    monkeypatch.setattr(dns, "_wait_for_xray", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda *_a, **_k: {"ok": True, "answers": 1})
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: None)
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj, **_kwargs: _write(Path(path), obj))

    dns.apply_action(
        "enable",
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
        target_tag="balancer_main",
        local_resolver="10.0.0.1",
        local_domains="lan, office.internal",
    )

    fragment = json.loads((configs / dns.MANAGED_FRAGMENT).read_text(encoding="utf-8"))
    # ``lan`` is nowhere on the public internet; ``office.internal`` is a name
    # the user added, so it is treated as delegated and may fall back.
    assert fragment["dns"]["servers"][0]["domains"] == ["domain:lan"]
    assert fragment["dns"]["servers"][0]["skipFallback"] is True
    assert fragment["dns"]["servers"][1]["domains"] == ["domain:office.internal"]
    assert fragment["dns"]["servers"][1]["skipFallback"] is False

    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))
    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["local_domains"] == ["domain:lan", "domain:office.internal"]
    assert result["default_local_domains"] == dns.DEFAULT_LOCAL_DOMAINS
    assert result["tampered"] is False


def test_only_strict_zones_keep_the_single_server_and_no_fallback(tmp_path: Path):
    """Nothing changes for a zone list that is local through and through."""

    resolvers = dns._parse_local_resolvers("192.168.1.1")
    fragment = dns._managed_fragment(["1.1.1.1"], resolvers, ["domain:lan", "domain:home"])
    servers = fragment["dns"]["servers"]

    assert len(servers) == 2
    assert servers[0]["domains"] == ["domain:lan", "domain:home"]
    assert servers[0]["skipFallback"] is True
    assert servers[1] == "1.1.1.1"
    # No delegated zone means nothing needs the global fallback.
    assert fragment["dns"]["disableFallback"] is True


def test_declared_fragment_with_split_zones_is_not_read_back_as_drift(tmp_path: Path):
    """Two entries per resolver must fold back into the resolver they came from.

    Otherwise the panel rebuilds a four-server fragment from its own three-server
    file and reports a config nobody touched as tampered.
    """

    resolvers = dns._parse_local_resolvers("192.168.1.1:5353")
    fragment = dns._managed_fragment(["1.1.1.1"], resolvers)
    raw_servers = fragment["dns"]["servers"]

    folded: list[dict] = []
    zones: dict[tuple, list[str]] = {}
    for item in [entry for entry in raw_servers if isinstance(entry, dict)]:
        key = (item["address"], item["port"])
        if key not in zones:
            zones[key] = []
            folded.append({"address": key[0], "port": key[1]})
        zones[key].extend(item["domains"])

    assert folded == [{"address": "192.168.1.1", "port": 5353}]
    assert dns._managed_fragment(["1.1.1.1"], folded, zones[("192.168.1.1", 5353)]) == fragment


def test_direct_domains_are_resolved_past_the_tunnel(tmp_path: Path):
    """A domain routed directly should be resolved directly, or its address is
    the one near the exit point while the traffic goes straight out."""

    local = dns._parse_local_resolvers("192.168.1.1")
    bypass = dns._parse_direct_resolvers("77.88.8.8, 77.88.8.1")
    fragment = dns._managed_fragment(
        ["8.8.8.8"], local, ["domain:lan"], bypass, ["geosite:category-ru"]
    )
    servers = fragment["dns"]["servers"]

    # Home zones first, then the bypass group, then the public upstream.
    assert servers[0]["address"] == "192.168.1.1"
    assert [item["address"] for item in servers[1:3]] == ["77.88.8.8", "77.88.8.1"]
    assert all(item["domains"] == ["geosite:category-ru"] for item in servers[1:3])
    # A silent resolver must not leave the name unresolved: the query falls
    # through to the public upstream instead.
    assert all(item["skipFallback"] is False for item in servers[1:3])
    assert servers[3:] == ["8.8.8.8"]
    assert fragment["dns"]["disableFallback"] is False


def test_direct_rule_keeps_those_queries_out_of_the_tunnel(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)
    target = dns._select_target(runtime, "balancer_main", routing)
    bypass = dns._parse_direct_resolvers("77.88.8.8")

    rule = dns._direct_rule(bypass, "direct")
    assert rule["ip"] == ["77.88.8.8/32"]
    assert rule["outboundTag"] == "direct"

    planned = dns._build_enabled_routing(
        routing, target, dns._local_rule(dns._parse_local_resolvers("192.168.1.1"), "direct"), rule
    )
    tags = [item.get("ruleTag") for item in planned["routing"]["rules"][:4]]

    # Both bypass rules must win over the proxy rule, or the query is already
    # inside the tunnel by the time they are checked.
    assert tags == [dns.LOCAL_RULE_TAG, dns.DIRECT_RULE_TAG, dns.PROXY_RULE_TAG, dns.CAPTURE_RULE_TAG]


def test_half_a_bypass_setting_is_refused(tmp_path: Path, monkeypatch):
    """Resolvers without domains are never asked; domains without resolvers
    have nowhere to go.  Either half alone is a silent no-op."""

    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))

    with pytest.raises(dns.DnsOverVlessError) as excinfo:
        dns.apply_action(
            "enable",
            configs_dir=str(configs),
            routing_file=str(routing_path),
            ui_state_dir=str(state),
            restart_xkeen=lambda **_k: True,
            target_tag="balancer_main",
            direct_resolver="77.88.8.8",
        )

    assert excinfo.value.code == "direct_incomplete"


def test_bypass_group_survives_read_back_without_looking_tampered(tmp_path: Path, monkeypatch):
    """Both groups are objects in the same list; telling them apart is what the
    drift check gets wrong if it guesses instead of reading the bypass rule."""

    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns, "_stage_and_test", lambda *_a, **_k: {"ok": True})
    monkeypatch.setattr(dns, "_wait_for_xray", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda *_a, **_k: {"ok": True, "answers": 1})
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: None)
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj, **_kwargs: _write(Path(path), obj))

    dns.apply_action(
        "enable",
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
        target_tag="balancer_main",
        local_resolver="192.168.1.1:5353",
        direct_resolver="77.88.8.8",
        direct_domains="geosite:category-ru, domain:ok.ru",
    )

    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))
    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["enabled"] is True
    assert result["tampered"] is False
    assert result["local_resolvers"] == ["192.168.1.1:5353"]
    assert result["direct_resolvers"] == ["77.88.8.8:53"]
    assert result["direct_domains"] == ["geosite:category-ru", "domain:ok.ru"]

    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    tags = [item.get("ruleTag") for item in routing["routing"]["rules"][:2]]
    assert tags == [dns.LOCAL_RULE_TAG, dns.DIRECT_RULE_TAG]


def test_disable_removes_the_bypass_rule_too(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)
    target = dns._select_target(runtime, "balancer_main", routing)
    planned = dns._build_enabled_routing(
        routing, target, None, dns._direct_rule(dns._parse_direct_resolvers("77.88.8.8"), "direct")
    )

    cleaned = dns._build_disabled_routing(planned)
    tags = {item.get("ruleTag") for item in cleaned["routing"]["rules"]}

    assert dns.DIRECT_RULE_TAG not in tags
    assert dns.PROXY_RULE_TAG not in tags


def test_emergency_release_drops_the_bypass_rules_too(tmp_path: Path, monkeypatch):
    """The watchdog gives port 53 back by clearing our rules; a rule it does not
    know about would stay behind and keep sending DNS to a dead listener."""

    configs, routing_path, state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)
    target = dns._select_target(runtime, "balancer_main", routing)
    planned = dns._build_enabled_routing(
        routing,
        target,
        dns._local_rule(dns._parse_local_resolvers("192.168.1.1"), "direct"),
        dns._direct_rule(dns._parse_direct_resolvers("77.88.8.8"), "direct"),
    )
    _write(routing_path, planned)
    _write(
        configs / dns.MANAGED_FRAGMENT,
        dns._managed_fragment(
            ["8.8.8.8"],
            dns._parse_local_resolvers("192.168.1.1"),
            None,
            dns._parse_direct_resolvers("77.88.8.8"),
            ["geosite:category-ru"],
        ),
    )
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj, **_kwargs: _write(Path(path), obj))
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: None)

    released = dns._emergency_release(
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
        reason="test",
    )

    assert "routing_cleared" in released["steps"]
    assert "fragment_removed" in released["steps"]
    after = json.loads(routing_path.read_text(encoding="utf-8"))
    tags = {item.get("ruleTag") for item in after["routing"]["rules"]}
    assert dns.LOCAL_RULE_TAG not in tags
    assert dns.DIRECT_RULE_TAG not in tags
    assert dns.PROXY_RULE_TAG not in tags
    assert dns.CAPTURE_RULE_TAG not in tags


def test_domains_already_routed_direct_are_offered_as_a_starting_list(tmp_path: Path):
    """Keeping the two lists in sync by hand is what makes them drift apart."""

    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    routing["routing"]["rules"].insert(
        0,
        {"type": "field", "outboundTag": "direct", "domain": ["geosite:category-ru", "ok.ru"]},
    )
    runtime = dns._collect_runtime(str(configs), routing)

    offered = dns._domains_routed_direct(runtime, routing)

    # Bare names are qualified the same way the zone list qualifies them.
    assert offered == ["geosite:category-ru", "domain:ok.ru"]


def test_several_network_segments_each_get_their_own_resolver(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)
    resolvers = dns._parse_local_resolvers("192.168.1.1, 192.168.2.1:5353, 10.8.0.1")

    fragment = dns._managed_fragment(["1.1.1.1"], resolvers)
    servers = fragment["dns"]["servers"]

    strict_zones, delegated_zones = dns._split_local_zones(dns.DEFAULT_LOCAL_DOMAINS)

    # Every segment is asked about the strict zones first, in the order given...
    assert [item["address"] for item in servers[:3]] == ["192.168.1.1", "192.168.2.1", "10.8.0.1"]
    assert [item["port"] for item in servers[:3]] == [53, 5353, 53]
    assert all(item["domains"] == strict_zones for item in servers[:3])
    assert all(item["skipFallback"] is True for item in servers[:3])
    # ...then about the delegated ones, and only after every segment stayed
    # silent does the query reach the public upstream.
    assert [item["address"] for item in servers[3:6]] == ["192.168.1.1", "192.168.2.1", "10.8.0.1"]
    assert all(item["domains"] == delegated_zones for item in servers[3:6])
    assert all(item["skipFallback"] is False for item in servers[3:6])
    assert servers[6:] == ["1.1.1.1"]
    # The global flag would otherwise cancel that last hop: one upstream, but a
    # delegated zone still needs somewhere to go.
    assert fragment["dns"]["disableFallback"] is False

    rule = dns._local_rule(resolvers, dns._direct_outbound_tag(runtime))
    assert rule["ip"] == ["192.168.1.1/32", "192.168.2.1/32", "10.8.0.1/32"]


def test_too_many_local_resolvers_are_refused():
    # The cap only guards against an accidental paste; a real home network
    # with a handful of segments stays well below it.
    fine = ", ".join(f"10.0.{n}.1" for n in range(dns.MAX_LOCAL_RESOLVERS))
    assert len(dns._parse_local_resolvers(fine)) == dns.MAX_LOCAL_RESOLVERS

    try:
        dns._parse_local_resolvers(", ".join(f"10.1.{n}.1" for n in range(dns.MAX_LOCAL_RESOLVERS + 1)))
        raise AssertionError("expected the list to be refused")
    except dns.DnsOverVlessError as exc:
        assert exc.code == "local_resolver_invalid"


def test_zone_list_is_free_form_within_a_sane_cap():
    # Any private zone is allowed — only the count is capped.
    custom = dns._local_domains("corp.local, mynet, office.internal")
    assert custom == ["domain:corp.local", "domain:mynet", "domain:office.internal"]

    try:
        dns._local_domains(", ".join(f"zone{n}.lan" for n in range(dns.MAX_LOCAL_DOMAINS + 1)))
        raise AssertionError("expected the zone list to be refused")
    except dns.DnsOverVlessError as exc:
        assert exc.code == "local_domains_invalid"


def test_default_zones_are_local_by_definition_plus_vendor_zones():
    defaults = dns.DEFAULT_LOCAL_DOMAINS

    # Nothing in the default list is a delegated public zone except the vendor
    # domains, which the router resolves for itself.
    assert set(dns.LOCAL_ZONES) <= set(defaults)
    assert set(dns.PRIVATE_PTR_ZONES) <= set(defaults)
    assert set(dns.KEENETIC_ZONES) <= set(defaults)
    assert set(dns.NETCRAZE_ZONES) <= set(defaults)

    # 172.16/12 is rare at home and costs sixteen entries, so it is a preset.
    assert dns.PTR_172_ZONES[0] == "domain:16.172.in-addr.arpa"
    assert dns.PTR_172_ZONES[-1] == "domain:31.172.in-addr.arpa"
    assert not set(dns.PTR_172_ZONES) & set(defaults)
    assert dns.ZONE_PRESETS["ptr172"] == dns.PTR_172_ZONES


def test_status_offers_the_zone_presets(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))

    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert set(result["zone_presets"]) == {"local", "ptr", "ptr172", "keenetic", "netcraze"}
    assert result["zone_presets"]["keenetic"] == dns.KEENETIC_ZONES


def test_resolver_pointed_at_our_own_listener_is_refused():
    # 127.0.0.1:53 is this very service: the query would come straight back.
    for bad in ("127.0.0.1", "127.0.0.1:53"):
        with pytest.raises(dns.DnsOverVlessError) as excinfo:
            dns._parse_local_resolver(bad)
        assert excinfo.value.code == "local_resolver_loop"
        assert "зациклил" in str(excinfo.value)

    # ::1 never reaches the new rule: Python counts ::/8 as reserved, so the
    # older check refuses it first. Same outcome for the user, other sentence.
    with pytest.raises(dns.DnsOverVlessError):
        dns._parse_local_resolver("[::1]:53")

    # The firmware resolver sits on the same host but a different port, which is
    # exactly the address the hint tells people to use.
    assert dns._parse_local_resolver("127.0.0.1:41100") == {"address": "127.0.0.1", "port": 41100}
    # A resolver elsewhere in the network keeps working on port 53.
    assert dns._parse_local_resolver("192.168.1.1") == {"address": "192.168.1.1", "port": 53}


def test_own_address_probe_stays_permissive_when_it_cannot_run(monkeypatch):
    # Refusing a legitimate resolver would be worse than missing a loop.
    import socket as socket_module

    def _explode(*_args, **_kwargs):
        raise OSError("no sockets here")

    monkeypatch.setattr(socket_module, "socket", _explode)
    assert dns._parse_local_resolver("192.168.1.1") == {"address": "192.168.1.1", "port": 53}


def test_one_address_in_both_resolver_groups_is_refused(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))

    with pytest.raises(dns.DnsOverVlessError) as excinfo:
        dns.apply_action(
            "enable",
            configs_dir=str(configs),
            routing_file=str(routing_path),
            ui_state_dir=str(state),
            restart_xkeen=lambda *a, **k: None,
            local_resolver="192.168.1.1",
            local_domains="domain:lan",
            direct_resolver="192.168.1.1:5353",
            direct_domains="domain:example.com",
        )

    assert excinfo.value.code == "resolver_group_overlap"
    # The port differs, but read-back splits the groups by address alone.
    assert "192.168.1.1" in str(excinfo.value)


def test_field_hint_names_the_firmware_resolver_ports():
    # The addresses are not guessable, so the hint has to carry them; without
    # this the field reads as if there were nothing to put in it.
    markup = Path("xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
    hint_start = markup.index('for="routing-dns-over-vless-local"')
    hint = markup[hint_start : hint_start + 1600]
    assert "127.0.0.1:41100" in hint
    assert "41101" in hint and "41102" in hint
    assert "зациклил" in hint


def test_managed_jsonc_header_is_not_duplicated_on_rewrite(tmp_path: Path, monkeypatch):
    # On the router the header line had piled up: it is written on every enable, and the
    # previous one survived as an ordinary user comment.
    from services import xray_subscriptions as subs

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(path) + "c")
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    _configs, routing_path, _state = _scenario_config(tmp_path)
    sidecar = Path(str(routing_path) + "c")
    routing = json.loads(routing_path.read_text(encoding="utf-8"))

    dns._write_routing_preserving_comments(str(routing_path), routing)
    header = "// DNS-over-VLESS managed by XKeen UI"
    assert sidecar.read_text(encoding="utf-8").count(header) == 1

    # A comment the user typed sits in the same slot as the header and must survive.
    sidecar.write_text(
        sidecar.read_text(encoding="utf-8").replace("{", "// не трогать этот блок\n{", 1),
        encoding="utf-8",
    )
    for _ in range(3):
        dns._write_routing_preserving_comments(str(routing_path), routing)

    text = sidecar.read_text(encoding="utf-8")
    assert text.count(header) == 1
    assert "// не трогать этот блок" in text


def test_managed_jsonc_header_already_duplicated_is_healed(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(path) + "c")
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    _configs, routing_path, _state = _scenario_config(tmp_path)
    sidecar = Path(str(routing_path) + "c")
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    header = "// DNS-over-VLESS managed by XKeen UI"

    # The state a router that ran the old code is already in.
    sidecar.write_text(
        header + "\n" + header + "\n" + json.dumps(routing, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    dns._write_routing_preserving_comments(str(routing_path), routing)

    assert sidecar.read_text(encoding="utf-8").count(header) == 1


def test_dns_outbound_stays_bare_until_the_other_record_types_are_let_through():
    assert dns._dns_outbound() == {"tag": dns.DNS_OUT_TAG, "protocol": "dns"}
    assert dns._dns_outbound("my_proxy_1") == {
        "tag": dns.DNS_OUT_TAG,
        "protocol": "dns",
        # The skipped queries are handed on to the destination of the
        # connection, and a client asking the router itself aims at a private
        # address that means nothing on the other side of the tunnel: the
        # outbound replaces it with the first DNS server of the list.
        "settings": {"nonIPQuery": "skip", "address": "8.8.8.8"},
        # Without a route of their own the skipped queries would leave the
        # router in the clear, so the pass-through always names one.
        "proxySettings": {"tag": "my_proxy_1"},
    }


def test_pass_node_options_spell_out_the_selector_prefixes(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)

    # ``balancer_main`` selects by the prefix ``my_proxy``; a node has to be a
    # real outbound, so the prefix is expanded rather than offered as is.
    assert dns._pass_node_options(runtime, routing, ["balancer_main"]) == [
        "my_proxy_1",
        "my_proxy_2",
    ]
    assert dns._pass_node_options(runtime, routing, ["white_list_1"]) == ["white_list_1"]
    # No usable route to go on: every live proxy is offered instead of nothing.
    assert dns._pass_node_options(runtime, routing, []) == [
        "my_proxy_1",
        "my_proxy_2",
        "reserve_proxy_1",
        "white_list_1",
    ]


def test_pass_node_is_remembered_rather_than_recomputed(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)

    # First run has nothing stored: the first node of the route is taken.
    assert dns._pick_pass_node(None, None, runtime, routing, ["balancer_main"]) == "my_proxy_1"
    # A stored node keeps its place even though it is not the first one -- the
    # user reordering their own selector must not silently move the traffic.
    assert (
        dns._pick_pass_node(None, "my_proxy_2", runtime, routing, ["balancer_main"])
        == "my_proxy_2"
    )
    # A stored node that no longer exists falls back to the route.
    assert (
        dns._pick_pass_node(None, "gone_proxy", runtime, routing, ["balancer_main"])
        == "my_proxy_1"
    )
    # An explicit request wins, but only for a node the route can reach.
    assert (
        dns._pick_pass_node("my_proxy_2", "my_proxy_1", runtime, routing, ["balancer_main"])
        == "my_proxy_2"
    )
    try:
        dns._pick_pass_node("balancer_main", None, runtime, routing, ["balancer_main"])
        raise AssertionError("expected a balancer to be refused as a node")
    except dns.DnsOverVlessError as exc:
        assert exc.code == "pass_node_unavailable"


def test_enable_can_let_the_other_record_types_through(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns, "_stage_and_test", lambda *_a, **_k: {"ok": True})
    monkeypatch.setattr(dns, "_wait_for_xray", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda *_a, **_k: {"ok": True, "answers": 1})
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: None)
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj, **_kwargs: _write(Path(path), obj))

    dns.apply_action(
        "enable",
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
        target_tag="balancer_main",
        pass_non_ip=True,
        pass_non_ip_node="my_proxy_2",
    )

    fragment = json.loads((configs / dns.MANAGED_FRAGMENT).read_text(encoding="utf-8"))
    assert fragment["outbounds"] == [
        {
            "tag": dns.DNS_OUT_TAG,
            "protocol": "dns",
            "settings": {"nonIPQuery": "skip", "address": "8.8.8.8"},
            "proxySettings": {"tag": "my_proxy_2"},
        }
    ]
    # The listener stays plain: rewriting there would move the destination port
    # as well, and the capture rule matches by port.
    assert fragment["inbounds"][0]["settings"] == {"network": "tcp,udp"}

    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))
    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["pass_non_ip"] is True
    assert result["pass_non_ip_node"] == "my_proxy_2"
    assert result["pass_non_ip_options"] == ["my_proxy_1", "my_proxy_2"]
    # The pass-through is part of the config the panel wrote, so it must not
    # read back as somebody having edited the fragment by hand.
    assert result["tampered"] is False
    assert result["presence"]["fragment"] is True


def test_a_half_written_pass_through_reads_back_as_drift(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    target = dns._select_target(dns._collect_runtime(str(configs), routing), "balancer_main")
    _write(routing_path, dns._build_enabled_routing(routing, target))
    fragment = dns._managed_fragment(pass_node="my_proxy_1")
    # ``nonIPQuery`` without a route of its own is not something this panel
    # writes: the skipped queries would leave in the clear.
    del fragment["outbounds"][0]["proxySettings"]
    _write(configs / dns.MANAGED_FRAGMENT, fragment)
    _write(state / dns.STATE_FILENAME, {"enabled": True, "pass_non_ip": True})
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["presence"]["fragment"] is False


def test_the_outbound_names_a_destination_only_with_the_pass_through():
    # An installation that never turned the pass-through on keeps exactly the
    # fragment it already has, so its config must not read back as edited.
    bare = dns._managed_fragment()
    assert "settings" not in bare["outbounds"][0]
    # The listener never rewrites: the destination port would move with it and
    # the capture rule matches by port -- a resolver on 443 would drag every
    # connection to that port into the DNS outbound.
    assert bare["inbounds"][0]["settings"] == {"network": "tcp,udp"}
    # The destination follows the DNS servers the user chose, not a constant.
    named = dns._managed_fragment(["1.1.1.1", "9.9.9.9"], pass_node="my_proxy_1")
    assert named["outbounds"][0]["settings"] == {"nonIPQuery": "skip", "address": "1.1.1.1"}
    assert named["inbounds"][0]["settings"] == {"network": "tcp,udp"}
    # A server written as a URL still yields a plain address to aim at.
    via_url = dns._managed_fragment(["https://1.1.1.1/dns-query"], pass_node="my_proxy_1")
    assert via_url["outbounds"][0]["settings"]["address"] == "1.1.1.1"


def test_the_pass_through_listener_reads_back_without_drift(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    target = dns._select_target(dns._collect_runtime(str(configs), routing), "balancer_main")
    _write(routing_path, dns._build_enabled_routing(routing, target))
    _write(
        configs / dns.MANAGED_FRAGMENT,
        dns._managed_fragment(["9.9.9.9"], pass_node="my_proxy_1"),
    )
    _write(state / dns.STATE_FILENAME, {"enabled": True, "pass_non_ip": True})
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["presence"]["fragment"] is True


def test_the_service_line_goes_on_with_the_feature_and_comes_off_with_it(
    tmp_path: Path, monkeypatch
):
    from services import xray_subscriptions as subs

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(path) + "c")
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    _configs, routing_path, _state = _scenario_config(tmp_path)
    sidecar = Path(str(routing_path) + "c")
    routing = json.loads(routing_path.read_text(encoding="utf-8"))

    dns._write_routing_preserving_comments(str(routing_path), routing)
    assert sidecar.read_text(encoding="utf-8").count(dns.MANAGED_JSONC_HEADER) == 1

    sidecar.write_text(
        sidecar.read_text(encoding="utf-8").replace("{", "// правило для дома" + chr(10) + "{", 1),
        encoding="utf-8",
    )
    # Switching the feature off must take the line with it: left behind, the file
    # goes on claiming something that is no longer true.
    dns._write_routing_preserving_comments(str(routing_path), routing, managed=False)

    text = sidecar.read_text(encoding="utf-8")
    assert dns.MANAGED_JSONC_HEADER not in text
    # The user's own comment is not ours to remove.
    assert "// правило для дома" in text


def test_disable_writes_the_routing_without_the_service_line(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _base_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    target = dns._select_target(dns._collect_runtime(str(configs), routing), "proxy")
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment())
    _write(routing_path, dns._build_enabled_routing(routing, target))
    _write(state / dns.STATE_FILENAME, {"enabled": True, "original_dns_override": False})

    seen: list[bool] = []
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))
    monkeypatch.setattr(dns, "_stage_and_test", lambda *_a, **_k: {"ok": True})
    monkeypatch.setattr(dns, "_wait_for_xray", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda **_k: True)
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: None)
    monkeypatch.setattr(
        dns,
        "_write_routing_preserving_comments",
        lambda path, obj, managed=True: seen.append(managed) or _write(Path(path), obj),
    )

    dns.apply_action(
        "disable",
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
    )

    assert seen == [False]


def test_the_guard_release_also_writes_without_the_service_line(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _base_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    target = dns._select_target(dns._collect_runtime(str(configs), routing), "proxy")
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment())
    _write(routing_path, dns._build_enabled_routing(routing, target))
    _write(state / dns.STATE_FILENAME, {"enabled": True, "original_dns_override": False})

    seen: list[bool] = []
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: None)
    monkeypatch.setattr(
        dns,
        "_write_routing_preserving_comments",
        lambda path, obj, managed=True: seen.append(managed) or _write(Path(path), obj),
    )

    dns._emergency_release(
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
        reason="тест",
    )

    # The guard letting go is a switch-off like any other.
    assert seen == [False]
