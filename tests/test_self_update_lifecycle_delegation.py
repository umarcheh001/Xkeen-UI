from __future__ import annotations

import os
from unittest.mock import patch

from flask import Flask

from routes.devtools import create_devtools_blueprint


class Lifecycle:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def plan(self, operation, module_id=None):
        self.calls.append(("plan", operation, module_id))
        return {
            "ok": True,
            "scope": "panel",
            "operation": "panel-update",
            "source_version": "1.0.0",
            "target_version": "1.1.0",
            "applicable": True,
            "blockers": [],
            "plan_id": "a" * 64,
        }

    def apply(self, operation, module_id, plan_id):
        self.calls.append(("apply", operation, module_id, plan_id))
        return {"ok": True, "operation_id": "20261007T120000Z-abcdef", "status": {"result": "running"}}

    def status(self):
        self.calls.append(("status",))
        return {
            "ok": True,
            "scope": "panel",
            "operation": "panel-update",
            "operation_id": "20261007T120000Z-abcdef",
            "step": "downloading",
            "result": "running",
            "error_code": None,
            "error": None,
            "log": [],
        }


def _client(tmp_path, lifecycle: Lifecycle):
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(create_devtools_blueprint(str(tmp_path), lifecycle_service=lifecycle))
    return app.test_client()


def test_stable_check_uses_lifecycle_panel_plan(tmp_path) -> None:
    lifecycle = Lifecycle()
    with patch.dict(os.environ, {"XKEEN_UI_UPDATE_CHANNEL": "stable"}, clear=False):
        response = _client(tmp_path, lifecycle).post("/api/devtools/update/check", json={"force_refresh": True})

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["channel"] == "stable"
    assert payload["update_available"] is True
    assert payload["current"]["version"] == "1.0.0"
    assert payload["latest"]["version"] == "1.1.0"
    assert lifecycle.calls == [("plan", "panel-update", None)]


def test_stable_run_ignores_client_resolved_authority_and_applies_server_plan(tmp_path) -> None:
    lifecycle = Lifecycle()
    with patch.dict(os.environ, {"XKEEN_UI_UPDATE_CHANNEL": "stable"}, clear=False):
        response = _client(tmp_path, lifecycle).post(
            "/api/devtools/update/run",
            json={
                "resolved": {
                    "asset_url": "https://example.invalid/evil.tar.gz",
                    "sha256": "0" * 64,
                }
            },
        )

    assert response.status_code == 202
    assert response.get_json()["operation_id"] == "20261007T120000Z-abcdef"
    assert lifecycle.calls == [
        ("plan", "panel-update", None),
        ("apply", "panel-update", None, "a" * 64),
    ]


def test_stable_status_projects_lifecycle_operation(tmp_path) -> None:
    lifecycle = Lifecycle()
    with patch.dict(os.environ, {"XKEEN_UI_UPDATE_CHANNEL": "stable"}, clear=False):
        response = _client(tmp_path, lifecycle).get("/api/devtools/update/status")

    payload = response.get_json()
    assert payload["status"]["state"] == "running"
    assert payload["status"]["step"] == "downloading"
    assert payload["status"]["operation_id"] == "20261007T120000Z-abcdef"
    assert lifecycle.calls == [("status",)]


def test_main_channel_keeps_legacy_check_path(tmp_path) -> None:
    lifecycle = Lifecycle()
    with patch.dict(os.environ, {"XKEEN_UI_UPDATE_CHANNEL": "main"}, clear=False), patch(
        "routes.devtools.get_build_info",
        return_value={"version": "1.0.0", "channel": "main", "repo": "umarcheh001/Xkeen-UI"},
    ), patch(
        "routes.devtools.github_get_latest_main",
        return_value=({"ok": True, "latest": {"sha": "abc"}, "meta": {}}, False),
    ):
        response = _client(tmp_path, lifecycle).post("/api/devtools/update/check", json={})

    assert response.status_code == 200
    assert response.get_json()["development_only"] is True
    assert lifecycle.calls == []
