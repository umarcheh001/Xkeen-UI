from __future__ import annotations

import sys
from pathlib import Path

import pytest
from flask import Flask


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import routes.mihomo as mihomo_routes
from routes.mihomo import create_mihomo_blueprint
from services.mihomo_egress_setup import (
    LISTENER_NAME,
    MihomoEgressSetupError,
    build_mihomo_egress_setup,
    configured_egress_proxy_port,
)


BASE = """mode: rule
allow-lan: true
redir-port: 5000
tproxy-port: 5001
rules:
  - MATCH,DIRECT
"""


def test_egress_setup_adds_only_loopback_listener_without_global_mixed_port():
    preview = build_mihomo_egress_setup(BASE)
    assert preview.port == 17890
    assert "mixed-port:" not in preview.content
    assert f"name: {LISTENER_NAME}" in preview.content
    assert "type: mixed" in preview.content
    assert "listen: 127.0.0.1" in preview.content
    assert "udp: false" in preview.content
    assert "users: []" in preview.content
    assert "allow-lan: true" in preview.content
    assert "redir-port: 5000" in preview.content
    assert configured_egress_proxy_port(preview.content) == 17890
    assert "content" not in preview.public_dict()


def test_egress_setup_appends_to_existing_listeners_and_avoids_port_collision():
    source = BASE + "listeners:\n  - name: existing\n    type: http\n    port: 17890\n    listen: 127.0.0.1\n"
    preview = build_mihomo_egress_setup(source)
    assert preview.port == 17891
    assert preview.content.count("listeners:") == 1
    assert "name: existing" in preview.content
    assert configured_egress_proxy_port(preview.content) == 17891


def test_egress_setup_reuses_existing_global_or_private_proxy_port():
    global_preview = build_mihomo_egress_setup(BASE + "mixed-port: 7890\n")
    assert global_preview.port == 7890
    assert global_preview.changes == ()

    private = build_mihomo_egress_setup(BASE).content
    private_preview = build_mihomo_egress_setup(private)
    assert private_preview.port == 17890
    assert private_preview.changes == ()


@pytest.mark.parametrize(
    "source",
    (
        BASE + f"listeners:\n  - name: {LISTENER_NAME}\n    type: mixed\n    port: 17890\n    listen: 0.0.0.0\n",
        BASE + "listeners: [{name: existing, type: http, port: 18000}]\n",
    ),
)
def test_egress_setup_refuses_ambiguous_or_unsafe_listener_edits(source):
    with pytest.raises(MihomoEgressSetupError):
        build_mihomo_egress_setup(source)


def _app(tmp_path: Path, restart):
    config = tmp_path / "config.yaml"
    config.write_text(BASE, encoding="utf-8")
    app = Flask("egress-listener")
    app.config["TESTING"] = True
    app.register_blueprint(create_mihomo_blueprint(
        MIHOMO_CONFIG_FILE=str(config),
        MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
        MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "templates" / "custom.yaml"),
        restart_xkeen=restart,
    ))
    return app, config


def test_egress_listener_endpoint_validates_backs_up_saves_and_restarts(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(mihomo_routes, "ensure_mihomo_layout", lambda: calls.append(("layout", "")))
    monkeypatch.setattr(mihomo_routes, "validate_config", lambda new_content=None: calls.append(("validate", new_content)) or "[exit code: 0]")
    monkeypatch.setattr(mihomo_routes, "save_config", lambda content: calls.append(("save", content)) or type("Backup", (), {"filename": "before.yaml"})())
    app, config = _app(tmp_path, lambda **kwargs: calls.append(("restart", kwargs["source"])) or True)
    client = app.test_client()

    preview = client.post("/api/mihomo/security/egress-listener-preview", json={}).get_json()["preview"]
    response = client.post("/api/mihomo/security/egress-listener-apply", json={
        "confirmed": True, "preview_id": preview["preview_id"],
    })
    body = response.get_json()
    assert response.status_code == 200
    assert body["configured"] is True
    assert body["listen"] == "127.0.0.1"
    assert body["port"] == 17890
    assert [item[0] for item in calls] == ["layout", "validate", "save", "restart"]
    assert LISTENER_NAME in calls[2][1]
    assert config.read_text(encoding="utf-8") == BASE


def test_egress_listener_failed_restart_rolls_back_and_restarts_original(tmp_path, monkeypatch):
    saved = []
    restarts = []
    monkeypatch.setattr(mihomo_routes, "ensure_mihomo_layout", lambda: None)
    monkeypatch.setattr(mihomo_routes, "validate_config", lambda new_content=None: "[exit code: 0]")
    monkeypatch.setattr(mihomo_routes, "save_config", lambda content: saved.append(content) or type("Backup", (), {"filename": "before.yaml"})())

    def restart(**kwargs):
        restarts.append(kwargs["source"])
        return len(restarts) > 1

    app, _config = _app(tmp_path, restart)
    client = app.test_client()
    preview = client.post("/api/mihomo/security/egress-listener-preview", json={}).get_json()["preview"]
    response = client.post("/api/mihomo/security/egress-listener-apply", json={
        "confirmed": True, "preview_id": preview["preview_id"],
    })
    assert response.status_code == 503
    assert response.get_json()["rolled_back"] is True
    assert saved[-1] == BASE
    assert restarts == ["mihomo-egress-listener", "mihomo-egress-listener-rollback"]
