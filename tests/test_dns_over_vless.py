from __future__ import annotations

import json
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
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj: _write(Path(path), obj))

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
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj: _write(Path(path), obj))

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
    assert "Резервирование сохранено" in script
    assert "Сторож отключил защиту" in script
    assert 'id="routing-dns-over-vless-multi"' in template
    assert "Балансировать между несколькими прокси" in template


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
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj: _write(Path(path), obj))

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


def _enabled_install(tmp_path: Path):
    """A scenario install with the feature switched on."""
    configs, routing_path, state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    target = dns._select_target(dns._collect_runtime(str(configs), routing), "balancer_main", routing)
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment())
    _write(routing_path, dns._build_enabled_routing(routing, target))
    _write(
        state / dns.STATE_FILENAME,
        {"enabled": True, "original_dns_override": False, "target": {"source": "balancer_main"}},
    )
    return configs, routing_path, state


def _tick(configs, routing_path, state, restart, counters):
    return dns.watchdog_tick(
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=restart,
        counters=counters,
    )


def test_watchdog_does_nothing_while_the_feature_is_off(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    calls: list[object] = []
    monkeypatch.setattr(dns, "_watchdog_healthy", lambda: False)
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: calls.append(enabled))

    result = _tick(configs, routing_path, state, lambda **k: calls.append(k) or True, {})

    assert result["action"] == "idle"
    assert calls == []


def test_watchdog_stays_quiet_while_dns_answers(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _enabled_install(tmp_path)
    monkeypatch.setattr(dns, "_watchdog_healthy", lambda: True)

    result = _tick(configs, routing_path, state, lambda **k: True, {"fails": 2, "restarts": 1})

    assert result["action"] == "ok"
    assert result["fails"] == 0 and result["restarts"] == 0


def test_watchdog_restarts_the_core_before_giving_up(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _enabled_install(tmp_path)
    restarts: list[str] = []
    monkeypatch.setattr(dns, "_watchdog_healthy", lambda: False)

    counters: Dict[str, Any] = {}
    actions = []
    for _ in range(dns.WATCHDOG_FAIL_THRESHOLD):
        counters = _tick(configs, routing_path, state, lambda **k: restarts.append(k.get("source")) or True, counters)
        actions.append(counters["action"])

    # Failures are tolerated up to the threshold, then a restart is attempted.
    assert actions[:-1] == ["watching"] * (dns.WATCHDOG_FAIL_THRESHOLD - 1)
    assert actions[-1] == "restarted"
    assert restarts == ["dns-over-vless-watchdog"]
    # The managed configuration is still in place: nothing was released yet.
    assert (configs / dns.MANAGED_FRAGMENT).exists()


def test_watchdog_recovers_without_releasing_when_the_core_comes_back(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _enabled_install(tmp_path)
    health = {"ok": False}
    monkeypatch.setattr(dns, "_watchdog_healthy", lambda: health["ok"])

    counters: Dict[str, Any] = {}
    for _ in range(dns.WATCHDOG_FAIL_THRESHOLD):
        counters = _tick(configs, routing_path, state, lambda **k: True, counters)
    assert counters["action"] == "restarted"

    health["ok"] = True
    counters = _tick(configs, routing_path, state, lambda **k: True, counters)

    assert counters["action"] == "ok"
    assert counters["restarts"] == 0
    assert json.loads((state / dns.STATE_FILENAME).read_text(encoding="utf-8"))["enabled"] is True


def test_watchdog_hands_dns_back_to_the_firmware_after_restarts_fail(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _enabled_install(tmp_path)
    overrides: list[bool] = []
    monkeypatch.setattr(dns, "_watchdog_healthy", lambda: False)
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: overrides.append(enabled))
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj: _write(Path(path), obj))

    counters: Dict[str, Any] = {}
    action = ""
    for _ in range(dns.WATCHDOG_FAIL_THRESHOLD * (dns.WATCHDOG_RESTART_ATTEMPTS + 1) + 2):
        counters = _tick(configs, routing_path, state, lambda **k: True, counters)
        action = counters["action"]
        if action == "released":
            break

    assert action == "released"
    # Port 53 goes back to the firmware resolver...
    assert overrides == [False]
    # ...and the managed config is gone, so a recovering core can bind again.
    assert not (configs / dns.MANAGED_FRAGMENT).exists()
    written = json.loads(routing_path.read_text(encoding="utf-8"))
    assert all(
        item.get("ruleTag") not in {dns.PROXY_RULE_TAG, dns.CAPTURE_RULE_TAG}
        for item in written["routing"]["rules"]
    )
    saved = json.loads((state / dns.STATE_FILENAME).read_text(encoding="utf-8"))
    assert saved["enabled"] is False
    assert saved["watchdog"]["reason"]


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


def test_watchdog_thread_starts_only_once(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "_WATCHDOG_STARTED", False, raising=False)

    kwargs = dict(
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
        interval=3600.0,
    )
    first = dns.start_watchdog(**kwargs)
    second = dns.start_watchdog(**kwargs)

    assert first is True
    assert second is False


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
    monkeypatch.setattr(dns, "_write_routing_preserving_comments", lambda path, obj: _write(Path(path), obj))

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


def test_watchdog_abandons_release_if_the_user_disabled_meanwhile(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _enabled_install(tmp_path)
    overrides: list[bool] = []
    monkeypatch.setattr(dns, "_watchdog_healthy", lambda: False)
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: overrides.append(enabled))

    real_load = dns._load_state
    seen = {"calls": 0}

    def flaky_load(path):
        # The last read happens inside the lock, right before releasing: by
        # then the user has switched the feature off from the panel.
        seen["calls"] += 1
        value = real_load(path)
        if seen["calls"] > 1 and value.get("enabled"):
            value = dict(value)
            value["enabled"] = False
        return value

    counters: Dict[str, Any] = {"fails": dns.WATCHDOG_FAIL_THRESHOLD - 1, "restarts": dns.WATCHDOG_RESTART_ATTEMPTS}
    monkeypatch.setattr(dns, "_load_state", flaky_load)
    result = _tick(configs, routing_path, state, lambda **_k: True, counters)

    assert result["action"] == "idle"
    assert overrides == []
    assert (configs / dns.MANAGED_FRAGMENT).exists()


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
