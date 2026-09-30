"""Server-side render of the panel page for a given active module set."""

from __future__ import annotations

from pathlib import Path

from flask import Flask


ROOT = Path(__file__).resolve().parents[2]

FULL_MODULE_IDS = [
    "core",
    "engine.xray",
    "engine.mihomo",
    "tool.editor",
    "tool.terminal",
    "tool.files",
    "tool.backups",
    "integration.happ",
    "tool.advanced-diagnostics",
]
XRAY_MINIMAL_MODULE_IDS = ["core", "tool.editor", "engine.xray"]
MIHOMO_MINIMAL_MODULE_IDS = ["core", "tool.editor", "engine.mihomo"]


def render_panel(active_module_ids: list[str], tmp_path: Path) -> str:
    from routes.pages import register_pages_routes
    from routes.ui_assets import init_ui_assets_helpers, register_build_stamp_global

    app = Flask(
        "panel-profile",
        root_path=str(ROOT / "xkeen-ui"),
        static_folder="static",
        template_folder="templates",
    )
    init_ui_assets_helpers(app)
    register_build_stamp_global(app, str(tmp_path))
    # Endpoints owned by other blueprints; the page only builds their URLs.
    app.add_url_rule("/logout", "logout_post", lambda: "", methods=["POST"])
    app.add_url_rule("/terminal-theme.css", "terminal_theme_css", lambda: "")
    app.context_processor(lambda: {"csrf_token": "token", "terminal_theme_v": 0})
    register_pages_routes(
        app,
        module_activation={"active_module_ids": active_module_ids},
        ROUTING_FILE=str(tmp_path / "05_routing.json"),
        MIHOMO_CONFIG_FILE=str(tmp_path / "config.yaml"),
        INBOUNDS_FILE=str(tmp_path / "03_inbounds.json"),
        OUTBOUNDS_FILE=str(tmp_path / "04_outbounds.json"),
        BACKUP_DIR=str(tmp_path / "backups"),
        COMMAND_GROUPS=[],
        GITHUB_REPO_URL="https://example.invalid/repo",
    )
    response = app.test_client().get("/")
    assert response.status_code == 200
    return response.get_data(as_text=True)
