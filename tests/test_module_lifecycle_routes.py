from __future__ import annotations

import json

import pytest
from flask import Flask

from routes.modules import create_modules_blueprint
from services.module_lifecycle import ModuleLifecycleError
from services.request_limits import install_request_size_guards


class RegistryFake:
    def get_registry(self):
        return {"ok": True, "modules": []}

    def set_profile(self, profile, *, module_ids=None, editor_variant=None):
        return ({"ok": True, "profile": profile, "diff": {}}, True)


class LifecycleFake:
    def __init__(self) -> None:
        self.calls = []
        self.failure = None

    def _result(self, call, payload):
        self.calls.append(call)
        if self.failure is not None:
            raise self.failure
        return payload

    def installed(self):
        return self._result(("installed",), {"ok": True, "kind": "installed"})

    def available(self):
        return self._result(("available",), {"ok": True, "kind": "available"})

    def update_channel(self):
        return self._result(("update_channel",), {"ok": True, "channel": "stable"})

    def set_update_channel(self, channel):
        return self._result(("set_update_channel", channel), {"ok": True, "channel": channel})

    def panel_update_check(self, *, force_refresh=False):
        return self._result(
            ("panel_update_check", force_refresh),
            {
                "ok": True,
                "source_version": "2.10.0",
                "target_version": "2.11.0",
                "update_available": True,
                "requires_installer": False,
                "min_updater": None,
            },
        )

    def plan(self, operation, module_id=None):
        return self._result(
            ("plan", operation, module_id),
            {"ok": True, "applicable": True, "plan_id": "a" * 64},
        )

    def apply(self, operation, module_id, plan_id):
        return self._result(
            ("apply", operation, module_id, plan_id),
            {"ok": True, "operation_id": "20261006T120000Z-abcdef"},
        )

    def status(self):
        return self._result(("status",), {"ok": True, "result": "running"})

    def cancel(self, operation_id):
        return self._result(
            ("cancel", operation_id),
            {"ok": True, "operation_id": operation_id, "cancel_requested": True},
        )

    def recover(self):
        return self._result(
            ("recover",), {"ok": True, "recovery_result": "rolled_back"}
        )

    def restart(self):
        return self._result(("restart",), {"ok": True, "restart_requested": True})

    def profile_transition_status(self):
        return self._result(
            ("profile_transition_status",),
            {
                "transition_required": True,
                "transition_target": {
                    "profile": "xray-minimal",
                    "module_ids": ["core", "engine.xray", "tool.editor"],
                    "editor_variant": "light",
                },
            },
        )


class NotificationCenterFake:
    def __init__(self):
        self.calls = []

    def snapshot(self):
        self.calls.append(("snapshot",))
        return {
            "ok": True,
            "channel": "stable",
            "records": [],
            "unread_count": 0,
            "status": {},
        }

    def check(self, *, force_refresh=False):
        self.calls.append(("check", force_refresh))
        return self.snapshot()

    def mark_seen(self, record_ids=None):
        self.calls.append(("mark_seen", record_ids))
        return self.snapshot()

    def set_record_state(self, record_id, action, *, snooze_seconds=None):
        self.calls.append(("set_record_state", record_id, action, snooze_seconds))
        return self.snapshot()

    def wake_background(self):
        self.calls.append(("wake_background",))


@pytest.fixture
def app_with_lifecycle():
    service = LifecycleFake()
    notifications = NotificationCenterFake()
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(
        create_modules_blueprint(
            RegistryFake(),
            lifecycle_service=service,
            notification_center=notifications,
        )
    )
    return app.test_client(), service, notifications


def test_lifecycle_read_and_control_routes_delegate_with_no_store(app_with_lifecycle):
    client, service, _notifications = app_with_lifecycle
    requests = [
        ("get", "/api/modules/installed", None, 200, "installed"),
        ("get", "/api/modules/available", None, 200, "available"),
        ("get", "/api/modules/update-channel", None, 200, "update_channel"),
        ("get", "/api/modules/operations/status", None, 200, "status"),
        (
            "post",
            "/api/modules/operations/20261006T120000Z-abcdef/cancel",
            None,
            202,
            "cancel",
        ),
        ("post", "/api/modules/recovery", None, 200, "recover"),
        ("post", "/api/modules/restart", None, 200, "restart"),
    ]

    for method, path, body, expected_status, call_name in requests:
        response = getattr(client, method)(path, json=body)
        assert response.status_code == expected_status
        assert response.get_json()["ok"] is True
        assert response.headers["Cache-Control"] == "no-store"
        assert service.calls[-1][0] == call_name


def test_update_channel_route_requires_a_single_channel_field(app_with_lifecycle):
    client, service, notifications = app_with_lifecycle
    response = client.post("/api/modules/update-channel", json={"channel": "prerelease"})
    assert response.status_code == 200
    assert response.get_json()["channel"] == "prerelease"
    assert service.calls[-1] == ("set_update_channel", "prerelease")
    assert ("wake_background",) in notifications.calls

    invalid = client.post("/api/modules/update-channel", json={"channel": "stable", "repository": "other"})
    assert invalid.status_code == 400
    assert service.calls[-1] == ("set_update_channel", "prerelease")


class PreparerFake:
    def __init__(self):
        self.calls = []

    def _snapshot(self, prepare_id="p1", state="running"):
        return {"prepare_id": prepare_id, "state": state, "phase": "downloading", "plan": None, "error": None}

    def start(self):
        self.calls.append(("start",))
        return self._snapshot()

    def status(self, prepare_id):
        self.calls.append(("status", prepare_id))
        if prepare_id != "p1":
            raise ModuleLifecycleError("panel_prepare_unknown", "panel update preparation is not known", status=404)
        return self._snapshot(prepare_id)

    def cancel(self, prepare_id):
        self.calls.append(("cancel", prepare_id))
        return self._snapshot(prepare_id)


@pytest.fixture
def app_with_preparer():
    preparer = PreparerFake()
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(
        create_modules_blueprint(
            RegistryFake(),
            lifecycle_service=LifecycleFake(),
            notification_center=NotificationCenterFake(),
            panel_update_preparer=preparer,
        )
    )
    return app.test_client(), preparer


def test_panel_prepare_routes_start_poll_and_cancel(app_with_preparer):
    client, preparer = app_with_preparer

    started = client.post("/api/modules/panel/prepare", json={})
    polled = client.get("/api/modules/panel/prepare/p1")
    cancelled = client.post("/api/modules/panel/prepare/p1/cancel", json={})

    for response in (started, polled, cancelled):
        assert response.status_code == 200
        assert response.get_json()["ok"] is True
        assert response.get_json()["prepare_id"] == "p1"
        assert response.headers["Cache-Control"] == "no-store"
    assert preparer.calls == [("start",), ("status", "p1"), ("cancel", "p1")]


def test_panel_prepare_unknown_is_404(app_with_preparer):
    client, _preparer = app_with_preparer

    response = client.get("/api/modules/panel/prepare/nope")

    assert response.status_code == 404
    assert response.get_json()["code"] == "panel_prepare_unknown"


def test_panel_prepare_rejects_body_fields(app_with_preparer):
    client, preparer = app_with_preparer

    response = client.post("/api/modules/panel/prepare", json={"operation": "panel-update"})

    assert response.status_code == 400
    assert response.get_json()["code"] == "unsupported_lifecycle_fields"
    assert preparer.calls == []


def test_lifecycle_plan_and_apply_routes_validate_and_delegate(app_with_lifecycle):
    client, service, _notifications = app_with_lifecycle

    planned = client.post(
        "/api/modules/operations/plan",
        json={"operation": "install", "module_id": "tool.terminal"},
    )
    applied = client.post(
        "/api/modules/operations/apply",
        json={
            "operation": "install",
            "module_id": "tool.terminal",
            "plan_id": "a" * 64,
        },
    )

    assert planned.status_code == 200
    assert applied.status_code == 202
    assert service.calls == [
        ("plan", "install", "tool.terminal"),
        ("apply", "install", "tool.terminal", "a" * 64),
    ]
    assert planned.headers["Cache-Control"] == "no-store"
    assert applied.headers["Cache-Control"] == "no-store"


def test_panel_update_check_is_core_owned_and_does_not_create_a_plan(app_with_lifecycle):
    client, service, _notifications = app_with_lifecycle

    response = client.post(
        "/api/modules/panel/update-check",
        json={"force_refresh": True},
    )

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.get_json() == {
        "ok": True,
        "source_version": "2.10.0",
        "target_version": "2.11.0",
        "update_available": True,
        "requires_installer": False,
        "min_updater": None,
    }
    assert service.calls == [("panel_update_check", True)]


def test_notification_routes_are_core_owned_and_support_state_actions(app_with_lifecycle):
    client, _service, notifications = app_with_lifecycle

    snapshot = client.get("/api/notifications")
    assert snapshot.status_code == 200
    assert snapshot.get_json()["unread_count"] == 0
    assert notifications.calls[-1] == ("snapshot",)

    checked = client.post("/api/modules/notifications/check", json={"force_refresh": True})
    assert checked.status_code == 200
    assert notifications.calls[-2:] == [("check", True), ("snapshot",)]

    updated = client.patch(
        "/api/notifications/" + "a" * 64,
        json={"action": "dismiss"},
    )
    assert updated.status_code == 200
    assert notifications.calls[-2:] == [
        ("set_record_state", "a" * 64, "dismiss", None),
        ("snapshot",),
    ]


def test_full_scope_plan_and_apply_routes_omit_module_id(app_with_lifecycle):
    client, service, _notifications = app_with_lifecycle

    planned = client.post("/api/modules/operations/plan", json={"operation": "panel-update"})
    applied = client.post(
        "/api/modules/operations/apply",
        json={"operation": "panel-update", "plan_id": "a" * 64},
    )

    assert planned.status_code == 200
    assert applied.status_code == 202
    assert service.calls == [
        ("plan", "panel-update", None),
        ("apply", "panel-update", None, "a" * 64),
    ]


def test_profile_route_adds_physical_transition_status_without_applying_it(app_with_lifecycle):
    client, service, _notifications = app_with_lifecycle

    response = client.post("/api/modules/profile", json={"profile": "xray-minimal"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["profile"] == "xray-minimal"
    assert payload["changed"] is True
    assert payload["transition_required"] is True
    assert payload["transition_target"]["module_ids"] == ["core", "engine.xray", "tool.editor"]
    assert service.calls == [("profile_transition_status",)]


@pytest.mark.parametrize(
    ("path", "body", "code"),
    [
        ("/api/modules/operations/plan", [], "invalid_payload"),
        (
            "/api/modules/operations/plan",
            {"operation": "install", "module_id": "tool.terminal", "files": []},
            "unsupported_lifecycle_fields",
        ),
        (
            "/api/modules/operations/plan",
            {"module_id": "tool.terminal"},
            "lifecycle_field_required",
        ),
        (
            "/api/modules/operations/apply",
            {"operation": "install", "module_id": "tool.terminal"},
            "lifecycle_field_required",
        ),
        (
            "/api/modules/operations/apply",
            {
                "operation": "install",
                "module_id": "tool.terminal",
                "plan_id": "A" * 64,
            },
            "module_plan_id_invalid",
        ),
    ],
)
def test_lifecycle_body_validation_rejects_bad_requests(
    app_with_lifecycle, path, body, code
):
    client, service, _notifications = app_with_lifecycle

    response = client.post(path, json=body)

    assert response.status_code == 400
    assert response.get_json()["code"] == code
    assert service.calls == []


def test_lifecycle_body_validation_rejects_payload_over_8_kib(app_with_lifecycle):
    client, service, _notifications = app_with_lifecycle
    body = json.dumps(
        {"operation": "install", "module_id": "tool.terminal", "padding": "x" * 8192}
    )

    response = client.post(
        "/api/modules/operations/plan",
        data=body,
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.get_json()["code"] == "payload_too_large"
    assert service.calls == []


def test_lifecycle_body_validation_bounds_stream_without_content_length(
    app_with_lifecycle,
):
    client, service, _notifications = app_with_lifecycle
    body = json.dumps(
        {"operation": "install", "module_id": "tool.terminal", "padding": "x" * 8192}
    )

    response = client.open(
        "/api/modules/operations/plan",
        method="POST",
        data=body,
        content_type="application/json",
        environ_overrides={"CONTENT_LENGTH": "", "wsgi.input_terminated": True},
    )

    assert response.status_code == 400
    assert response.get_json()["code"] == "payload_too_large"
    assert service.calls == []


def test_lifecycle_domain_error_preserves_safe_code_status_and_details(
    app_with_lifecycle,
):
    client, service, _notifications = app_with_lifecycle
    service.failure = ModuleLifecycleError(
        "operation_not_found",
        "the module operation does not exist",
        status=404,
        operation_id="unknown",
    )

    response = client.post("/api/modules/operations/unknown/cancel")

    assert response.status_code == 404
    assert response.get_json() == {
        "ok": False,
        "error": "the module operation does not exist",
        "code": "operation_not_found",
        "operation_id": "unknown",
    }


def test_lifecycle_unexpected_error_is_sanitized(app_with_lifecycle):
    client, service, _notifications = app_with_lifecycle
    service.failure = RuntimeError("secret archive path")

    response = client.get("/api/modules/available")

    assert response.status_code == 500
    payload = response.get_json()
    assert payload["code"] == "module_lifecycle_failed"
    assert "secret archive path" not in json.dumps(payload)


def test_missing_lifecycle_service_only_disables_new_routes():
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(create_modules_blueprint(RegistryFake()))
    client = app.test_client()

    assert client.get("/api/modules").status_code == 200
    unavailable = client.get("/api/modules/installed")
    assert unavailable.status_code == 503
    assert unavailable.get_json()["code"] == "module_lifecycle_unavailable"


def test_lifecycle_json_remains_readable_after_production_size_guard():
    service = LifecycleFake()
    app = Flask(__name__)
    app.config["TESTING"] = True
    install_request_size_guards(app)
    app.register_blueprint(
        create_modules_blueprint(RegistryFake(), lifecycle_service=service)
    )

    response = app.test_client().post(
        "/api/modules/operations/plan",
        json={"operation": "install", "module_id": "tool.terminal"},
    )

    assert response.status_code == 200
    assert service.calls == [("plan", "install", "tool.terminal")]
