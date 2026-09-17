"""Маршруты выравнивания расписания подписок.

Панель сначала спрашивает план с ``?dry=1`` и показывает его в диалоге, а
пишет состояние вторым запросом — уже после согласия. Поэтому холостой расчёт
и запись обязаны быть разными вызовами одного маршрута, а не одним действием
«посчитал и сразу применил».
"""

from __future__ import annotations

import pytest
from flask import Flask


PLAN = {
    "anchor_ts": 1_789_003_600.0,
    "anchor_deferred": False,
    "overdue_count": 0,
    "moves": [{"id": "sub_a", "tag": "sub_a", "from_ts": 1.0, "to_ts": 2.0, "shift_sec": 1}],
    "moved": 1,
    "max_shift_sec": 1,
    "total": 2,
    "skipped": 0,
    "reason": "",
}


@pytest.fixture()
def xray_client(monkeypatch, tmp_path):
    from routes import xray_subscriptions as routes

    calls: list[str] = []
    monkeypatch.setattr(routes, "plan_schedule_alignment", lambda _dir: calls.append("plan") or dict(PLAN))
    monkeypatch.setattr(routes, "apply_schedule_alignment", lambda _dir: calls.append("apply") or dict(PLAN))

    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(
        routes.create_xray_subscriptions_blueprint(
            ui_state_dir=str(tmp_path),
            xray_configs_dir=str(tmp_path),
            restart_xkeen=lambda **_kwargs: True,
            snapshot_xray_config_before_overwrite=lambda _path: None,
        )
    )
    return app.test_client(), calls


@pytest.fixture()
def mihomo_client(monkeypatch, tmp_path):
    from routes import mihomo as routes

    calls: list[str] = []
    monkeypatch.setattr(routes, "_mh_sub_plan_schedule_alignment", lambda _dir: calls.append("plan") or dict(PLAN))
    monkeypatch.setattr(routes, "_mh_sub_apply_schedule_alignment", lambda _dir: calls.append("apply") or dict(PLAN))

    config = tmp_path / "config.yaml"
    config.write_text("proxies: []\n", encoding="utf-8")
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(
        routes.create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(config),
            MIHOMO_TEMPLATES_DIR=str(tmp_path),
            MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "default.yaml"),
            restart_xkeen=lambda: None,
            ui_state_dir=str(tmp_path),
        )
    )
    return app.test_client(), calls


def test_xray_align_writes_the_state(xray_client):
    http, calls = xray_client

    response = http.post("/api/xray/subscriptions/align-schedule")

    assert response.status_code == 200
    assert calls == ["apply"]
    body = response.get_json()
    assert body["ok"] is True
    assert body["anchor_ts"] == PLAN["anchor_ts"]
    assert body["moved"] == 1
    assert body["moves"][0]["id"] == "sub_a"


def test_xray_align_dry_run_only_counts(xray_client):
    http, calls = xray_client

    response = http.post("/api/xray/subscriptions/align-schedule?dry=1")

    assert response.status_code == 200
    assert calls == ["plan"]
    assert response.get_json()["ok"] is True


def test_mihomo_align_writes_the_state(mihomo_client):
    http, calls = mihomo_client

    response = http.post("/api/mihomo/subscriptions/align-schedule")

    assert response.status_code == 200
    assert calls == ["apply"]
    assert response.get_json()["anchor_ts"] == PLAN["anchor_ts"]


def test_mihomo_align_dry_run_only_counts(mihomo_client):
    http, calls = mihomo_client

    response = http.post("/api/mihomo/subscriptions/align-schedule?dry=1")

    assert response.status_code == 200
    assert calls == ["plan"]


def test_align_failure_answers_with_an_error_payload(monkeypatch, tmp_path):
    """Сорвавшееся выравнивание не должно выглядеть как успешное."""
    from routes import xray_subscriptions as routes

    def _boom(_dir):
        raise OSError("state file is read-only")

    monkeypatch.setattr(routes, "apply_schedule_alignment", _boom)

    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(
        routes.create_xray_subscriptions_blueprint(
            ui_state_dir=str(tmp_path),
            xray_configs_dir=str(tmp_path),
            restart_xkeen=lambda **_kwargs: True,
            snapshot_xray_config_before_overwrite=lambda _path: None,
        )
    )

    response = app.test_client().post("/api/xray/subscriptions/align-schedule")

    assert response.status_code == 500
    assert response.get_json()["ok"] is False
