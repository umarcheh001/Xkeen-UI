from __future__ import annotations

import sys
from pathlib import Path

from flask import Flask

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from services.mihomo_panel_switch import (
    build_switch_preview,
    load_state,
    public_status,
    remember_external_config,
)
from routes.mihomo import create_mihomo_blueprint
import routes.mihomo as mihomo_routes


EXTERNAL = """mode: rule
external-controller: 0.0.0.0:9090
secret: keep-me
external-ui: zashboard
rules: []
"""


def test_switch_preserves_dashboard_and_unrelated_config(tmp_path: Path):
    state_file = tmp_path / "switch.json"
    state = remember_external_config(state_file, EXTERNAL)

    xkeen = build_switch_preview(EXTERNAL, state, "xkeen")
    assert "external-controller: 127.0.0.1:9090" in xkeen.content
    assert "__XKEEN_GENERATED_SECRET__" in xkeen.content
    assert "external-ui: zashboard" in xkeen.content
    assert "rules: []" in xkeen.content
    assert "keep-me" not in xkeen.content

    edited = xkeen.content.replace("rules: []", "rules:\n  - MATCH,DIRECT")
    restored = build_switch_preview(edited, load_state(state_file), "external")
    assert "external-controller: 0.0.0.0:9090" in restored.content
    assert "secret: keep-me" in restored.content
    assert "external-controller-unix" not in restored.content
    assert "external-ui: zashboard" in restored.content
    assert "MATCH,DIRECT" in restored.content


def test_state_does_not_store_complete_user_config(tmp_path: Path):
    state_file = tmp_path / "switch.json"
    remember_external_config(state_file, EXTERNAL + "proxy-password: ultra-secret\n")
    stored = state_file.read_text(encoding="utf-8")
    assert "proxy-password" not in stored
    assert "ultra-secret" not in stored
    assert "external-controller: 0.0.0.0:9090" in stored
    assert "secret: keep-me" in stored


def test_status_offers_both_directions_after_snapshot(tmp_path: Path):
    state_file = tmp_path / "switch.json"
    state = remember_external_config(state_file, EXTERNAL)
    external_status = public_status(EXTERNAL, state)
    assert external_status["mode"] == "external"
    assert external_status["can_enable_xkeen"] is True
    assert external_status["panel_name"] == "Zashboard"

    xkeen = build_switch_preview(EXTERNAL, state, "xkeen").content
    xkeen_status = public_status(xkeen, {**state, "mode": "xkeen"})
    assert xkeen_status["mode"] == "xkeen"
    assert xkeen_status["can_restore_external"] is True
    assert xkeen_status["external_url"] == "/mihomo_panel/ui/"


def test_loopback_dashboard_is_also_remembered(tmp_path: Path):
    state_file = tmp_path / "switch.json"
    loopback = EXTERNAL.replace("0.0.0.0:9090", "127.0.0.1:9090")
    state = remember_external_config(state_file, loopback)
    assert state["external_directives"][0] == "external-controller: 127.0.0.1:9090"
    assert public_status(loopback, state)["mode"] == "external"


def test_frontend_has_one_button_round_trip_contract():
    markup = (APP_DIR / "templates" / "panel.html").read_text(encoding="utf-8")
    client = (APP_DIR / "static" / "js" / "features" / "mihomo_clash" / "client.js").read_text(encoding="utf-8")
    index = (APP_DIR / "static" / "js" / "features" / "mihomo_clash" / "index.js").read_text(encoding="utf-8")
    assert 'id="mihomo-clash-panel-switch"' in markup
    assert "/api/mihomo/security/panel-switch-preview" in client
    assert "/api/mihomo/security/panel-switch" in client
    assert "Вернуться в Xkeen Clash API" in index
    assert "Вернуть ${panelName}" in index


def _switch_app(tmp_path: Path, config: Path, restart):
    app = Flask("mihomo-panel-switch")
    app.config["TESTING"] = True
    app.register_blueprint(create_mihomo_blueprint(
        MIHOMO_CONFIG_FILE=str(config),
        MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
        MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "templates" / "custom.yaml"),
        restart_xkeen=restart,
        ui_state_dir=str(tmp_path / "state"),
    ))
    return app


def test_switch_endpoint_saves_and_can_return_to_external(tmp_path: Path, monkeypatch):
    config = tmp_path / "config.yaml"
    config.write_text(EXTERNAL, encoding="utf-8")
    saved: list[str] = []
    monkeypatch.setattr(mihomo_routes, "ensure_mihomo_layout", lambda: None)
    monkeypatch.setattr(mihomo_routes, "validate_config", lambda new_content=None: "[exit code: 0]")
    monkeypatch.setattr(mihomo_routes, "save_config", lambda content: saved.append(content))
    client = _switch_app(tmp_path, config, lambda **_: True).test_client()

    preview = client.post(
        "/api/mihomo/security/panel-switch-preview", json={"target": "xkeen"}
    ).get_json()
    response = client.post("/api/mihomo/security/panel-switch", json={
        "target": "xkeen", "preview_id": preview["preview_id"], "confirmed": True,
    })
    assert response.status_code == 200
    assert response.get_json()["mode"] == "xkeen"
    assert "external-controller: 127.0.0.1:9090" in saved[-1]
    assert "__XKEEN_GENERATED_SECRET__" not in saved[-1]


def test_failed_switch_immediately_restores_previous_config(tmp_path: Path, monkeypatch):
    config = tmp_path / "config.yaml"
    config.write_text(EXTERNAL, encoding="utf-8")
    saved: list[str] = []
    restarts: list[str] = []
    monkeypatch.setattr(mihomo_routes, "ensure_mihomo_layout", lambda: None)
    monkeypatch.setattr(mihomo_routes, "validate_config", lambda new_content=None: "[exit code: 0]")
    monkeypatch.setattr(mihomo_routes, "save_config", lambda content: saved.append(content))

    def restart(**kwargs):
        restarts.append(str(kwargs.get("source") or ""))
        return len(restarts) > 1

    client = _switch_app(tmp_path, config, restart).test_client()
    preview = client.post(
        "/api/mihomo/security/panel-switch-preview", json={"target": "xkeen"}
    ).get_json()
    response = client.post("/api/mihomo/security/panel-switch", json={
        "target": "xkeen", "preview_id": preview["preview_id"], "confirmed": True,
    })
    body = response.get_json()
    assert response.status_code == 503
    assert body["rolled_back"] is True
    assert saved[-1] == EXTERNAL
    assert restarts == ["mihomo-panel-xkeen", "mihomo-panel-switch-rollback"]


def test_restart_exception_also_restores_previous_config(tmp_path: Path, monkeypatch):
    config = tmp_path / "config.yaml"
    config.write_text(EXTERNAL, encoding="utf-8")
    saved: list[str] = []
    restarts = 0
    monkeypatch.setattr(mihomo_routes, "ensure_mihomo_layout", lambda: None)
    monkeypatch.setattr(mihomo_routes, "validate_config", lambda new_content=None: "[exit code: 0]")
    monkeypatch.setattr(mihomo_routes, "save_config", lambda content: saved.append(content))

    def restart(**_kwargs):
        nonlocal restarts
        restarts += 1
        if restarts == 1:
            raise RuntimeError("restart transport vanished")
        return True

    client = _switch_app(tmp_path, config, restart).test_client()
    preview = client.post(
        "/api/mihomo/security/panel-switch-preview", json={"target": "xkeen"}
    ).get_json()
    response = client.post("/api/mihomo/security/panel-switch", json={
        "target": "xkeen", "preview_id": preview["preview_id"], "confirmed": True,
    })
    assert response.status_code == 503
    assert response.get_json()["rolled_back"] is True
    assert saved[-1] == EXTERNAL
