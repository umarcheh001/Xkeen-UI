from __future__ import annotations

import json
from pathlib import Path

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
    target = dns._select_target(runtime)
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
    target = dns._select_target(dns._collect_runtime(str(configs), routing))
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
    target = dns._select_target(dns._collect_runtime(str(configs), routing))

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
    target = dns._select_target(dns._collect_runtime(str(configs), json.loads(routing_path.read_text(encoding="utf-8"))))
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
