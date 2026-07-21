from __future__ import annotations

from flask import Flask
import pytest


def _client(monkeypatch, probe):
    from routes import xray_subscriptions as routes

    monkeypatch.setattr(routes, "probe_subscription_node_latency", probe)
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(
        routes.create_xray_subscriptions_blueprint(
            ui_state_dir="/tmp/xkeen-test-state",
            xray_configs_dir="/tmp/xkeen-test-configs",
            restart_xkeen=lambda **_kwargs: True,
            snapshot_xray_config_before_overwrite=lambda _path: None,
        )
    )
    return app.test_client()


def test_single_node_ping_connectivity_failure_is_completed_http_200(monkeypatch):
    client = _client(
        monkeypatch,
        lambda *_args, **_kwargs: {
            "ok": False,
            "id": "demo",
            "node_key": "node-1",
            "error": "connection timed out",
        },
    )

    response = client.post(
        "/api/xray/subscriptions/demo/nodes/ping",
        json={"node_key": "node-1"},
    )

    assert response.status_code == 200
    assert response.get_json() == {
        "ok": False,
        "id": "demo",
        "node_key": "node-1",
        "error": "connection timed out",
    }


@pytest.mark.parametrize(
    ("failure", "expected_status"),
    [
        (ValueError("node_key is required"), 400),
        (KeyError("subscription not found"), 404),
        (KeyError("node not found"), 404),
    ],
)
def test_single_node_ping_keeps_request_failures_as_4xx(monkeypatch, failure, expected_status):
    def _probe(*_args, **_kwargs):
        raise failure

    client = _client(monkeypatch, _probe)

    response = client.post(
        "/api/xray/subscriptions/demo/nodes/ping",
        json={"node_key": "node-1"},
    )

    assert response.status_code == expected_status
    assert response.get_json()["ok"] is False
