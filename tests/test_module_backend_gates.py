from __future__ import annotations

from pathlib import Path

from flask import Flask

import routes
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
    assert "devtools" not in app.blueprints
    assert "/api/mihomo/config" not in rules
    assert "/api/run-command" not in rules
    assert app.test_client().get("/api/mihomo/config").status_code == 404


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


def test_panel_defers_mihomo_top_level_import_until_gated_markup_exists():
    root = Path(__file__).resolve().parents[1]
    entry = (root / "xkeen-ui" / "static" / "js" / "pages" / "panel.entry.js").read_text(
        encoding="utf-8"
    )

    assert "import { registerPanelMihomoTopLevelScreens }" not in entry
    assert "document.querySelector('[data-xk-section=\"mihomo\"]')" in entry
    assert "await import('./top_level_panel_mihomo.shared.js')" in entry
