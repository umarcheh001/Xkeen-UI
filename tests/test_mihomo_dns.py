from __future__ import annotations

import json
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


def test_build_refuses_existing_user_dns_without_rewriting_it():
    source = BASE + "\ndns:\n  enable: true\n  nameserver: [system]\n"

    with pytest.raises(dns.MihomoDnsError) as captured:
        dns.build_enabled_config(source)

    assert captured.value.code == "dns_conflict"


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
    assert result["listen"] == "0.0.0.0:53"
    assert result["mode"] == "redir-host"
    assert result["safety"] == {
        "preflight": True,
        "backup": True,
        "rollback": True,
        "dns_probe": True,
        "routed_doh": True,
    }


def test_existing_user_dns_is_not_claimed_as_assistant_enabled(tmp_path: Path, monkeypatch):
    config, state = _status_ready(tmp_path, monkeypatch)
    config.write_text(BASE + "\ndns:\n  enable: true\n  listen: 0.0.0.0:53\n", encoding="utf-8")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (True, "test"))

    result = dns.get_status(config_file=str(config), ui_state_dir=str(state))

    assert result["enabled"] is False
    assert result["dns_listener_configured"] is True
    assert result["can_enable"] is False
    assert any("уже есть раздел dns" in message for message in result["blockers"])


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
    assert "Mihomo preflight" in template
    assert "Полный снимок" in template
    assert "Автооткат" in template
    assert "Keenetic автоматически направляет запросы в Mihomo" in template
    assert "192.168.1.1:1054" not in template
    assert "'/api/mihomo/dns'" in script
    assert "Включить защищённый DNS" in script
    assert "mihomo_dns.js" in bundle
