from __future__ import annotations

import importlib

from flask import Flask


routes = importlib.import_module("routes.core_profiles")
installer_module = importlib.import_module("services.core_installer")


class FakeInstaller:
    def __init__(self):
        self.selected: tuple[str, str] | None = None

    def profiles(self, engine_id: str):
        return {"engine_id": engine_id, "profiles": [], "state": {"selected_profile_id": "official"}}

    def select(self, engine_id: str, profile_id: str):
        self.selected = (engine_id, profile_id)
        return {"selected_profile_id": profile_id}

    def prepare(self, engine_id: str):
        if engine_id == "mihomo":
            raise installer_module.CoreInstallError("inactive_core", "Only the active core can be installed.")
        return {"confirmation_id": "confirm-xray", "engine_id": engine_id, "release": {"asset": {"name": "Xray-linux-64.zip"}}}

    def apply(self, engine_id: str, confirmation_id: str):
        assert confirmation_id == "confirm-xray"
        return {"operation_id": "operation-xray", "status": "running"}

    def status(self, engine_id: str, operation_id: str | None = None):
        return {"operation_id": operation_id, "engine_id": engine_id, "status": "running", "phase": "verify", "error": None}


def _client():
    app = Flask("core-profiles-routes")
    app.config["TESTING"] = True
    fake = FakeInstaller()
    app.register_blueprint(routes.create_core_profiles_blueprint("xray", fake))
    app.register_blueprint(routes.create_core_profiles_blueprint("mihomo", fake))
    return app.test_client(), fake


def test_profiles_and_source_selection_are_engine_scoped():
    client, fake = _client()

    response = client.get("/api/xray/core-profiles")
    assert response.status_code == 200
    assert response.get_json()["data"]["engine_id"] == "xray"

    response = client.post("/api/xray/core-source", json={"profile_id": "uwuray", "repo": "attacker/repo"})
    assert response.status_code == 200
    assert fake.selected == ("xray", "uwuray")
    assert response.get_json()["state"] == {"selected_profile_id": "uwuray"}


def test_prepare_apply_and_status_use_confirmation_contract():
    client, _fake = _client()

    prepared = client.post("/api/xray/core-install/prepare")
    assert prepared.status_code == 200
    assert prepared.get_json()["confirmation"]["confirmation_id"] == "confirm-xray"

    missing = client.post("/api/xray/core-install/apply", json={})
    assert missing.status_code == 400
    assert missing.get_json()["code"] == "confirmation_required"

    accepted = client.post("/api/xray/core-install/apply", json={"confirmation_id": "confirm-xray"})
    assert accepted.status_code == 202
    assert accepted.get_json()["operation"]["operation_id"] == "operation-xray"

    status = client.get("/api/xray/core-install/status?operation_id=operation-xray")
    assert status.status_code == 200
    assert status.get_json()["operation"]["phase"] == "verify"


def test_installer_errors_remain_machine_readable():
    client, _fake = _client()

    response = client.post("/api/mihomo/core-install/prepare")

    assert response.status_code == 409
    assert response.get_json()["code"] == "inactive_core"


def test_unknown_operation_id_is_not_replaced_with_another_operation():
    class UnknownOperationInstaller(FakeInstaller):
        def status(self, engine_id: str, operation_id: str | None = None):
            raise installer_module.CoreInstallError("operation_not_found", "Операция не найдена.")

    app = Flask("unknown-operation")
    app.config["TESTING"] = True
    app.register_blueprint(routes.create_core_profiles_blueprint("xray", UnknownOperationInstaller()))

    response = app.test_client().get("/api/xray/core-install/status?operation_id=missing")

    assert response.status_code == 404
    assert response.get_json()["code"] == "operation_not_found"
