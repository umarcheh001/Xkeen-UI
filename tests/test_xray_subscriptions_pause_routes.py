"""Маршруты рубильника подписок."""

from __future__ import annotations

from flask import Flask
import pytest


@pytest.fixture
def api():
    from routes import xray_subscriptions as routes

    calls: list = []
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
    return routes, app.test_client(), calls


def test_plan_route_reports_what_the_switch_would_do(api, monkeypatch):
    routes, client, calls = api
    monkeypatch.setattr(
        routes.subscription_pause,
        "plan",
        lambda **kwargs: calls.append(kwargs) or {"ok": True, "paused": False, "total": 2, "dns": {"outcome": "keep"}},
    )

    response = client.get("/api/xray/subscriptions/pause-plan")

    assert response.status_code == 200
    assert response.get_json()["dns"] == {"outcome": "keep"}
    assert calls[0]["routing_file"].replace("\\", "/") == "/tmp/xkeen-test-configs/05_routing.json"


@pytest.mark.parametrize("action", ["pause", "resume"])
def test_switch_routes_pass_the_chosen_dns_route(api, monkeypatch, action):
    routes, client, calls = api
    monkeypatch.setattr(
        routes.subscription_pause,
        action + "_all",
        lambda **kwargs: calls.append(kwargs) or {"ok": True, "paused": action == "pause", "dns": {"action": "kept"}},
    )

    response = client.post(f"/api/xray/subscriptions/{action}", json={"dns_target": "home-nl"})

    assert response.status_code == 200
    assert response.get_json()["paused"] is (action == "pause")
    assert calls[0]["dns_target"] == "home-nl"
    assert callable(calls[0]["restart_xkeen"])


def test_delete_all_route_passes_the_chosen_dns_route(api, monkeypatch):
    routes, client, calls = api
    monkeypatch.setattr(
        routes.subscription_pause,
        "delete_all",
        lambda **kwargs: calls.append(kwargs) or {"ok": True, "deleted": 3, "paused": False, "dns": {"action": "kept"}},
    )

    response = client.post("/api/xray/subscriptions/delete-all", json={"dns_target": "my-pool"})

    assert response.status_code == 200
    assert response.get_json()["deleted"] == 3
    assert calls[0]["dns_target"] == "my-pool"


def test_choice_needed_is_a_conflict_with_the_candidates(api, monkeypatch):
    routes, client, _calls = api

    def _refuse(**_kwargs):
        raise routes.subscription_pause.PauseError(
            "Выберите сервер.",
            code="dns_target_choice_required",
            details={"candidates": [{"tag": "home-nl", "kind": "outbound"}]},
        )

    monkeypatch.setattr(routes.subscription_pause, "pause_all", _refuse)

    response = client.post("/api/xray/subscriptions/pause", json={})

    body = response.get_json()
    assert response.status_code == 409
    assert body["ok"] is False
    assert body["code"] == "dns_target_choice_required"
    assert body["candidates"] == [{"tag": "home-nl", "kind": "outbound"}]


def test_list_route_says_whether_subscriptions_are_paused(api, monkeypatch):
    routes, client, _calls = api
    monkeypatch.setattr(
        routes, "list_subscriptions", lambda _dir: [{"id": "a", "paused": True, "paused_ts": 1790000000}]
    )
    monkeypatch.setattr(routes, "list_subscription_routing_balancers", lambda _dir: [])
    monkeypatch.setattr(routes, "get_subscription_routing_meta", lambda _dir: {})

    body = client.get("/api/xray/subscriptions").get_json()

    assert body["paused"] is True
    assert body["paused_ts"] == 1790000000


def test_list_carries_the_notice_of_the_last_switch(api, monkeypatch):
    routes, client, _calls = api
    monkeypatch.setattr(routes, "list_subscriptions", lambda _dir: [])
    monkeypatch.setattr(routes, "list_subscription_routing_balancers", lambda _dir: [])
    monkeypatch.setattr(routes, "get_subscription_routing_meta", lambda _dir: {})
    monkeypatch.setattr(
        routes.subscription_pause,
        "last_notice",
        lambda _dir: {"action": "pause", "warning": "Не возвращено: сервер «a».", "skipped": []},
    )

    response = client.get("/api/xray/subscriptions")

    assert response.status_code == 200
    assert response.get_json()["switch_notice"]["action"] == "pause"
