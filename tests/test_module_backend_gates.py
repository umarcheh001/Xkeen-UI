from __future__ import annotations

from pathlib import Path

from flask import Flask

import routes
import routes.commands
import routes.happ_decryptor
import routes.mihomo
from core.context import AppContext
from core.settings import Settings
from services.module_registry import ModuleRegistry


def _context(tmp_path: Path, active_module_ids: list[str]) -> AppContext:
    state_dir = tmp_path / "state"
    registry = ModuleRegistry(str(state_dir), which=lambda _name: "/usr/bin/available")
    activation = {
        "schema_version": 1,
        "profile": "custom",
        "runtime_gates_active": True,
        "active_module_ids": active_module_ids,
        "inactive_modules": {},
    }
    registry.set_runtime_activation(activation)
    return AppContext(
        settings=Settings(
            ui_state_dir=str(state_dir),
            base_etc_dir=str(tmp_path / "etc"),
            base_var_dir=str(tmp_path / "var"),
        ),
        logger=Flask("module-gate-log").logger,
        module_registry=registry,
        module_activation=activation,
        ui_state_dir=str(state_dir),
        github_owner="owner",
        github_repo="repo",
        mihomo_config_file=str(tmp_path / "mihomo" / "config.yaml"),
        mihomo_templates_dir=str(tmp_path / "mihomo" / "templates"),
        mihomo_default_template=str(tmp_path / "mihomo" / "templates" / "custom.yaml"),
        xray_configs_dir=str(tmp_path / "xray"),
        xray_configs_dir_real=str(tmp_path / "xray"),
        routing_file=str(tmp_path / "xray" / "05_routing.json"),
        routing_file_raw=str(tmp_path / "xray" / "05_routing.jsonc"),
        inbounds_file=str(tmp_path / "xray" / "03_inbounds.json"),
        outbounds_file=str(tmp_path / "xray" / "04_outbounds.json"),
        backup_dir=str(tmp_path / "backups"),
        backup_dir_real=str(tmp_path / "backups"),
        xray_error_log=str(tmp_path / "xray-error.log"),
        load_json=lambda *_args, **_kwargs: {},
        save_json=lambda *_args, **_kwargs: None,
        strip_json_comments_text=lambda value: value,
        snapshot_xray_config_before_overwrite=lambda *_args, **_kwargs: None,
        list_backups=lambda *_args, **_kwargs: [],
        detect_backup_target_file=lambda *_args, **_kwargs: None,
        find_latest_auto_backup_for=lambda *_args, **_kwargs: None,
        restart_xkeen=lambda *_args, **_kwargs: None,
        append_restart_log=lambda *_args, **_kwargs: None,
    )


def _register(tmp_path: Path, active_module_ids: list[str]) -> Flask:
    app = Flask("module-backend-gates")
    app.config["TESTING"] = True
    routes.register_blueprints(app, _context(tmp_path, active_module_ids))
    return app


def test_lifecycle_api_is_core_owned_and_wired_lazily(tmp_path, monkeypatch):
    monkeypatch.setenv("XKEEN_UI_PORT", "9091")
    monkeypatch.setattr(
        "services.panel_service.resolve_panel_init_script",
        lambda: "/opt/etc/init.d/S99xkeen-ui-test",
    )
    panel_restarts: list[str] = []
    monkeypatch.setattr(
        "services.panel_service.restart_panel",
        lambda source: panel_restarts.append(source) or True,
    )
    monkeypatch.setattr("services.cores.detect_running_core", lambda: "xray")

    app = _register(tmp_path, ["core"])
    rules = {rule.rule for rule in app.url_map.iter_rules()}
    service = app.extensions["xkeen.module_lifecycle"]

    assert {
        "/api/modules/installed",
        "/api/modules/available",
        "/api/modules/operations/plan",
        "/api/modules/operations/apply",
        "/api/modules/operations/status",
        "/api/modules/operations/<operation_id>/cancel",
        "/api/modules/recovery",
        "/api/modules/restart",
    } <= rules
    assert service.health_url == "http://127.0.0.1:9091/login"
    # Перезапускается сама панель: `xkeen -restart` трогает только прокси.
    assert service.restart_cmd == ("/opt/etc/init.d/S99xkeen-ui-test", "restart")
    assert service._restart_panel("module-lifecycle") is True
    assert panel_restarts == ["module-lifecycle"]
    assert service._active_engines() == frozenset({"engine.xray"})
    assert app.test_client().get("/api/modules/operations/status").status_code == 200


def test_lifecycle_port_falls_back_for_invalid_values(monkeypatch):
    for raw in ("", "not-a-port", "0", "65536"):
        monkeypatch.setenv("XKEEN_UI_PORT", raw)
        assert routes._lifecycle_port() == 8088

    monkeypatch.setenv("XKEEN_UI_PORT", "8443")
    assert routes._lifecycle_port() == 8443


def test_xray_only_registers_xray_routes_and_excludes_mihomo_tools(tmp_path):
    app = _register(tmp_path, ["core", "tool.editor", "engine.xray"])
    rules = {rule.rule for rule in app.url_map.iter_rules()}

    assert {"routing", "xray_configs", "xray_subscriptions", "xray_logs"} <= set(app.blueprints)
    assert "mihomo" not in app.blueprints
    assert "mihomo_clash" not in app.blueprints
    assert "happ_decryptor" not in app.blueprints
    assert "commands" not in app.blueprints
    assert "fs" not in app.blueprints
    assert "fileops" not in app.blueprints
    assert "devtools" in app.blueprints
    assert "/api/mihomo/config" not in rules
    assert "/api/run-command" not in rules
    assert app.test_client().get("/api/devtools/update/status").status_code == 200
    assert app.test_client().get("/api/mihomo/config").status_code == 404
    assert app.extensions["xkeen.module_owner_errors"] == []


def test_mihomo_only_registers_mihomo_routes_and_excludes_xray_tools(tmp_path):
    app = _register(tmp_path, ["core", "tool.editor", "engine.mihomo"])
    rules = {rule.rule for rule in app.url_map.iter_rules()}

    assert {"mihomo", "mihomo_clash"} <= set(app.blueprints)
    assert "routing" not in app.blueprints
    assert "xray_configs" not in app.blueprints
    assert "xray_subscriptions" not in app.blueprints
    assert "xray_logs" not in app.blueprints
    assert "commands" not in app.blueprints
    assert "fs" not in app.blueprints
    assert "fileops" not in app.blueprints
    assert "devtools" in app.blueprints
    assert "/api/xray/subscriptions" not in rules
    assert "/api/mihomo/clash/status" in rules
    assert app.test_client().get("/api/xray/subscriptions").status_code == 404


def test_disabled_module_state_is_visible_through_registry_and_capabilities(tmp_path):
    app = _register(tmp_path, ["core", "tool.editor", "engine.xray"])
    client = app.test_client()

    modules = client.get("/api/modules").get_json()
    capabilities = client.get("/api/capabilities").get_json()

    assert modules["runtime_gates_active"] is True
    assert capabilities["moduleRegistry"]["runtime_gates_active"] is True
    assert "engine.mihomo" not in app.extensions["xkeen.module_activation"]["active_module_ids"]


def test_mihomo_only_keeps_dns_stop_lifecycle_available(tmp_path):
    app = _register(tmp_path, ["core", "tool.editor", "engine.mihomo"])
    response = app.test_client().get("/api/xkeen/stop-check")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["dns_protection"]["active"] is False


def test_api_uses_running_core_for_deferred_disable_guard(tmp_path, monkeypatch):
    monkeypatch.setattr("services.cores.detect_running_core", lambda: "xray")
    app = _register(
        tmp_path,
        ["core", "tool.editor", "engine.xray", "engine.mihomo"],
    )
    client = app.test_client()

    allowed = client.patch(
        "/api/modules/engine.mihomo",
        json={"enabled": False},
    )
    assert allowed.status_code == 200

    response = client.patch(
        "/api/modules/engine.xray",
        json={"enabled": False},
    )

    assert response.status_code == 409
    assert response.get_json()["code"] == "active_core_module"


def test_advanced_diagnostics_routes_are_not_exposed_when_optional_module_is_off(tmp_path):
    app = _register(tmp_path, ["core", "tool.editor", "engine.xray"])
    client = app.test_client()

    assert client.get("/api/devtools/update/status").status_code == 200
    assert client.get("/api/devtools/env").status_code == 404
    assert client.get("/api/system/resources").status_code == 404


def test_optional_module_factory_failures_do_not_stop_core(tmp_path, monkeypatch):
    monkeypatch.setattr(
        routes.mihomo,
        "create_mihomo_blueprint",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("mihomo-init")),
    )
    app = _register(tmp_path / "mihomo", ["core", "tool.editor", "engine.mihomo"])
    assert app.test_client().get("/api/modules").status_code == 200
    mihomo = next(
        item
        for item in app.test_client().get("/api/modules").get_json()["modules"]
        if item["id"] == "engine.mihomo"
    )
    assert mihomo["status"] == "failed"

    monkeypatch.setattr(
        routes.commands,
        "create_commands_blueprint",
        lambda: (_ for _ in ()).throw(RuntimeError("terminal-init")),
    )
    app = _register(tmp_path / "terminal", ["core", "tool.terminal"])
    assert app.test_client().get("/api/modules").status_code == 200
    terminal = next(
        item
        for item in app.test_client().get("/api/modules").get_json()["modules"]
        if item["id"] == "tool.terminal"
    )
    assert terminal["status"] == "failed"

    monkeypatch.setattr(
        routes.happ_decryptor,
        "create_happ_decryptor_blueprint",
        lambda: (_ for _ in ()).throw(RuntimeError("integration-init")),
    )
    app = _register(tmp_path / "integration", ["core", "integration.happ"])
    assert app.test_client().get("/api/modules").status_code == 200
    integration = next(
        item
        for item in app.test_client().get("/api/modules").get_json()["modules"]
        if item["id"] == "integration.happ"
    )
    assert integration["status"] == "failed"


def _module_status(app: Flask, module_id: str) -> str:
    payload = app.test_client().get("/api/modules").get_json()
    return next(item for item in payload["modules"] if item["id"] == module_id)["status"]


def test_xray_backups_and_files_factory_failures_do_not_stop_core(tmp_path, monkeypatch):
    import routes.backups
    import routes.storage_usb
    import routes.xray_logs

    def boom(*_args, **_kwargs):
        raise RuntimeError("init")

    monkeypatch.setattr(routes.xray_logs, "create_xray_logs_blueprint", boom)
    app = _register(tmp_path / "xray", ["core", "tool.editor", "engine.xray"])
    assert _module_status(app, "engine.xray") == "failed"
    # The module's earlier blueprints are not left half-registered.
    assert "routing" not in app.blueprints
    assert "service" in app.blueprints

    monkeypatch.setattr(routes.backups, "create_backups_blueprint", boom)
    app = _register(tmp_path / "backups", ["core", "tool.backups"])
    assert _module_status(app, "tool.backups") == "failed"

    monkeypatch.setattr(routes.storage_usb, "create_storage_usb_blueprint", boom)
    app = _register(tmp_path / "files", ["core", "tool.files"])
    assert _module_status(app, "tool.files") == "failed"


def test_mihomo_is_not_half_registered_when_second_blueprint_fails(tmp_path, monkeypatch):
    import routes.mihomo_clash

    monkeypatch.setattr(
        routes.mihomo_clash,
        "create_mihomo_clash_blueprint",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("clash-init")),
    )
    app = _register(tmp_path, ["core", "tool.editor", "engine.mihomo"])

    assert "mihomo" not in app.blueprints
    assert "mihomo_clash" not in app.blueprints
    assert _module_status(app, "engine.mihomo") == "failed"


def test_stage3_closure_is_reflected_in_documentation():
    root = Path(__file__).resolve().parents[1]
    plan = (root / "README-modular-panel-plan.md").read_text(encoding="utf-8")
    contract = (root / "docs" / "modular-panel-stage3-backend-gates.md").read_text(
        encoding="utf-8"
    )
    docs_index = (root / "docs" / "README.md").read_text(encoding="utf-8")

    for fragment in (
        "## Этап 3. Backend gates — закрыт",
        "Статус этапа: **закрыт 29 сентября 2026 года**.",
        "Критерий готовности: **выполнен**.",
        "docs/modular-panel-stage3-backend-gates.md",
    ):
        assert fragment in plan

    for fragment in (
        "Статус:** закрыт 29 сентября 2026 года",
        "UI_STATE_DIR/module-runtime.json",
        "runtime_gates_active: true",
        "Критерий готовности Этапа 3: **выполнен**.",
        "Этап 4 — разделение frontend shell и экранов",
    ):
        assert fragment in contract

    assert "modular-panel-stage3-backend-gates.md" in docs_index
