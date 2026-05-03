from __future__ import annotations

import os

from flask import Flask

from routes import service
from services import operation_diagnostics


def test_operation_diagnostics_persist_payload_and_prune_old_entries(tmp_path):
    state_dir = tmp_path / "state"

    operation_diagnostics.save_operation_diagnostic(
        str(state_dir),
        "pf-old",
        {"preflight_ref": "pf-old", "stderr": "old"},
        kind="xray-preflight",
        keep=2,
    )
    os.utime(state_dir / "operation-diagnostics" / "pf-old.json", (1, 1))
    operation_diagnostics.save_operation_diagnostic(
        str(state_dir),
        "pf-mid",
        {"preflight_ref": "pf-mid", "stderr": "mid"},
        kind="xray-preflight",
        keep=2,
    )
    operation_diagnostics.save_operation_diagnostic(
        str(state_dir),
        "pf-new",
        {"preflight_ref": "pf-new", "stderr": "new"},
        kind="xray-preflight",
        keep=2,
    )

    assert operation_diagnostics.read_operation_diagnostic(str(state_dir), "pf-old") is None
    mid = operation_diagnostics.read_operation_diagnostic(str(state_dir), "pf-mid")
    new = operation_diagnostics.read_operation_diagnostic(str(state_dir), "pf-new")

    assert mid and mid["kind"] == "xray-preflight"
    assert mid["payload"]["stderr"] == "mid"
    assert new and new["payload"]["preflight_ref"] == "pf-new"


def test_service_route_returns_operation_diagnostic_snapshot(tmp_path):
    app = Flask("operation-diagnostics-route")
    app.register_blueprint(
        service.create_service_blueprint(
            restart_xkeen=lambda **_kwargs: True,
            append_restart_log=lambda *_args, **_kwargs: None,
            XRAY_ERROR_LOG=str(tmp_path / "xray-error.log"),
            read_operation_diagnostic=lambda ref: {
                "ok": True,
                "ref": ref,
                "kind": "xray-preflight",
                "payload": {"preflight_ref": ref, "stderr": "missing outbound"},
            } if ref == "pf-test123" else None,
        )
    )

    found = app.test_client().get("/api/operation-diagnostics/pf-test123")
    missing = app.test_client().get("/api/operation-diagnostics/pf-missing")

    assert found.status_code == 200
    assert found.get_json()["payload"]["stderr"] == "missing outbound"
    assert missing.status_code == 404
    assert missing.get_json()["code"] == "operation_diagnostic_not_found"
