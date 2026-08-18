from __future__ import annotations

import importlib
import sys
from pathlib import Path

from flask import Flask


ROOT = Path(__file__).resolve().parents[1]


def _read(rel_path: str) -> str:
    return (ROOT / rel_path).read_text(encoding="utf-8")


def test_mihomo_async_restart_flow_persists_full_restart_log():
    panel_src = _read("xkeen-ui/static/js/features/mihomo_panel.js")
    route_src = _read("xkeen-ui/routes/mihomo.py")
    jobs_src = _read("xkeen-ui/services/command_jobs.py")
    restart_log_src = _read("xkeen-ui/services/restart_log.py")

    assert "const url = restart ? '/api/mihomo-config?async=1' : '/api/mihomo-config';" in panel_src
    assert "const jobId = data.restart_job_id || data.job_id || data.restartJobId || null;" in panel_src
    assert 'async_q = request.args.get("async")' in route_src
    assert 'resp.update({"restart_queued": True, "restart_job_id": job.id})' in route_src
    assert "def write_restart_log(log_file: str, raw_text: str) -> None:" in restart_log_src
    assert "def _sync_restart_log(job: \"CommandJob\" | None) -> None:" in jobs_src
    assert "write_restart_log(_restart_log_file(), payload)" in jobs_src


def test_routing_editor_save_and_restart_uses_raw_config_endpoint():
    panel_src = _read("xkeen-ui/static/js/features/mihomo_panel.js")

    save_restart_start = panel_src.index("MP.saveAndRestart = async function saveAndRestart() {")
    save_restart_end = panel_src.index("MP.openZashboardUi", save_restart_start)
    save_restart_src = panel_src[save_restart_start:save_restart_end]

    assert "fetch('/api/mihomo-config?async=1'" in save_restart_src
    assert "JSON.stringify({ content, restart: true })" in save_restart_src
    assert "/api/mihomo/generate_apply" not in save_restart_src
    assert "configOverride" not in save_restart_src


def test_raw_config_async_endpoint_saves_exact_yaml_and_queues_restart(monkeypatch, tmp_path):
    sys.path.insert(0, str(ROOT / "xkeen-ui"))
    try:
        mihomo = importlib.import_module("routes.mihomo")
    finally:
        sys.path.pop(0)

    saved = []

    class Job:
        id = "restart-job-1"

    monkeypatch.setattr(mihomo, "ensure_mihomo_layout", lambda: None)
    monkeypatch.setattr(mihomo, "save_config", lambda content: saved.append(content))
    monkeypatch.setattr(mihomo, "validate_yaml_syntax", lambda content: (bool(content.strip()), ""))
    monkeypatch.setattr(mihomo, "create_command_job", lambda **_kwargs: Job())

    app = Flask("mihomo-raw-async")
    app.register_blueprint(
        mihomo.create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(tmp_path / "config.yaml"),
            MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
            MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "default.yaml"),
            restart_xkeen=lambda **_kwargs: True,
        )
    )

    content = "mixed-port: 7890\nrules:\n  - MATCH,DIRECT\n"
    response = app.test_client().post(
        "/api/mihomo-config?async=1",
        json={"content": content, "restart": True},
    )

    assert response.status_code == 202
    assert saved == [content]
    assert response.get_json()["restart_job_id"] == "restart-job-1"


def test_raw_config_endpoint_rejects_invalid_yaml_before_saving(monkeypatch, tmp_path):
    sys.path.insert(0, str(ROOT / "xkeen-ui"))
    try:
        mihomo = importlib.import_module("routes.mihomo")
    finally:
        sys.path.pop(0)

    saved = []
    monkeypatch.setattr(mihomo, "save_config", lambda content: saved.append(content))
    monkeypatch.setattr(mihomo, "validate_yaml_syntax", lambda _content: (False, "parser detail"))

    app = Flask("mihomo-raw-invalid")
    app.register_blueprint(
        mihomo.create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(tmp_path / "config.yaml"),
            MIHOMO_TEMPLATES_DIR=str(tmp_path / "templates"),
            MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "default.yaml"),
            restart_xkeen=lambda **_kwargs: True,
        )
    )

    response = app.test_client().post(
        "/api/mihomo-config?async=1",
        json={"content": "rules: [", "restart": True},
    )

    assert response.status_code == 400
    assert response.get_json()["code"] == "yaml_invalid"
    assert saved == []
